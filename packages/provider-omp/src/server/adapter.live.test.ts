// Live checks against the real omp binary; they spend model tokens, so they only run with T3_OMP_LIVE=1.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeOmpAdapterV2, type OmpAdapterV2Options } from "./adapter.ts";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { OmpSettings } from "../settings.ts";
import * as Schema from "effect/Schema";

const LIVE = process.env["T3_OMP_LIVE"] === "1";
const MODEL = process.env["T3_OMP_LIVE_MODEL"] ?? "github-copilot/gpt-6-luna";
const INSTANCE_ID = ProviderInstanceId.make("omp");

const layerLive = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const settings = Schema.decodeSync(OmpSettings)({
  taskModel: `${MODEL}:low`,
  smolModel: `${MODEL}:low`,
  saveModelRolesToOmpConfig: false,
});

const selection = (model = MODEL): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model,
  options: [{ id: "thinking", value: "low" }],
});

// A throwaway workspace. omp files sessions under ~/.omp/agent/sessions by cwd, so those go
// with it when the owning scope closes (not when a session inside it closes, or resume breaks).
const makeWorkspace = Effect.fnUntraced(function* (prefix = "t3-omp-live-") {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  yield* Effect.addFinalizer(() =>
    fileSystem
      .remove(`${process.env["HOME"]}/.omp/agent/sessions/${cwd.replaceAll("/", "-")}`, {
        recursive: true,
      })
      .pipe(Effect.ignore),
  );
  return cwd;
});

const openLive = Effect.fnUntraced(function* (
  runtimeMode: "full-access" | "approval-required",
  continuationRequests?: OmpAdapterV2Options["continuationRequests"],
  resume?: { readonly providerThread: OrchestrationV2ProviderThread },
  workspace?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = workspace ?? (yield* makeWorkspace());
  yield* fileSystem.writeFileString(`${cwd}/a.txt`, "hello from a.txt\n");
  const adapter = yield* makeOmpAdapterV2({
    instanceId: INSTANCE_ID,
    settings,
    environment: process.env,
    ...(continuationRequests === undefined ? {} : { continuationRequests }),
  });
  const threadId = ThreadId.make(`thread-omp-live-${runtimeMode}`);
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(
      `omp-live-${runtimeMode}-${resume ? "resumed" : "fresh"}`,
    ),
    modelSelection: selection(),
    runtimePolicy,
    ...(resume?.providerThread.nativeThreadRef?.nativeId == null
      ? {}
      : { initialNativeThreadId: resume.providerThread.nativeThreadRef.nativeId }),
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread =
    resume === undefined
      ? yield* runtime.ensureThread({ threadId, modelSelection: selection(), runtimePolicy })
      : yield* runtime.resumeThread({
          providerThread: resume.providerThread,
          threadId,
          modelSelection: selection(),
          runtimePolicy,
        });
  let ordinal = 0;
  const runTurn = Effect.fnUntraced(function* (
    thread: OrchestrationV2ProviderThread,
    text: string,
    onEvent: (
      event: ProviderAdapter.ProviderAdapterV2Event,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error, Scope.Scope> = () =>
      Effect.void,
    continuation = false,
    turnSelection: ModelSelection = selection(),
    resume = false,
  ) {
    ordinal += 1;
    const now = yield* DateTime.now;
    const runId = RunId.make(`run:${threadId}:${ordinal}`);
    const appThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: "project:omp-live" as OrchestrationV2AppThread["projectId"],
      title: "omp live",
      providerInstanceId: INSTANCE_ID,
      modelSelection: selection(),
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    } satisfies OrchestrationV2AppThread;
    const turn = {
      appThread,
      threadId,
      runId,
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
      rootNodeId: NodeId.make(`node:${runId}:root`),
      providerThread: thread,
      modelSelection: turnSelection,
      runtimePolicy,
    };
    const messageId = `message:${threadId}:${ordinal}` as never;
    if (resume) {
      assert.isDefined(runtime.resumeTurn);
      yield* runtime.resumeTurn!({ ...turn, messageId });
    } else {
      yield* runtime.startTurn({
        ...turn,
        message: {
          messageId,
          text,
          attachments: [],
          createdBy: continuation ? "agent" : "user",
          creationSource: continuation ? "provider" : "web",
        },
      });
    }
    const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    while (true) {
      const event = yield* Queue.take(events);
      seen.push(event);
      yield* onEvent(event);
      if (event.type === "turn.terminal") return seen;
    }
  });
  return { runtime, providerThread, runTurn, cwd, fileSystem, events };
});

const assistantText = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events
    .flatMap((event) =>
      event.type === "message.updated" &&
      event.message.role === "assistant" &&
      !event.message.streaming
        ? [event.message.text]
        : [],
    )
    .join("\n");

describe.skipIf(!LIVE)("omp adapter (live)", () => {
  it.live(
    "runs turns, streams text and reports tool calls",
    () =>
      Effect.gen(function* () {
        const { providerThread, runTurn } = yield* openLive("full-access");
        const first = yield* runTurn(providerThread, "Reply with exactly: live ok");
        const terminal = first.find((event) => event.type === "turn.terminal");
        assert.strictEqual(
          terminal?.type === "turn.terminal" ? terminal.status : null,
          "completed",
        );
        assert.include(assistantText(first).toLowerCase(), "live ok");
        const second = yield* runTurn(
          providerThread,
          "Run the shell command `cat a.txt` with your bash tool and then reply DONE.",
        );
        const command = second.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "completed",
        );
        assert.isDefined(command);
        const usage = second.filter(
          (event) => event.type === "provider_turn.updated" && event.providerTurn.tokenUsage,
        );
        assert.isAbove(usage.length, 0);
        // The settled turn carries what its assistant messages billed.
        const billed = second.findLast(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.turnTokenUsage !== undefined,
        );
        const turnUsage =
          billed?.type === "provider_turn.updated" ? billed.providerTurn.turnTokenUsage : undefined;
        assert.strictEqual(turnUsage?.usageStatus, "complete");
        assert.isAbove(turnUsage?.inputTokens ?? 0, 0);
        assert.isAbove(turnUsage?.outputTokens ?? 0, 0);
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "asks for approval in Supervised mode and runs the approved command",
    () =>
      Effect.gen(function* () {
        const { runtime, providerThread, runTurn, cwd, fileSystem } =
          yield* openLive("approval-required");
        const events = yield* runTurn(
          providerThread,
          "Run the shell command `echo approved > out.txt` with your bash tool, then reply DONE.",
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.status === "waiting"
              ? runtime.respondToRuntimeRequest({
                  requestId: event.turnItem.requestId,
                  decision: "accept",
                })
              : Effect.void,
        );
        const approval = events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.isDefined(approval);
        const written = yield* fileSystem.readFileString(`${cwd}/out.txt`);
        assert.strictEqual(written.trim(), "approved");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "reports a native task subagent from start to result, with its own child thread",
    () =>
      Effect.gen(function* () {
        const { providerThread, runTurn } = yield* openLive("full-access");
        const events = yield* runTurn(
          providerThread,
          "Use your task tool to spawn exactly one subagent (agent: task) that reads a.txt and reports its content, wait for it, then tell me what it said in one sentence.",
        );
        const subagents = events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent] : [],
        );
        assert.isAbove(subagents.length, 0);
        const last = subagents.at(-1);
        assert.strictEqual(last?.status, "completed");
        assert.include((last?.result ?? "").toLowerCase(), "hello");
        assert.include(assistantText(events).toLowerCase(), "hello");

        const child = events.find(
          (event) =>
            event.type === "app_thread.created" &&
            event.appThread.lineage.relationshipToParent === "subagent",
        );
        assert.isTrue(child?.type === "app_thread.created");
        if (child?.type !== "app_thread.created") return;
        assert.strictEqual(child.appThread.lineage.parentThreadId, last?.threadId);
        assert.strictEqual(child.appThread.creationSource, "provider");
        assert.strictEqual(last?.childThreadId, child.appThread.id);
        // The child thread holds the subagent's own session, settled when it ended.
        const childItems = new Map<string, OrchestrationV2TurnItem>();
        for (const event of events) {
          if (event.type === "turn_item.updated" && event.turnItem.threadId === child.appThread.id)
            childItems.set(event.turnItem.id, event.turnItem);
        }
        const items = [...childItems.values()];
        assert.isTrue(items.every((item) => item.runId === null));
        assert.isTrue(items.some((item) => item.type === "user_message"));
        assert.isTrue(
          items.some((item) => item.type === "assistant_message" && item.status === "completed"),
        );
        assert.isTrue(
          items.some(
            (item) =>
              (item.type === "dynamic_tool" || item.type === "command_execution") &&
              item.status === "completed",
          ),
        );
        assert.isTrue(items.every((item) => item.status !== "running"));
        const childRoot = events.findLast(
          (event) =>
            event.type === "node.updated" &&
            event.node.threadId === child.appThread.id &&
            event.node.kind === "root_turn",
        );
        assert.strictEqual(
          childRoot?.type === "node.updated" ? childRoot.node.status : null,
          "completed",
        );
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    300_000,
  );

  it.live(
    "wakes T3 when a background subagent finishes after the turn",
    () =>
      Effect.gen(function* () {
        const offers = yield* Queue.unbounded<ProviderContinuationRequest>();
        const { providerThread, runTurn } = yield* openLive("full-access", {
          offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
        });
        const first = yield* runTurn(
          providerThread,
          "Use your task tool to spawn exactly one subagent (agent: task) that reads a.txt and reports its content. Do not wait for it: end your turn right away. When its result arrives later, tell me what a.txt contains.",
        );
        assert.isTrue(
          first.some((event) => event.type === "background_work.updated" && event.pending),
        );
        const offer = yield* Queue.take(offers).pipe(Effect.timeout("150 seconds"));
        assert.strictEqual(offer.delivery, "adapter_buffered");
        const wake = yield* runTurn(providerThread, "", () => Effect.void, true);
        const terminal = wake.find((event) => event.type === "turn.terminal");
        assert.strictEqual(
          terminal?.type === "turn.terminal" ? terminal.status : null,
          "completed",
        );
        assert.include(assistantText(wake).toLowerCase(), "hello");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    300_000,
  );

  it.live(
    "asks structured questions through omp's ask tool",
    () =>
      Effect.gen(function* () {
        const { runtime, providerThread, runTurn } = yield* openLive("full-access");
        const events = yield* runTurn(
          providerThread,
          "Use your ask tool to ask me one multiple-choice question: which color do I prefer, red or blue? Then reply with my answer.",
          (event) => {
            if (
              event.type !== "turn_item.updated" ||
              event.turnItem.type !== "user_input_request" ||
              event.turnItem.status !== "waiting"
            )
              return Effect.void;
            const question = event.turnItem.questions[0];
            assert.isDefined(question);
            assert.isTrue(
              question!.options.some((option) => option.label.toLowerCase() === "blue"),
            );
            const blue = question!.options.find((option) => option.label.toLowerCase() === "blue");
            return runtime.respondToRuntimeRequest({
              requestId: event.turnItem.requestId,
              answers: { [question!.id]: blue!.value ?? blue!.label },
            });
          },
        );
        assert.include(assistantText(events).toLowerCase(), "blue");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "shows omp's todo tool as the thread's task list",
    () =>
      Effect.gen(function* () {
        const { providerThread, runTurn } = yield* openLive("full-access");
        const events = yield* runTurn(
          providerThread,
          "Use your todo tool to start a list with exactly two tasks, `Read a.txt` and `Report its content`, then mark `Read a.txt` done with the todo tool, then reply DONE. Do not do anything else.",
        );
        const lists = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "todo_list"
            ? [event.turnItem]
            : [],
        );
        assert.isAbove(lists.length, 0);
        // Each todo call replaces the same list.
        assert.strictEqual(new Set(lists.map((list) => list.id)).size, 1);
        const steps = lists.at(-1)!.steps;
        assert.strictEqual(steps.length, 2);
        assert.include(steps[0]!.text, "Read a.txt");
        assert.strictEqual(steps[0]!.status, "completed");
        // Later calls replace the list; the first one still had open work.
        assert.isTrue(lists[0]!.steps.some((step) => step.status !== "completed"));
        assert.isFalse(
          events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.toolName === "todo" &&
              event.turnItem.status === "completed",
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "stops a running command and keeps the thread usable",
    () =>
      Effect.gen(function* () {
        const { runtime, providerThread, runTurn } = yield* openLive("full-access");
        const stopped = yield* runTurn(
          providerThread,
          "Run the shell command `sleep 30` with your bash tool, then reply DONE.",
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "running"
              ? runtime
                  .interruptTurn({
                    providerThread,
                    providerTurnId: event.turnItem.providerTurnId!,
                  })
                  .pipe(Effect.forkScoped, Effect.asVoid)
              : Effect.void,
        );
        const terminal = stopped.find((event) => event.type === "turn.terminal");
        assert.strictEqual(
          terminal?.type === "turn.terminal" ? terminal.status : null,
          "interrupted",
        );
        const after = yield* runTurn(providerThread, "Reply with exactly: after stop");
        assert.include(assistantText(after).toLowerCase(), "after stop");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "continues an interrupted turn with native resume",
    () =>
      Effect.gen(function* () {
        const { runtime, providerThread, runTurn } = yield* openLive("full-access");
        const stopped = yield* runTurn(
          providerThread,
          "Run the shell command `sleep 20` with your bash tool, then reply with exactly: resumed ok",
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "running"
              ? runtime
                  .interruptTurn({
                    providerThread,
                    providerTurnId: event.turnItem.providerTurnId!,
                  })
                  .pipe(Effect.forkScoped, Effect.asVoid)
              : Effect.void,
        );
        const stoppedTerminal = stopped.find((event) => event.type === "turn.terminal");
        assert.strictEqual(
          stoppedTerminal?.type === "turn.terminal" ? stoppedTerminal.status : null,
          "interrupted",
        );
        const resumed = yield* runTurn(providerThread, "", undefined, false, selection(), true);
        const terminal = resumed.find((event) => event.type === "turn.terminal");
        assert.strictEqual(
          terminal?.type === "turn.terminal" ? terminal.status : null,
          "completed",
        );
        assert.include(assistantText(resumed).toLowerCase(), "resumed ok");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "steers a running turn",
    () =>
      Effect.gen(function* () {
        const { runtime, providerThread, runTurn } = yield* openLive("full-access");
        let steered = false;
        const events = yield* runTurn(
          providerThread,
          "Run the shell command `sleep 6` with your bash tool, then reply DONE.",
          (event) => {
            if (
              steered ||
              event.type !== "turn_item.updated" ||
              event.turnItem.type !== "command_execution"
            )
              return Effect.void;
            steered = true;
            return runtime.steerTurn({
              threadId: event.turnItem.threadId,
              runId: event.turnItem.runId!,
              providerThread,
              providerTurnId: event.turnItem.providerTurnId!,
              message: {
                messageId: "message:steer" as never,
                text: "Also include the word BANANA in your final reply.",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
          },
        );
        assert.isTrue(steered);
        assert.isTrue(
          events.some((event) => event.type === "steer.updated" && event.status === "completed"),
        );
        assert.include(assistantText(events).toLowerCase(), "banana");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "runs a role entry and resumes the session in a new process",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace();
        const firstThread = yield* Effect.gen(function* () {
          const { providerThread, runTurn } = yield* openLive(
            "full-access",
            undefined,
            undefined,
            cwd,
          );
          const events = yield* runTurn(
            providerThread,
            "Remember the code word PELICAN. Reply with exactly: ok",
            () => Effect.void,
            false,
            { instanceId: INSTANCE_ID, model: "role:smol" },
          );
          const finished = events.findLast(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
          );
          assert.strictEqual(
            finished?.type === "provider_turn.updated" ? finished.providerTurn.model : null,
            MODEL,
          );
          return providerThread;
        }).pipe(Effect.scoped);
        const resumed = yield* openLive(
          "full-access",
          undefined,
          { providerThread: firstThread },
          cwd,
        );
        const events = yield* resumed.runTurn(
          resumed.providerThread,
          "What code word did I ask you to remember? Reply with just the word.",
        );
        assert.include(assistantText(events).toLowerCase(), "pelican");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    240_000,
  );

  it.live(
    "rolls back and forks from an earlier turn",
    () =>
      Effect.gen(function* () {
        const { runtime, providerThread, runTurn } = yield* openLive("full-access");
        const finalTurn = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
          const update = events.findLast(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
          );
          assert.isDefined(update);
          return (update as Extract<typeof update, { type: "provider_turn.updated" }>)!
            .providerTurn;
        };
        const first = finalTurn(
          yield* runTurn(providerThread, "Remember the code word APPLE. Reply with exactly: ok"),
        );
        const second = finalTurn(
          yield* runTurn(
            providerThread,
            "Also remember the code word MANGO. Reply with exactly: ok",
          ),
        );
        assert.strictEqual(first.nativeTurnRef?.strength, "strong");
        const snapshot = yield* runtime.rollbackThread({
          providerThread,
          providerThreadTurns: [first, second],
          target: {
            type: "provider_turn",
            checkpointId: "checkpoint:omp-live" as never,
            appRunOrdinal: 1,
            providerTurn: first,
          },
        });
        const rolledBack = yield* runTurn(
          snapshot.providerThread,
          "List every code word I asked you to remember, comma separated, nothing else.",
        );
        const rolledBackText = assistantText(rolledBack).toLowerCase();
        assert.include(rolledBackText, "apple");
        assert.notInclude(rolledBackText, "mango");
        const forked = yield* runtime.forkThread({
          sourceProviderThread: snapshot.providerThread,
          sourceProviderTurns: [first],
          targetThreadId: snapshot.providerThread.appThreadId!,
        });
        assert.notStrictEqual(
          forked.nativeThreadRef?.nativeId,
          snapshot.providerThread.nativeThreadRef?.nativeId,
        );
        const fromFork = yield* runTurn(
          forked,
          "List every code word I asked you to remember, comma separated, nothing else.",
        );
        assert.include(assistantText(fromFork).toLowerCase(), "apple");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    300_000,
  );

  it.live(
    "moves a resumed session into the thread's new workspace",
    () =>
      Effect.gen(function* () {
        const before = yield* makeWorkspace("t3-omp-live-a-");
        const after = yield* makeWorkspace("t3-omp-live-b-");
        const firstThread = yield* Effect.gen(function* () {
          const { providerThread, runTurn } = yield* openLive(
            "full-access",
            undefined,
            undefined,
            before,
          );
          yield* runTurn(providerThread, "Remember the code word OTTER. Reply with exactly: ok");
          return providerThread;
        }).pipe(Effect.scoped);
        const moved = yield* openLive(
          "full-access",
          undefined,
          { providerThread: firstThread },
          after,
        );
        assert.notStrictEqual(
          moved.providerThread.nativeThreadRef?.nativeId,
          firstThread.nativeThreadRef?.nativeId,
        );
        const events = yield* moved.runTurn(
          moved.providerThread,
          "Run `pwd` with your bash tool. Then reply with the code word I asked you to remember and the directory pwd printed.",
        );
        const text = assistantText(events).toLowerCase();
        assert.include(text, "otter");
        assert.include(text, after.toLowerCase());
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
    300_000,
  );
});
