import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

import { ompModelRoleOverrides, type OmpSettings } from "../settings.ts";

const ROLE_COMMAND_TIMEOUT_MS = 10_000;
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class OmpModelRolesError extends Schema.TaggedError<OmpModelRolesError>()(
  "OmpModelRolesError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `omp model roles: ${this.detail}`;
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

// `omp config` owns config.yml's format, so roles go through it rather than a YAML rewrite here.
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
      duration: ROLE_COMMAND_TIMEOUT_MS,
      orElse: () => Effect.fail(new OmpModelRolesError({ detail: "omp config timed out" })),
    }),
  );
  if (result.code !== 0) {
    return yield* new OmpModelRolesError({
      detail: `omp config ${args[0]} exited with code ${result.code}`,
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
