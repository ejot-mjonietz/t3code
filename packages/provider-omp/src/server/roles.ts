import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

import { ompModelRoleOverrides, type OmpSettings } from "../settings.ts";

const CONFIG_COMMAND_TIMEOUT_MS = 10_000;
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class OmpConfigError extends Schema.TaggedError<OmpConfigError>()("OmpConfigError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `omp config: ${this.detail}`;
  }
}

function readRoleRecord(value: unknown): Record<string, string> {
  if (!Predicate.isObject(value)) return {};
  const roles: Record<string, string> = {};
  for (const [role, model] of Object.entries(value)) {
    if (typeof model === "string" && model.trim().length > 0) roles[role] = model.trim();
  }
  return roles;
}

// `omp config` owns config.yml's format and layering, so settings go through it rather than a
// YAML reader or rewrite here.
const runOmpConfig = Effect.fn("runOmpConfig")(function* (
  settings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
  args: ReadonlyArray<string>,
) {
  const command = settings.binaryPath || "omp";
  const spawnCommand = yield* resolveSpawnCommand(command, ["config", ...args], {
    env: environment,
  });
  const result = yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      ...(cwd === undefined ? {} : { cwd }),
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: CONFIG_COMMAND_TIMEOUT_MS,
      orElse: () => Effect.fail(new OmpConfigError({ detail: "timed out" })),
    }),
  );
  if (result.code !== 0) {
    return yield* new OmpConfigError({
      detail: `${args[0]} exited with code ${result.code}`,
    });
  }
  return result.stdout;
});

/** The model roles omp resolves from its config (`omp config get modelRoles`). */
export const readOmpModelRoles = Effect.fn("readOmpModelRoles")(function* (
  settings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const stdout = yield* runOmpConfig(settings, environment, cwd, ["get", "modelRoles", "--json"]);
  const parsed = Option.getOrUndefined(decodeJson(stdout.trim()));
  return readRoleRecord(Predicate.isObject(parsed) ? parsed["value"] : undefined);
});

/** Expands `omp config list --json` (`{ "a.b": { value } }`) into config.yml's nested layout. */
function nestConfigList(list: unknown): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (!Predicate.isObject(list)) return config;
  for (const [path, entry] of Object.entries(list)) {
    // Redacted credentials carry no `value`.
    if (!Predicate.isObject(entry) || !("value" in entry)) continue;
    const segments = path.split(".");
    const leaf = segments.pop();
    if (leaf === undefined) continue;
    let parent = config;
    for (const segment of segments) {
      const child = parent[segment];
      const next: Record<string, unknown> = Predicate.isObject(child) ? child : {};
      parent[segment] = next;
      parent = next;
    }
    parent[leaf] = entry["value"];
  }
  return config;
}

/** omp's resolved settings (`omp config list --json`), nested as config.yml stores them. */
export const readOmpConfig = Effect.fn("readOmpConfig")(function* (
  settings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const stdout = yield* runOmpConfig(settings, environment, cwd, ["list", "--json"]);
  return nestConfigList(Option.getOrUndefined(decodeJson(stdout.trim())));
});

const sameRoles = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) => {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
};

/**
 * Writes the role overrides T3 Code's settings hold into omp's config.yml. Only a change to those
 * settings writes: `stateFile` remembers what T3 last wrote, so roles the user later edits in omp
 * survive restarts. Cleared settings leave omp's value alone.
 */
export const syncOmpModelRolesToConfig = Effect.fn("syncOmpModelRolesToConfig")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  stateFile: string,
  cwd?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const overrides = ompModelRoleOverrides(settings);
  const previous = readRoleRecord(
    Option.getOrUndefined(
      decodeJson(
        yield* fileSystem.readFileString(stateFile).pipe(Effect.orElseSucceed(() => "{}")),
      ),
    ),
  );
  if (sameRoles(overrides, previous)) return false;
  const current = yield* readOmpModelRoles(settings, environment, cwd);
  const next = { ...current, ...overrides };
  if (!sameRoles(next, current)) {
    yield* runOmpConfig(settings, environment, cwd, ["set", "modelRoles", encodeJson(next)]);
  }
  yield* fileSystem.writeFileString(stateFile, encodeJson(overrides));
  return true;
});
