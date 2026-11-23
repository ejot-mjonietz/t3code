import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  ProviderDriverKind,
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  brokenVersionDetail,
  noCompatibilityPolicy,
  type ProviderCompatibilityLookup,
} from "@t3tools/provider-core/server/compatibility";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  providerModelsFromSettings,
  providerProbeEnvironment,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { ompModelRoleOverrides, type OmpSettings } from "../settings.ts";
import {
  EMPTY_OMP_MODEL_CAPABILITIES,
  ompModelCapabilities,
  parseOmpModelSelector,
} from "./modelCapabilities.ts";
import { parseOmpAvailableCommands } from "./commands.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./launch.ts";
import { makeOmpRpcConnection, OmpRpcError, OmpRpcTimeoutError } from "./rpc.ts";
import { readOmpModelRoles } from "./roles.ts";

const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MODELS_PROBE_TIMEOUT_MS = 20_000;
const OMP_RPC_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_MODEL_LIST_BYTES = 16 * 1024 * 1024;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Slug for omp's configured default model. Never sent to omp. */
const OMP_DEFAULT_MODEL_SLUG = "default";
/** Model picker entries that follow one of omp's model roles. */
const OMP_ROLE_MODEL_PREFIX = "role:";
// Chat roles worth running a thread on; the rest (commit, task, ...) serve omp itself.
const OMP_PICKER_ROLES = [
  { role: "smol", label: "Fast" },
  { role: "slow", label: "Thinking" },
  { role: "plan", label: "Architect" },
] as const;

function shortModelName(selector: string, models: ReadonlyArray<ServerProviderModel>): string {
  const { model, thinking } = parseOmpModelSelector(selector);
  const name = models.find((candidate) => candidate.slug === model)?.name ?? model;
  return thinking === undefined ? name : `${name} · ${thinking}`;
}

/** The roles omp resolves, with this instance's overrides on top when they stay out of config.yml. */
function effectiveOmpModelRoles(
  settings: OmpSettings,
  configured: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return { ...configured, ...ompModelRoleOverrides(settings) };
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  roles: Readonly<Record<string, string>>,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  const defaultRole = roles["default"];
  const defaultEntry: ServerProviderModel = {
    slug: OMP_DEFAULT_MODEL_SLUG,
    name:
      defaultRole === undefined
        ? "omp default"
        : `omp default (${shortModelName(defaultRole, discovered)})`,
    isCustom: false,
    capabilities:
      discovered.find((model) => model.slug === parseOmpModelSelector(defaultRole ?? "").model)
        ?.capabilities ?? EMPTY_OMP_MODEL_CAPABILITIES,
  };
  const roleEntries = OMP_PICKER_ROLES.flatMap(({ role, label }): Array<ServerProviderModel> => {
    const selector = roles[role];
    if (selector === undefined) return [];
    const target = discovered.find((model) => model.slug === parseOmpModelSelector(selector).model);
    return [
      {
        slug: `${OMP_ROLE_MODEL_PREFIX}${role}`,
        name: `omp ${label} (${shortModelName(selector, discovered)})`,
        isCustom: false,
        capabilities: target?.capabilities ?? EMPTY_OMP_MODEL_CAPABILITIES,
      },
    ];
  });
  return providerModelsFromSettings(
    [defaultEntry, ...roleEntries, ...discovered],
    customModels ?? [],
    EMPTY_OMP_MODEL_CAPABILITIES,
  );
}

/** `omp models --json` lists models of authenticated providers without opening a session. */
export function parseOmpModelList(
  stdout: string,
  defaultThinking: string | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  const parsed = Option.getOrUndefined(decodeJson(stdout.trim()));
  const models = Predicate.isObject(parsed) ? parsed["models"] : undefined;
  if (!Array.isArray(models)) return undefined;
  const seen = new Set<string>();
  const result: Array<ServerProviderModel> = [];
  for (const model of models) {
    if (!Predicate.isObject(model)) continue;
    const kind = model["kind"];
    if (kind !== undefined && kind !== "chat") continue;
    const provider = model["provider"];
    const id = model["id"];
    if (typeof provider !== "string" || typeof id !== "string") continue;
    if (provider.trim() === "" || id.trim() === "") continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = model["name"];
    result.push({
      slug,
      name: typeof name === "string" && name.trim() !== "" ? name : slug,
      subProvider: provider,
      isCustom: false,
      capabilities: ompModelCapabilities(model, defaultThinking),
    });
  }
  return result;
}

const runOmpCommand = Effect.fn("OmpProviderStatus.runOmpCommand")(function* (
  settings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const command = settings.binaryPath || "omp";
  const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      ...(cwd === undefined ? {} : { cwd }),
    }),
    { maxStdoutBytes: MAX_MODEL_LIST_BYTES },
  );
});

const runOmpVersionCommand = (
  settings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) => runOmpCommand(settings, environment, ["--version"], cwd);

export const discoverOmpCommandsForCwd = Effect.fn("discoverOmpCommandsForCwd")(
  function* (settings: OmpSettings, environment: NodeJS.ProcessEnv, cwd: string) {
    const launchArgs = resolveOmpLaunchArgs(settings.launchArgs);
    if (!launchArgs.ok) {
      return yield* new OmpRpcError({ operation: "launch", detail: launchArgs.message });
    }
    const launch = buildOmpRpcLaunch({
      launchArgs: launchArgs.args,
      environment: providerProbeEnvironment(environment),
      ephemeral: true,
    });
    const connection = yield* makeOmpRpcConnection({
      command: settings.binaryPath || "omp",
      args: launch.args,
      cwd,
      env: launch.env,
    });
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    // A failed read must not replace a previously usable workspace catalog with an empty one.
    const commandsData = yield* connection.request(
      { type: "get_available_commands" },
      resolveProviderProbeTimeoutMs("omp", OMP_RPC_DISCOVERY_TIMEOUT_MS, environment),
    );
    return parseOmpAvailableCommands(commandsData);
  },
  Effect.scoped,
  (effect, _settings, environment) => {
    const timeoutMs = resolveProviderProbeTimeoutMs(
      "omp",
      OMP_RPC_DISCOVERY_TIMEOUT_MS,
      environment,
    );
    return effect.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new OmpRpcTimeoutError({ operation: "discovery", timeoutMs })),
      }),
    );
  },
);

function snapshot(
  settings: OmpSettings,
  checkedAt: string,
  models: ReadonlyArray<ServerProviderModel>,
  probe: Parameters<typeof buildServerProvider>[0]["probe"],
): ServerProviderDraft {
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe,
  });
}

export const buildInitialOmpProviderSnapshot = Effect.fn(
  "OmpProviderStatus.buildInitialOmpProviderSnapshot",
)(function* (settings: OmpSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = ompModelsFromSettings(settings.customModels, ompModelRoleOverrides(settings));
  return snapshot(
    settings,
    checkedAt,
    models,
    settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking omp availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Oh My Pi is disabled in T3 Code settings.",
        },
  );
});

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  compatibility: ProviderCompatibilityLookup = noCompatibilityPolicy,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(
    settings.customModels,
    ompModelRoleOverrides(settings),
  );

  if (!settings.enabled) {
    return snapshot(settings, checkedAt, fallbackModels, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Oh My Pi is disabled in T3 Code settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runOmpVersionCommand(settings, probeEnvironment, cwd).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("omp", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("omp health check failed.", { errorTag: error._tag });
    return snapshot(settings, checkedAt, fallbackModels, {
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? "omp is not installed or not on PATH. Install it with `bun install -g @oh-my-pi/pi-coding-agent`, or set its binary path."
        : "Failed to run the omp health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot(settings, checkedAt, fallbackModels, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "omp is installed but timed out while running `omp --version`.",
    });
  }
  const version = parseCliVersionResult(versionResult.success.value);
  if (version === null) {
    return snapshot(settings, checkedAt, fallbackModels, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "T3 Code could not determine the omp version. Update omp, then refresh its status.",
    });
  }
  const broken = brokenVersionDetail({
    name: "omp",
    version,
    advisory: yield* compatibility(OMP_DRIVER_KIND, version),
  });
  if (broken !== undefined) {
    return snapshot(settings, checkedAt, fallbackModels, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: broken,
    });
  }
  const resolvedLaunchArgs = resolveOmpLaunchArgs(settings.launchArgs);
  if (!resolvedLaunchArgs.ok) {
    return snapshot(settings, checkedAt, fallbackModels, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: resolvedLaunchArgs.message,
    });
  }

  const timeoutMs = resolveProviderProbeTimeoutMs("omp", MODELS_PROBE_TIMEOUT_MS, environment);
  const [rolesResult, modelsResult] = yield* Effect.all(
    [
      readOmpModelRoles(settings, probeEnvironment, cwd).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map(Option.getOrElse((): Readonly<Record<string, string>> => ({}))),
        Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
      ),
      runOmpCommand(settings, probeEnvironment, ["models", "--json"], cwd).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.result,
      ),
    ],
    { concurrency: "unbounded" },
  );
  const roles = effectiveOmpModelRoles(settings, rolesResult);
  const defaultThinking =
    roles["default"] === undefined ? undefined : parseOmpModelSelector(roles["default"]).thinking;
  const discovered =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? parseOmpModelList(modelsResult.success.value.stdout, defaultThinking)
      : undefined;
  if (discovered === undefined) {
    if (Result.isFailure(modelsResult)) {
      yield* Effect.logWarning("omp model discovery failed.", {
        errorTag: modelsResult.failure._tag,
      });
    }
    return snapshot(settings, checkedAt, ompModelsFromSettings(settings.customModels, roles), {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "omp is available, but T3 Code could not list its models. The live session will retry.",
    });
  }
  const authenticated = discovered.length > 0;
  return snapshot(
    settings,
    checkedAt,
    ompModelsFromSettings(settings.customModels, roles, discovered),
    {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unauthenticated", type: "omp" },
      ...(authenticated
        ? {}
        : {
            message:
              "omp has no usable models. Run `omp` in a terminal and use /login, or configure an API key.",
          }),
    },
  );
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("omp version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
