import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
  type UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { OmpSettings } from "../settings.ts";
import { OMP_ARGUMENTS_WITH_VALUES, resolveOmpLaunchArgs } from "./launch.ts";

const OmpScanState = Schema.Struct({
  /** omp opens every transcript with its title slot; Pi, which shares its variables, never does. */
  omp: Schema.mutableKey(Schema.Boolean),
  sessionId: Schema.mutableKey(Schema.String),
  /** Root session in `parentSession`, adopted once `session_init` marks the file a subagent's. */
  rootSessionId: Schema.mutableKey(Schema.String),
});
type OmpScanState = typeof OmpScanState.Type;

const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
  orchestration: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Unknown),
      cacheRead: Schema.optional(Schema.Unknown),
      output: Schema.optional(Schema.Unknown),
    }),
  ),
  cttl: Schema.optional(Schema.Struct({ ephemeral1h: Schema.optional(Schema.Unknown) })),
  cost: Schema.optional(Schema.Struct({ total: Schema.optional(Schema.Unknown) })),
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.String };
const Model = { provider: Schema.NonEmptyString, model: Schema.NonEmptyString };
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("title") }),
  Schema.Struct({
    type: Schema.Literal("session"),
    id: Schema.NonEmptyString,
    parentSession: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("session_init") }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Struct({
      ...Model,
      role: Schema.Literal("assistant"),
      serviceTier: Schema.optional(Schema.Unknown),
      usage: Usage,
    }),
  }),
  // Model calls outside the conversation: titles, job captions, compaction, cache warming.
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("model_usage"), usage: Usage }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

// omp names a session file `<file-safe ISO time>_<session id>.jsonl` and keeps its subagents'
// transcripts in a directory of the same name without `.jsonl`.
const SESSION_FILE_SEGMENT = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+?)(?:\.jsonl)?$/;

function rootSessionId(parentSession: unknown): string {
  if (typeof parentSession !== "string") return "";
  for (const segment of parentSession.split(/[\\/]/)) {
    const id = SESSION_FILE_SEGMENT.exec(segment)?.[1];
    if (id !== undefined) return id;
  }
  return "";
}

function ompSpeed(serviceTier: unknown): UsageSpeed {
  // omp sends Anthropic fast mode and OpenAI priority processing as the `priority` tier.
  if (serviceTier === "priority") return "fast";
  if (serviceTier === "ultrafast") return "ultrafast";
  return "standard";
}

function parseRecord(parsed: unknown, state: OmpScanState): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  switch (entry.type) {
    case "title":
      state.omp = true;
      return [];
    case "session":
      state.sessionId = entry.id;
      state.rootSessionId = rootSessionId(entry.parentSession);
      return [];
    case "session_init":
      // Subagent usage belongs to the session the user started, as with Claude Code sidechains.
      if (state.rootSessionId.length > 0) state.sessionId = state.rootSessionId;
      return [];
  }
  if (!state.omp) return [];
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const { usage } = source;
  // Provider-side orchestration is billed outside the conversation buckets but counts the same way.
  const orchestration = usage.orchestration;
  const outputTokens = tokenCount(usage.output) + tokenCount(orchestration?.output);
  const cacheCreationTokens = tokenCount(usage.cacheWrite);
  const totals = {
    // omp's input/cache counters are already disjoint.
    uncachedInputTokens: tokenCount(usage.input) + tokenCount(orchestration?.input),
    cachedInputTokens: tokenCount(usage.cacheRead) + tokenCount(orchestration?.cacheRead),
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
  const cacheCreation1hTokens = Math.min(cacheCreationTokens, tokenCount(usage.cttl?.ephemeral1h));
  const cost = usage.cost?.total;
  // A zero total is a free model or one omp has no rate for; shared estimates decide then.
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  const model = `${source.provider}/${source.model}`;
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      rateModel: source.model,
      sessionId: state.sessionId,
      totals,
      ...(cacheCreation1hTokens > 0 ? { cacheCreation1hTokens } : {}),
      reportedCostUsd,
      speed: entry.type === "message" ? ompSpeed(entry.message.serviceTier) : "standard",
      // Forks and continuations copy entries with their IDs and timestamps; IDs are short.
      dedupeKey: JSON.stringify(["omp", entry.id, entry.timestamp, model]),
    },
  ];
}

export const ompUsageFormat: TranscriptUsageFormat<OmpScanState> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    parentSession: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, serviceTier: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"', '"session_init"', '{"type":"title"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: {
    initial: () => ({ omp: false, sessionId: "", rootSessionId: "" }),
    schema: OmpScanState,
  },
};

export type OmpUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const ompUsageReader: ProviderUsageReader<OmpSettings, OmpUsageReaderEnv> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  // omp model IDs are `<provider>/<rate model>`.
  rateModel: (model) => model.slice(model.indexOf("/") + 1),
  directories: Effect.fn("ompUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const hostHome = yield* HostProcess.HomeDirectory;
    const hostEnvironment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    // omp resolves `~` with os.homedir(): HOME, or USERPROFILE on Windows.
    const home = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || hostHome;
    const environmentProfile = ompProfile(environment.OMP_PROFILE ?? environment.PI_PROFILE);
    const candidates: OmpSessionsDir[] = [];
    // --session-dir and --profile move only T3-launched sessions; terminal sessions stay put.
    const launch = config === undefined ? undefined : ompLaunchSessionOptions(config.launchArgs);
    if (launch?.sessionDir !== undefined) {
      // A relative directory depends on each project's cwd, which Usage cannot enumerate.
      const dir = expandHomePath(launch.sessionDir, home);
      if (path.isAbsolute(dir)) candidates.push({ dir: path.resolve(dir) });
    } else if (launch?.profile !== undefined) {
      candidates.push(
        yield* ompSessionsDir(environment, home, platform, ompProfile(launch.profile)),
      );
    }
    candidates.push(yield* ompSessionsDir(environment, home, platform, environmentProfile));
    const dirs = new Set<string>();
    for (const { dir, piVariable } of candidates) {
      // Pi's default account reads the same variable from the host environment. The scan cache
      // keeps one provider's reading per file, so that directory stays Pi's source.
      if (
        piVariable !== undefined &&
        hostEnvironment[piVariable]?.trim() === environment[piVariable]?.trim()
      ) {
        continue;
      }
      dirs.add(dir);
    }
    return [...dirs].map((dir) => ({ dir }));
  }),
};

interface OmpLaunchSessionOptions {
  readonly sessionDir?: string;
  /** Raw `--profile` value; "default" or empty picks the default profile over the environment's. */
  readonly profile?: string;
}

function ompLaunchSessionOptions(launchArgs: string): OmpLaunchSessionOptions | undefined {
  const resolved = resolveOmpLaunchArgs(launchArgs);
  if (!resolved.ok) return undefined;
  let sessionDir: string | undefined;
  let profile: string | undefined;
  for (let index = 0; index < resolved.args.length; index += 1) {
    const arg = resolved.args[index];
    if (arg === undefined) continue;
    // omp also accepts `--flag=value` for any value flag.
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (!OMP_ARGUMENTS_WITH_VALUES.has(flag)) continue;
    let value: string | undefined;
    if (equals === -1) {
      index += 1;
      value = resolved.args[index];
    } else {
      value = arg.slice(equals + 1);
    }
    if (flag === "--session-dir") sessionDir = value || undefined;
    else if (flag === "--profile") profile = value ?? "";
  }
  return {
    ...(sessionDir === undefined ? {} : { sessionDir }),
    ...(profile === undefined ? {} : { profile }),
  };
}

const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** omp's profile name, or undefined for the default profile; omp refuses invalid names. */
function ompProfile(value: string | undefined): string | undefined {
  const profile = value?.trim();
  if (!profile || profile === "default") return undefined;
  return OMP_PROFILE_NAME.test(profile) && !profile.endsWith(".") ? profile : undefined;
}

interface OmpSessionsDir {
  readonly dir: string;
  /** The variable omp shares with Pi that placed `dir`, if any. */
  readonly piVariable?: "PI_CODING_AGENT_SESSION_DIR" | "PI_CODING_AGENT_DIR";
}

/** Where omp writes session files for `profile`, like pi-utils' DirResolver and `--session-dir`. */
const ompSessionsDir = Effect.fnUntraced(function* (
  environment: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  profile: string | undefined,
): Effect.fn.Return<OmpSessionsDir, never, OmpUsageReaderEnv> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) {
    return {
      dir: path.resolve(expandHomePath(sessionDir, home)),
      piVariable: "PI_CODING_AGENT_SESSION_DIR",
    };
  }
  const configRoot = path.join(home, environment.PI_CONFIG_DIR || ".omp");
  const profileRoot =
    profile === undefined ? configRoot : path.join(configRoot, "profiles", profile);
  const defaultAgentDir = path.join(profileRoot, "agent");
  // Named profiles always use their own agent directory.
  const agentDirOverride = profile === undefined ? environment.PI_CODING_AGENT_DIR : undefined;
  const agentDir = agentDirOverride
    ? path.resolve(expandHomePath(agentDirOverride, home))
    : defaultAgentDir;
  const dataHome = environment.XDG_DATA_HOME;
  // `omp config init-xdg` moves default-location state under $XDG_DATA_HOME/omp on Linux and macOS.
  if (dataHome && agentDir === defaultAgentDir && (platform === "linux" || platform === "darwin")) {
    const appRoot = path.join(dataHome, "omp");
    const xdgRoot = profile === undefined ? appRoot : path.join(appRoot, "profiles", profile);
    const migrated = yield* fileSystem.exists(xdgRoot).pipe(Effect.orElseSucceed(() => false));
    if (migrated) return { dir: path.join(xdgRoot, "sessions") };
  }
  return {
    dir: path.join(agentDir, "sessions"),
    ...(agentDirOverride ? { piVariable: "PI_CODING_AGENT_DIR" as const } : {}),
  };
});
