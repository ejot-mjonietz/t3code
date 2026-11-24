import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { SelectedFields } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { OmpSettings } from "../settings.ts";
import { ompUsageFormat, ompUsageReader } from "./usage.ts";

const stateSchema = ompUsageFormat.state?.schema;
const stateCodec =
  stateSchema === undefined
    ? undefined
    : { decode: Schema.decodeUnknownSync(stateSchema), encode: Schema.encodeSync(stateSchema) };

const ROOT_ID = "01a20a93-dec1-7777-beaa-32ba7b7098e9";
const ROOT_FILE = `/home/u/.omp/agent/sessions/-repo/2026-11-23T22-43-12-705Z_${ROOT_ID}.jsonl`;

const titleSlot = {
  type: "title",
  v: 1,
  title: "Native omp support",
  source: "user",
  updatedAt: "2026-11-24T00:11:13.311Z",
  pad: "    ",
};
const header = (id: string, parentSession?: string) => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-11-23T22:43:12.705Z",
  cwd: "/repo",
  ...(parentSession === undefined ? {} : { parentSession }),
});
const sessionInit = {
  type: "session_init",
  id: "909aee22",
  parentId: "4388dd8e",
  timestamp: "2026-11-23T23:13:05.358Z",
  systemPrompt: ["You are a scout."],
  task: "Audit the ask tool.",
  tools: ["read", "grep"],
  agent: "scout",
};
const assistant = (overrides?: {
  readonly id?: string;
  readonly timestamp?: string;
  readonly usage?: unknown;
  readonly serviceTier?: string;
}) => ({
  type: "message",
  id: overrides?.id ?? "c784877e",
  parentId: "24906367",
  timestamp: overrides?.timestamp ?? "2026-11-23T22:43:18.027Z",
  runtime: { version: "19.1.1" },
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Reading the reader." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5",
    usage: overrides?.usage ?? {
      input: 4,
      output: 288,
      cacheRead: 1_000,
      cacheWrite: 22_292,
      totalTokens: 23_584,
      reasoningTokens: 100,
      cost: {
        input: 0.00002,
        output: 0.00576,
        cacheRead: 0.0005,
        cacheWrite: 0.11146,
        total: 0.1177,
      },
      premiumRequests: 1,
      cttl: { ephemeral5m: 20_000, ephemeral1h: 2_292 },
    },
    ...(overrides?.serviceTier === undefined ? {} : { serviceTier: overrides.serviceTier }),
    stopReason: "toolUse",
    timestamp: 1_795_473_793_929,
  },
});
const modelUsage = {
  type: "model_usage",
  id: "74bb3f93",
  parentId: "c784877e",
  timestamp: "2026-11-23T23:02:13.675Z",
  runtime: { version: "19.1.1" },
  purpose: "job-caption",
  api: "openai-responses",
  provider: "github-copilot",
  model: "gpt-6.1-sol",
  usage: {
    input: 388,
    output: 112,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 500,
    reasoningTokens: 88,
    cost: { input: 0.000776, output: 0.00112, cacheRead: 0, cacheWrite: 0, total: 0.001896 },
    premiumRequests: 1,
  },
  stopReason: "stop",
  completion: { prompt: "<job>", reply: "Running tests" },
};
// Tool results can embed whole usage objects (eval views, task summaries) that are not billed calls.
const toolResultWithUsage = {
  type: "message",
  id: "e1f2a3b4",
  parentId: "c784877e",
  timestamp: "2026-11-23T22:44:00.000Z",
  message: {
    role: "toolResult",
    toolCallId: "toolu_1",
    toolName: "task",
    content: [{ type: "text", text: "done" }],
    details: {
      results: [{ id: "Scout", usage: { input: 9_999, output: 9_999, cost: { total: 99 } } }],
    },
    usage: { input: 9_999, output: 9_999, cost: { total: 99 } },
  },
};

function freshState() {
  const state = ompUsageFormat.state;
  if (state === undefined) throw new Error("Expected a stateful omp usage format");
  return state.initial();
}

function parseLines(lines: ReadonlyArray<unknown>) {
  const state = freshState();
  return lines.flatMap((line) =>
    ompUsageFormat.parseLine(typeof line === "string" ? line : JSON.stringify(line), state),
  );
}

/** Keeps only the fields the format selects, as the streaming reader does for long lines. */
function project(value: unknown, fields: SelectedFields): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, selection] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) continue;
    const child = (value as Record<string, unknown>)[key];
    projected[key] = selection === true ? child : project(child, selection);
  }
  return projected;
}

describe("ompUsageFormat", () => {
  it("maps assistant turns and model_usage calls, skipping tool results and malformed lines", () => {
    const records = parseLines([
      titleSlot,
      header(ROOT_ID),
      {
        type: "model_change",
        id: "2eb40506",
        parentId: null,
        timestamp: "2026-11-23T22:43:13.002Z",
        model: "anthropic/claude-opus-5",
      },
      assistant({ serviceTier: "priority" }),
      toolResultWithUsage,
      modelUsage,
      '{"type":"message","id":"cut","usage":',
      'not json but mentions "usage"',
      assistant({ id: "badusage", usage: "lots" }),
      // An aborted turn with no tokens and no cost bills nothing.
      assistant({
        id: "aborted0",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { total: 0 },
        },
      }),
      assistant({ id: "badtime", timestamp: "yesterday" }),
    ]);

    expect(records).toEqual([
      {
        provider: "omp",
        timestampMs: Date.parse("2026-11-23T22:43:18.027Z"),
        model: "anthropic/claude-opus-5",
        rateModel: "claude-opus-5",
        sessionId: ROOT_ID,
        totals: {
          uncachedInputTokens: 4,
          cachedInputTokens: 1_000,
          cacheCreationTokens: 22_292,
          outputTokens: 288,
          reasoningTokens: 100,
        },
        cacheCreation1hTokens: 2_292,
        reportedCostUsd: 0.1177,
        speed: "fast",
        dedupeKey: JSON.stringify([
          "omp",
          "c784877e",
          "2026-11-23T22:43:18.027Z",
          "anthropic/claude-opus-5",
        ]),
      },
      {
        provider: "omp",
        timestampMs: Date.parse("2026-11-23T23:02:13.675Z"),
        model: "github-copilot/gpt-6.1-sol",
        rateModel: "gpt-6.1-sol",
        sessionId: ROOT_ID,
        totals: {
          uncachedInputTokens: 388,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 112,
          reasoningTokens: 88,
        },
        reportedCostUsd: 0.001896,
        speed: "standard",
        dedupeKey: JSON.stringify([
          "omp",
          "74bb3f93",
          "2026-11-23T23:02:13.675Z",
          "github-copilot/gpt-6.1-sol",
        ]),
      },
    ]);
  });

  it("leaves unpriced calls to shared estimates and counts orchestration tokens", () => {
    const [record] = parseLines([
      titleSlot,
      header(ROOT_ID),
      assistant({
        serviceTier: "ultrafast",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 0,
          totalTokens: 78,
          reasoningTokens: 500,
          orchestration: { input: 5, cacheRead: 7, output: 6 },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    ]);
    expect(record?.reportedCostUsd).toBeNull();
    expect(record?.speed).toBe("ultrafast");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 15,
      cachedInputTokens: 37,
      cacheCreationTokens: 0,
      outputTokens: 26,
      reasoningTokens: 26,
    });
    expect(record).not.toHaveProperty("cacheCreation1hTokens");
  });

  it("attributes subagent transcripts, including nested ones, to the root session", () => {
    const subagent = (parentSession: string) =>
      parseLines([
        { ...titleSlot, title: "" },
        header("01a20aaf-38f1-77ed-a82a-df6b2798a752", parentSession),
        { type: "model_change", id: "007c31cd", parentId: null, model: "anthropic/claude-opus-5" },
        sessionInit,
        assistant({ id: "5ab0c1d2" }),
      ]).map((record) => record.sessionId);

    expect(subagent(ROOT_FILE)).toEqual([ROOT_ID]);
    expect(subagent(ROOT_FILE.replace(/\.jsonl$/, "/DocsWebsite3.jsonl"))).toEqual([ROOT_ID]);
    expect(
      subagent(
        `C:\\Users\\u\\.omp\\agent\\sessions\\-repo\\2026-11-23T22-43-12-705Z_${ROOT_ID}.jsonl`,
      ),
    ).toEqual([ROOT_ID]);
    // `/new` links the previous file too, but without session_init the session is its own.
    expect(
      parseLines([
        titleSlot,
        header("01a20b00-0000-7000-8000-000000000000", ROOT_FILE),
        assistant(),
      ]).map((record) => record.sessionId),
    ).toEqual(["01a20b00-0000-7000-8000-000000000000"]);
  });

  it("keys fork copies alike so usage counts once across files", () => {
    const [original] = parseLines([titleSlot, header(ROOT_ID), assistant()]);
    const [copy] = parseLines([
      titleSlot,
      header("01a20b11-0000-7000-8000-000000000000", ROOT_ID),
      assistant(),
    ]);
    expect(copy?.sessionId).not.toBe(original?.sessionId);
    expect(copy?.dedupeKey).toBe(original?.dedupeKey);
  });

  it("ignores Pi transcripts sharing PI_CODING_AGENT_DIR", () => {
    expect(parseLines([header("pi-session"), assistant(), modelUsage])).toEqual([]);
  });

  it("parses projected long lines like whole lines, and every relevant line passes the marker gate", () => {
    const lines = [titleSlot, header("sub", ROOT_FILE), sessionInit, assistant(), modelUsage];
    for (const line of lines) {
      const text = JSON.stringify(line);
      expect(ompUsageFormat.usageMarkers.some((marker) => text.includes(marker))).toBe(true);
    }
    const state = freshState();
    const projected = lines.flatMap((line) =>
      ompUsageFormat.parseProjected(project(line, ompUsageFormat.selectFields), state),
    );
    expect(projected).toEqual(parseLines(lines));
    expect(projected.map((record) => record.sessionId)).toEqual([ROOT_ID, ROOT_ID]);
  });

  it("resumes a grown file from the persisted state", () => {
    const state = freshState();
    for (const line of [titleSlot, header("sub", ROOT_FILE), sessionInit]) {
      ompUsageFormat.parseLine(JSON.stringify(line), state);
    }
    if (stateCodec === undefined) throw new Error("Expected a stateful omp usage format");
    const resumed = stateCodec.decode(stateCodec.encode(state));
    const [record] = ompUsageFormat.parseLine(JSON.stringify(assistant()), resumed);
    expect(record?.sessionId).toBe(ROOT_ID);
  });
});

const decodeSettings = Schema.decodeSync(OmpSettings);

const directoriesFor = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly launchArgs?: string;
  readonly invalidConfig?: true;
}) =>
  Effect.gen(function* () {
    if (ompUsageReader.kind !== "transcripts") throw new Error("Expected a transcript reader");
    const directories = yield* ompUsageReader.directories(
      {
        instanceId: ProviderInstanceId.make("omp"),
        configured: true,
        config: input.invalidConfig
          ? undefined
          : decodeSettings(input.launchArgs === undefined ? {} : { launchArgs: input.launchArgs }),
        environment: input.environment,
      },
      { awaitRefresh: true },
    );
    return directories.map(({ dir }) => dir);
  });

describe("ompUsageReader.directories", () => {
  const withHost = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
    platform: NodeJS.Platform = "linux",
    hostEnvironment: NodeJS.ProcessEnv = {},
  ) =>
    effect.pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/host-home"),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
      Effect.provideService(HostProcess.Platform, platform),
    );

  it.effect.each([
    [{ HOME: "/home/u" }, "/home/u/.omp/agent/sessions"],
    [{}, "/host-home/.omp/agent/sessions"],
    [{ HOME: "/home/u", PI_CODING_AGENT_DIR: "~/agent-x" }, "/home/u/agent-x/sessions"],
    [
      { HOME: "/home/u", PI_CODING_AGENT_DIR: "/a", PI_CODING_AGENT_SESSION_DIR: "~/omp-sessions" },
      "/home/u/omp-sessions",
    ],
    [{ HOME: "/home/u", PI_CONFIG_DIR: ".omp-dev" }, "/home/u/.omp-dev/agent/sessions"],
    [
      { HOME: "/home/u", OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/ignored" },
      "/home/u/.omp/profiles/work/agent/sessions",
    ],
    [{ HOME: "/home/u", PI_PROFILE: "work" }, "/home/u/.omp/profiles/work/agent/sessions"],
    // An explicitly empty OMP_PROFILE selects the default profile over PI_PROFILE.
    [{ HOME: "/home/u", OMP_PROFILE: "", PI_PROFILE: "work" }, "/home/u/.omp/agent/sessions"],
    [{ HOME: "/home/u", OMP_PROFILE: "Not Valid" }, "/home/u/.omp/agent/sessions"],
  ] as const)("resolves omp's sessions directory for %j", ([environment, expected]) =>
    withHost(
      Effect.gen(function* () {
        expect(yield* directoriesFor({ environment })).toEqual([expected]);
      }),
    ),
  );

  it.effect("reads the home omp uses on Windows", () =>
    withHost(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(
          yield* directoriesFor({ environment: { USERPROFILE: "C:\\Users\\u", HOME: "/ignored" } }),
        ).toEqual([path.join("C:\\Users\\u", ".omp", "agent", "sessions")]);
      }),
      "win32",
    ),
  );

  it.effect.each([
    [
      "--profile work",
      ["/home/u/.omp/profiles/work/agent/sessions", "/home/u/.omp/agent/sessions"],
    ],
    [
      "--profile=work",
      ["/home/u/.omp/profiles/work/agent/sessions", "/home/u/.omp/agent/sessions"],
    ],
    ["--session-dir ~/t3-sessions", ["/home/u/t3-sessions", "/home/u/.omp/agent/sessions"]],
    ["--session-dir=/srv/omp", ["/srv/omp", "/home/u/.omp/agent/sessions"]],
    ["--no-lsp --session-dir relative/dir", ["/home/u/.omp/agent/sessions"]],
    // `--profile` here is the system prompt's value, not a flag.
    ["--system-prompt --profile", ["/home/u/.omp/agent/sessions"]],
    ["--resume abc", ["/home/u/.omp/agent/sessions"]],
  ] as const)("adds T3-launched sessions moved by %s", ([launchArgs, expected]) =>
    withHost(
      Effect.gen(function* () {
        expect(yield* directoriesFor({ environment: { HOME: "/home/u" }, launchArgs })).toEqual(
          expected,
        );
      }),
    ),
  );

  it.effect("lets an explicit default profile override the environment's for T3 launches", () =>
    withHost(
      Effect.gen(function* () {
        expect(
          yield* directoriesFor({
            environment: { HOME: "/home/u", OMP_PROFILE: "work" },
            launchArgs: "--profile default",
          }),
        ).toEqual(["/home/u/.omp/agent/sessions", "/home/u/.omp/profiles/work/agent/sessions"]);
        expect(
          yield* directoriesFor({
            environment: { HOME: "/home/u" },
            launchArgs: "--profile work",
            invalidConfig: true,
          }),
        ).toEqual(["/home/u/.omp/agent/sessions"]);
      }),
    ),
  );

  it.effect("leaves directories Pi's default account reads through shared variables to Pi", () =>
    withHost(
      Effect.gen(function* () {
        const shared = { HOME: "/home/u", PI_CODING_AGENT_DIR: "/shared/agent" };
        expect(yield* directoriesFor({ environment: shared })).toEqual([]);
        expect(
          yield* directoriesFor({ environment: shared, launchArgs: "--session-dir /srv/omp" }),
        ).toEqual(["/srv/omp"]);
        expect(yield* directoriesFor({ environment: { ...shared, OMP_PROFILE: "work" } })).toEqual([
          "/home/u/.omp/profiles/work/agent/sessions",
        ]);
        // An account-level value differs from what Pi's default account reads.
        expect(
          yield* directoriesFor({ environment: { ...shared, PI_CODING_AGENT_DIR: "/omp/agent" } }),
        ).toEqual(["/omp/agent/sessions"]);
        expect(
          yield* directoriesFor({
            environment: { ...shared, OMP_PROFILE: "work", PI_CODING_AGENT_SESSION_DIR: "/s" },
          }),
        ).toEqual(["/s"]);
      }),
      "linux",
      { PI_CODING_AGENT_DIR: "/shared/agent" },
    ),
  );

  it.effect("follows `omp config init-xdg` only once the XDG data directory exists", () =>
    withHost(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-omp-xdg-" });
        const environment = { HOME: "/home/u", XDG_DATA_HOME: dataHome };

        expect(yield* directoriesFor({ environment })).toEqual(["/home/u/.omp/agent/sessions"]);
        yield* fileSystem.makeDirectory(path.join(dataHome, "omp"));
        expect(yield* directoriesFor({ environment })).toEqual([
          path.join(dataHome, "omp", "sessions"),
        ]);
        // An agent directory override and named profiles without their own XDG directory stay put.
        expect(
          yield* directoriesFor({ environment: { ...environment, PI_CODING_AGENT_DIR: "/a" } }),
        ).toEqual(["/a/sessions"]);
        expect(
          yield* directoriesFor({ environment: { ...environment, OMP_PROFILE: "work" } }),
        ).toEqual(["/home/u/.omp/profiles/work/agent/sessions"]);
        yield* fileSystem.makeDirectory(path.join(dataHome, "omp", "profiles", "work"), {
          recursive: true,
        });
        expect(
          yield* directoriesFor({ environment: { ...environment, OMP_PROFILE: "work" } }),
        ).toEqual([path.join(dataHome, "omp", "profiles", "work", "sessions")]);
      }),
    ),
  );

  it.effect("ignores XDG directories on Windows", () =>
    withHost(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-omp-xdg-win-" });
        yield* fileSystem.makeDirectory(path.join(dataHome, "omp"));
        expect(
          yield* directoriesFor({
            environment: { USERPROFILE: "/home/u", XDG_DATA_HOME: dataHome },
          }),
        ).toEqual(["/home/u/.omp/agent/sessions"]);
      }),
      "win32",
    ),
  );
});
