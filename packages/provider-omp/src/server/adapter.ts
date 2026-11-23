import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeUtil from "node:util";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { readToolOutputImage } from "@t3tools/shared/toolOutput";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import * as Predicate from "effect/Predicate";
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2PlanStep,
  type OrchestrationV2UserInputQuestion,
  type PlanId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ProviderTurnId,
  type MessageId,
  type OrchestrationV2ProviderTurnTokenUsage,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { parseOmpCompactCommand, type OmpCompactCommand } from "./commands.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  t3OrchestrationSystemPrompt,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import {
  findReportedOmpModel,
  makeOmpRpcConnection,
  resolveOmpModelSlug,
  ompRecordField as recordField,
  ompRecordNumber as recordNumber,
  ompRecordString as recordString,
  type OmpRpcConnection,
  type OmpRpcError,
  type OmpRpcRecord,
} from "./rpc.ts";
import {
  buildOmpRpcLaunch,
  materializeOmpModelRolesOverlay,
  materializeOmpT3Extension,
  resolveOmpLaunchArgs,
} from "./launch.ts";
import {
  OMP_T3_MCP_TOOL_PREFIX,
  openOmpT3McpHostTools,
  type OmpT3McpHostTools,
} from "./mcpHostTools.ts";
import { parseOmpHtmlForm, type OmpHtmlForm } from "./htmlForm.ts";
import { isOmpThinkingLevel, parseOmpModelSelector } from "./modelCapabilities.ts";
import { readOmpModelRoles } from "./roles.ts";
import { ompModelRoleOverrides } from "../settings.ts";

const OMP_PROVIDER = ProviderDriverKind.make("omp");
const OMP_DRIVER_KIND = OMP_PROVIDER;
const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});

// Inherit omp's configured default model role without calling set_model.
const OMP_INHERIT_MODEL_SLUG = "default";
const OMP_ROLE_MODEL_PREFIX = "role:";

const STREAM_FLUSH_MS = 50;
const OMP_REQUEST_TIMEOUT_MS = 15_000;
const OMP_SESSION_TIMEOUT_MS = 60_000;
const MAX_EXTENSION_STATUSES = 32;
const MAX_EXTENSION_STATUS_KEY_LENGTH = 256;
const MAX_EXTENSION_STATUS_TEXT_LENGTH = 4096;
const OMP_UNSOLICITED_ACTIVITY_ERROR =
  "omp started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.";
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);
const MAX_SUBAGENT_PROGRESS_CHARS = 200;
const MAX_SUBAGENT_RESULT_CHARS = 10_000;

const OmpProviderCapabilitiesV2 = {
  // omp's --approval-mode enforces Supervised and Auto-accept edits itself.
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // --approval-mode is fixed at launch, so a mode change restarts omp.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: false,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    // CommandPolicy requires a snapshot for rollback; rollbackThread returns the updated provider thread.
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OmpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (recordField(block, "type") === "text") return recordString(block, "text") ?? "";
      return "";
    })
    .join("");
}

const MAX_STRUCTURED_TOOL_OUTPUT_BYTES = 64 * 1024;

function isBoundedStructuredToolValue(value: unknown): boolean {
  let bytes = MAX_STRUCTURED_TOOL_OUTPUT_BYTES;
  let nodes = 4_096;
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 32 || --nodes < 0 || bytes < 0) return false;
    if (Array.isArray(entry)) {
      bytes -= 2 + entry.length;
      return entry.every((item) => visit(item, depth + 1));
    }
    if (Predicate.isObject(entry)) {
      bytes -= 2;
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue;
        if (key.length > bytes) return false;
        bytes -= Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        if (!visit(entry[key], depth + 1)) return false;
      }
      return bytes >= 0;
    }
    if (typeof entry === "string" && entry.length > bytes) return false;
    bytes -= Buffer.byteLength(JSON.stringify(entry) ?? "null", "utf8");
    return bytes >= 0;
  };
  return visit(value, 0);
}

function ompToolOutput(result: unknown, toolName: string): unknown {
  const rawContent = recordField(result, "content");
  const content = Array.isArray(rawContent)
    ? rawContent
    : typeof rawContent === "string"
      ? [{ type: "text", text: rawContent }]
      : [];
  let structured = recordField(result, "structuredContent");
  const details = recordField(result, "details");
  const isMcpResult =
    toolName.startsWith("mcp__") &&
    recordString(details, "server") !== undefined &&
    recordString(details, "tool") !== undefined &&
    Array.isArray(recordField(structured, "content"));
  if (isMcpResult) {
    structured = recordField(structured, "structuredContent");
  }
  if (typeof structured === "string" && structured === contentText(content)) {
    structured = undefined;
  }
  // Native read mirrors image/note in structured output; drop only that mirror, retaining extension metadata.
  if (toolName === "read" && Predicate.isObject(structured)) {
    const image = readToolOutputImage(structured);
    const note =
      recordString(
        content.find((block) => recordField(block, "type") === "text"),
        "text",
      ) ?? "";
    if (
      image !== null &&
      Object.keys(structured).every((key) => ["type", "data", "mimeType", "note"].includes(key)) &&
      recordString(structured, "note") === note &&
      content.some((block) => {
        const match = readToolOutputImage(block);
        return match !== null && match.mimeType === image.mimeType && match.data === image.data;
      })
    ) {
      structured = undefined;
    }
  }
  if (structured !== undefined && !isBoundedStructuredToolValue(structured)) {
    return {
      content: [
        ...content,
        {
          type: "text",
          text: "Structured output omitted because it exceeds the stored result limit.",
        },
      ],
    };
  }
  if (
    !isMcpResult &&
    structured === undefined &&
    content.every((block) => recordField(block, "type") === "text")
  ) {
    const text = contentText(content);
    return text.length > 0 ? text : undefined;
  }
  return {
    content,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: OMP_PROVIDER, nativeId, strength };
}

interface OmpStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  published: boolean;
  readonly startedAt: DateTime.Utc;
}

type OmpCompactionStatus = "running" | "completed" | "failed" | "cancelled";

interface OmpCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}

interface OmpProviderRetryState {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

function compactionTitle(status: OmpCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

type OmpMessageTokenUsage = Pick<
  OrchestrationV2ProviderTurnTokenUsage,
  "inputTokens" | "cachedInputTokens" | "outputTokens"
>;

/**
 * Where a stream of omp agent events lands: a turn of the thread, or the child thread that shows
 * one subagent's own session. `nativeItemId` keeps ids from different targets apart.
 */
interface OmpItemTarget {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly nativeItemId: (nativeId: string) => string;
  /** Prefixes this target's streamed text and reasoning items. */
  readonly streamKey: string;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  messageOrdinal: number;
  readonly streamItems: Map<string, OmpStreamItemState>;
  readonly toolNames: Map<string, string>;
  readonly toolArgs: Map<string, unknown>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly commandOutputBytes: Map<string, number>;
  readonly endedToolCalls: Set<string>;
  interrupted: boolean;
  /** The list omp's `todo` tool keeps here; each successful call replaces its steps in place. */
  todoList: { readonly planId: PlanId; readonly startedAt: DateTime.Utc } | null;
}

interface ActiveOmpTurn extends OmpItemTarget {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  nativeAborted: boolean;
  sawAgentActivity: boolean;
  adoptedWake: boolean;
  promptMayBeCommandOnly: boolean;
  latestCompactionAfterTokens: number | null;
  lastLiveUsedTokens: number | null;
  lastMessageUsage: OmpMessageTokenUsage | undefined;
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after omp yields. */
  settleWhenIdle: boolean;
  /** A cancelled compact fails its response too; that is a stop, not a turn failure. */
  compactionCancelled: boolean;
  manualCompactInFlight: boolean;
  activeCompaction: OmpCompactionState | null;
  activeProviderRetry: OmpProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  rejectedPromptFailure: ReturnType<typeof makeProviderFailure> | null;
  /** Steers omp queued in send order; it reads them at a step boundary, after running tools return. */
  readonly unreadSteers: Array<MessageId>;
  stopTreeRefs?: OmpTurnTreeRefs | null;
  /** The provider/model omp reported on its latest assistant message. */
  reportedModel?: string;
  /** Request id of the prompt that started this turn; its `prompt_result` reports pre-agent failures. */
  turnStartPromptId: string | null;
  /** The latest assistant message ended with `stopReason: "aborted"`. */
  lastAssistantAborted: boolean;
}

/** Maps omp RPC frames onto the event shapes the turn state machine follows. */
export function normalizeOmpFrame(frame: OmpRpcRecord): ReadonlyArray<OmpRpcRecord> {
  switch (frame["type"]) {
    case "agent_end":
      // The agent finished its turn; settlement is still confirmed with get_state.
      return frame["yielded"] === false ? [frame] : [frame, { type: "agent_settled" }];
    case "auto_compaction_start":
    case "manual_compaction_start":
      return [{ type: "compaction_start" }];
    case "auto_compaction_end":
    case "manual_compaction_end": {
      const skipped = frame["skipped"] === true;
      return [
        {
          type: "compaction_end",
          ...(skipped ? {} : { result: frame["result"] }),
          aborted: frame["aborted"] === true || skipped,
          willRetry: frame["willRetry"] === true,
          ...(typeof frame["errorMessage"] === "string" && !skipped
            ? { errorMessage: frame["errorMessage"] }
            : {}),
        },
      ];
    }
    default:
      return [frame];
  }
}

interface OmpTurnTreeRefs {
  /** Omitted keeps the synthetic ref; null means the turn left nothing on the active branch. */
  readonly nativeTurnRef: OrchestrationV2ProviderRef | null | undefined;
  readonly leafId: string | null;
  readonly retainedNativeTurnIds: ReadonlyArray<string> | undefined;
}

/** omp's approval prompt as a select: its labels for each T3 decision. */
interface OmpApprovalChoices {
  readonly once: string;
  readonly session: string | undefined;
  readonly deny: string;
}

interface PendingOmpPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor" | "ask" | "form";
  readonly questionId: string;
  readonly approvalKey: string;
  readonly expiresAt: number | null;
  expirationFiber: Fiber.Fiber<void> | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  readonly approval: OmpApprovalChoices | undefined;
  readonly askQuestions: ReadonlyArray<OrchestrationV2UserInputQuestion> | undefined;
  readonly form: OmpHtmlForm | undefined;
}

const OMP_FILE_CHANGE_TOOLS = new Set(["edit", "write", "ast_edit", "notebook"]);

/**
 * omp asks for tool approval over RPC as a select titled `Allow tool: <name>` with
 * Approve / Approve <x> for this session / Deny choices (cached grants add more).
 */
export function ompApprovalPrompt(
  title: string,
  options: ReadonlyArray<string>,
):
  | {
      readonly toolName: string;
      readonly kind: "command" | "file-change";
      readonly choices: OmpApprovalChoices;
    }
  | undefined {
  const toolName = /^Allow tool: (\S+)/.exec(title)?.[1];
  if (toolName === undefined) return undefined;
  const once = options.find((option) => option === "Approve" || option === "Approve Once");
  const deny = options.find((option) => option === "Deny");
  if (once === undefined || deny === undefined) return undefined;
  const session = options.find(
    (option) => option.startsWith("Approve ") && option.endsWith(" for this session"),
  );
  // A write to an xd:// device runs that tool; name the tool rather than `write`.
  const device = /\nPath: xd:\/\/(\S+)/.exec(title)?.[1];
  return {
    toolName: device ?? toolName,
    kind: OMP_FILE_CHANGE_TOOLS.has(toolName) && device === undefined ? "file-change" : "command",
    choices: { once, session, deny },
  };
}

/** omp queues prompts that race its own compaction rather than rejecting them. */
const OMP_COMPACTING_PROMPT_REJECTION = "Cannot submit a prompt while compaction is in progress";

interface OmpPromptSend {
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly kind: "turn_start" | "steer";
  readonly record: OmpRpcRecord;
  readonly messageId?: MessageId;
}

interface OmpThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActiveOmpTurn | null;
  /** Files an extension moved this thread off (ctx.newSession); queued turns may still name them. */
  readonly supersededSessionFiles: Set<string>;
}

const isLiveSessionOf = (state: OmpThreadState, nativeId: string | null | undefined) =>
  nativeId === state.providerThread.nativeThreadRef?.nativeId ||
  (nativeId != null && state.supersededSessionFiles.has(nativeId));

interface OmpWake {
  readonly state: OmpThreadState;
  readonly events: Array<OmpRpcRecord>;
}

/** The provider-native child thread that shows one subagent's own session. */
interface OmpSubagentThread {
  readonly target: OmpItemTarget;
  appThread: OrchestrationV2AppThread;
}

/** A subagent omp's `task` tool started, tied to the turn whose tool call launched it. */
interface TrackedOmpSubagent {
  readonly id: string;
  /** The root turn whose task call started this subagent, or the subagent it descends from. */
  readonly turn: ActiveOmpTurn;
  /** Where its card lives: the root turn, or the child thread of the subagent that started it. */
  readonly owner: OmpItemTarget;
  /** Unique across sessions, unlike omp's subagent ids; derives this subagent's T3 ids. */
  readonly key: string;
  readonly parentToolCallId: string | undefined;
  readonly startedAt: DateTime.Utc;
  /** Null when it started after its root turn ended, when T3 no longer accepts new child threads. */
  readonly child: OmpSubagentThread | null;
  agent: string;
  prompt: string;
  title: string | null;
  model: string | null;
  status: OrchestrationV2Subagent["status"];
  progress: string | undefined;
  result: string | null;
  /** What was last emitted, so progress frames that change nothing visible stay quiet. */
  emittedKey: string;
}

function ompSubagentStatus(status: string | undefined): OrchestrationV2Subagent["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

const isSubagentActive = (status: OrchestrationV2Subagent["status"]) =>
  status === "pending" || status === "running" || status === "waiting";
export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  options: OmpAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const { continuationRequests } = options;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: OMP_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: Effect.fn("OmpAdapter.getCapabilities")(function () {
      return Effect.succeed(OmpProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("OmpAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("OmpAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const mcpSession = yield* mcpSessions.read(input.threadId);
      const provideCacheFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: OMP_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      const cacheDir = host.paths.providerStatusCacheDir;
      const extensionPath = yield* provideCacheFs(materializeOmpT3Extension(cacheDir));
      const instructionsDir = path.join(cacheDir, "omp-instructions");
      yield* provideCacheFs(fileSystem.makeDirectory(instructionsDir, { recursive: true }));
      const instructionsFile = path.join(
        instructionsDir,
        `${String(input.providerSessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.md`,
      );
      yield* Effect.addFinalizer(() => fileSystem.remove(instructionsFile).pipe(Effect.ignore));
      const modelRolesOverlayPath = options.settings.saveModelRolesToOmpConfig
        ? undefined
        : yield* provideCacheFs(
            materializeOmpModelRolesOverlay(
              cacheDir,
              String(options.instanceId),
              ompModelRoleOverrides(options.settings),
            ),
          );
      const resolvedLaunchArgs = resolveOmpLaunchArgs(options.settings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* protocolError(resolvedLaunchArgs.message);
      }
      // Turns keep working without T3 tools when the thread's MCP server is unreachable.
      const hostTools: OmpT3McpHostTools | null =
        mcpSession === undefined
          ? null
          : yield* openOmpT3McpHostTools(mcpSession).pipe(
              Effect.timeoutOption(Duration.seconds(10)),
              Effect.map(Option.getOrNull),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not expose T3 Code's MCP tools to omp.", {
                  errorTag: Cause.squash(cause) instanceof Error ? "Error" : "Unknown",
                }).pipe(Effect.as(null)),
              ),
            );
      // omp resumes a session in the cwd its header names, so a workspace handoff moves it.
      const sessionFileCwd = Effect.fnUntraced(function* (sessionFile: string) {
        const lines = yield* fileSystem.stream(sessionFile).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(8),
          Stream.runCollect,
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        for (const line of lines) {
          const record = Option.getOrUndefined(decodeSessionLine(line));
          if (recordString(record, "type") === "session") return recordString(record, "cwd");
        }
        return undefined;
      });
      const sessionHeaderNamesCwd = Effect.fnUntraced(function* (sessionFile: string) {
        const sessionCwd = yield* sessionFileCwd(sessionFile);
        if (sessionCwd === undefined || sessionCwd === cwd) return true;
        const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
        return sessionCwd === realCwd;
      });
      // Spawning on a session from another cwd would run its tools there; registerThread moves it first.
      const initialSessionPath =
        input.initialNativeThreadId !== undefined &&
        (yield* sessionHeaderNamesCwd(input.initialNativeThreadId))
          ? input.initialNativeThreadId
          : undefined;
      const configureConnection = Effect.fnUntraced(function* (connection: OmpRpcConnection) {
        // Delta updates avoid resending the whole message on every token.
        yield* connection.request({
          type: "set_event_filter",
          events: null,
          messageUpdates: "delta",
        });
        yield* connection.request({ type: "set_ask_dialog", enabled: true });
        // "events" adds each subagent's own session, which its child thread shows.
        yield* connection.request({ type: "set_subagent_subscription", level: "events" });
        if (hostTools !== null && hostTools.definitions.length > 0) {
          yield* connection.request({ type: "set_host_tools", tools: hostTools.definitions });
        }
      });
      const startConnection = Effect.fnUntraced(function* (sessionPath?: string) {
        const connectionScope = yield* Scope.fork(scope, "sequential");
        return yield* Effect.gen(function* () {
          const launch = buildOmpRpcLaunch({
            launchArgs: resolvedLaunchArgs.args,
            // PortScanner.AGENT_THREAD_ENV, as a literal because this package cannot reach apps/server.
            environment: { ...options.environment, T3CODE_THREAD_ID: input.threadId },
            sessionPath,
            runtimeMode: input.runtimePolicy.runtimeMode,
            extensionPath,
            instructionsFile,
            modelRolesOverlayPath,
          });
          const scopedLaunch = yield* agentScope.wrap({
            command: options.settings.binaryPath || "omp",
            args: launch.args,
            name: "omp",
            threadId: input.threadId,
            env: launch.env,
          });
          // Finalizers run in reverse order: reap detached work after terminating omp.
          const scopeUnit = scopedLaunch.unit;
          const stopScope =
            scopeUnit === undefined
              ? Effect.void
              : yield* Effect.cached(agentScope.stop(scopeUnit));
          yield* Effect.addFinalizer(() => stopScope);
          const connection = yield* makeOmpRpcConnection({
            command: scopedLaunch.command,
            args: scopedLaunch.args,
            cwd,
            env: launch.env,
          });
          // Its tools carry T3CODE_THREAD_ID, so port discovery must scan while omp runs.
          const trackAgent = host.trackAgent;
          if (trackAgent !== undefined) {
            yield* Effect.acquireRelease(Effect.sync(trackAgent), (release) =>
              Effect.sync(release),
            );
          }
          // Detached children can keep stdout open after omp exits.
          if (scopeUnit !== undefined) {
            yield* connection.exited.pipe(
              Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
              Effect.forkIn(connectionScope),
            );
          }
          yield* configureConnection(connection);
          return { connection, scope: connectionScope };
        }).pipe(
          Effect.provideService(Scope.Scope, connectionScope),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(connectionScope, exit) : Effect.void,
          ),
        );
      });
      // omp exits before answering when --session names a file it cannot open; start fresh instead.
      let spawnedSessionPath = initialSessionPath;
      let started = yield* startConnection(initialSessionPath).pipe(
        Effect.catchTags({
          OmpRpcError: (error) =>
            initialSessionPath !== undefined &&
            (error.operation === "read" || error.operation === "write")
              ? Effect.suspend(() => {
                  spawnedSessionPath = undefined;
                  return startConnection();
                })
              : Effect.fail(error),
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: OMP_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      let connection: OmpRpcConnection = started.connection;
      const initialActivationDone = yield* Deferred.make<void>();
      let initialActivationPending = spawnedSessionPath !== undefined;
      let initialRequestStarted = false;
      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: OMP_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: OmpProviderCapabilitiesV2,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingPrompts = new Map<string, PendingOmpPrompt>();
      const sessionApprovals = new Set<string>();
      // omp subagents by id, from their `started` lifecycle frame until a terminal one.
      const ompSubagents = new Map<string, TrackedOmpSubagent>();
      // Host tool calls in flight, by omp request id, so host_tool_cancel can stop them.
      const hostToolCalls = new Map<string, Fiber.Fiber<void>>();
      // omp can settle immediately after dialog response; serialize so terminal cannot overtake request resolution.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: OmpThreadState | null = null;
      let registrationAttempted = spawnedSessionPath !== undefined;
      let registrationInProgress = false;
      let lastNativeThreadId: string | null = spawnedSessionPath ?? null;
      let stopRequested = false;
      let unsolicitedActivityDetected = false;
      // Turn failures can leave omp alive; pump termination retires the runtime.
      let runtimeRetired = false;
      let pendingWake: OmpWake | null = null;
      let extensionStatusReset: {
        previous: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>;
        readonly touched: Set<string>;
        readonly ready: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
      } | null = null;
      let rollbackBarrier: Deferred.Deferred<
        void,
        ProviderAdapter.ProviderAdapterProtocolError
      > | null = null;
      let pendingPromptResponsesDrained: Deferred.Deferred<
        void,
        ProviderAdapter.ProviderAdapterProtocolError
      > | null = null;
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          sessionEntity = { ...sessionEntity, extensionStatuses: [] };
          pendingWake = null;
          if (pendingPromptResponsesDrained !== null)
            yield* Deferred.fail(
              pendingPromptResponsesDrained,
              protocolError("omp session closed while awaiting prompt acknowledgment"),
            );
          if (extensionStatusReset !== null)
            yield* Deferred.fail(
              extensionStatusReset.ready,
              protocolError("omp session closed during status reset"),
            );
          if (rollbackBarrier !== null)
            yield* Deferred.fail(
              rollbackBarrier,
              protocolError("omp session closed during rollback"),
            );
        }),
      );
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      let appliedSessionName: string | null = null;
      let appliedInstructions: string | null = null;
      const outOfTurnExtensionErrors: Array<OmpRpcRecord> = [];
      let lastKnownLeaf: string | null = null;
      // Failed get_entries leaves an untrustworthy turn boundary; re-sync the cursor on next capture.
      let leafCursorStale = false;
      // omp has no unset commands; capture initial defaults so omp default can replay them.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      let contextWindow: number | null = null;
      const modelContextWindows = new Map<string, number>();
      let discoveredModels: ReadonlyArray<unknown> | null = null;
      let nextPromptId = 0;
      const pendingPromptResponses: Array<OmpPromptSend & { readonly id: string }> = [];
      const pendingCompactResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];
      // omp rejects every prompt while it compacts, including compaction an
      // extension starts after the turn settled. Hold prompts until it ends.
      let nativeCompacting = false;
      const heldPrompts: Array<OmpPromptSend> = [];
      // Prompts sent before the pump observed compaction_start are rejected
      // after it; they precede every prompt held since.
      let rejectedHeldCount = 0;

      const sendPrompt = Effect.fnUntraced(function* (prompt: OmpPromptSend) {
        if (nativeCompacting) {
          heldPrompts.push(prompt);
          return;
        }
        const id = `t3-prompt-${nextPromptId++}`;
        yield* connection.send({ ...prompt.record, id });
        pendingPromptResponsesDrained ??= yield* Deferred.make<
          void,
          ProviderAdapter.ProviderAdapterProtocolError
        >();
        pendingPromptResponses.push({ ...prompt, id });
        const turn = threadState?.activeTurn;
        if (prompt.kind === "turn_start" && turn?.providerTurn.id === prompt.providerTurnId) {
          turn.turnStartPromptId = id;
        }
      });
      // A just-released prompt has not started its run yet, so a settle probe
      // racing it would see omp idle. Its ack re-arms the probe instead.
      let releasedPromptTurnId: OrchestrationV2ProviderTurn["id"] | null = null;

      const compactRpcRecord = (command: OmpCompactCommand): OmpRpcRecord =>
        command.customInstructions === undefined
          ? { type: "compact" }
          : { type: "compact", customInstructions: command.customInstructions };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const emitSteerStatus = (
        turn: ActiveOmpTurn,
        messageId: MessageId,
        status: "pending" | "completed" | "cancelled",
      ) =>
        emit({
          type: "steer.updated",
          driver: OMP_PROVIDER,
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          messageId,
          status,
        });

      const updateProviderSession =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
        ) {
          const updatedAt = yield* DateTime.now;
          sessionEntity = {
            ...sessionEntity,
            status,
            lastError,
            updatedAt,
            ...(status === "stopped" || runtimeRetired || unsolicitedActivityDetected
              ? { extensionStatuses: [] }
              : {}),
          };
          yield* emit({
            type: "provider_session.updated",
            driver: OMP_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      // Frequent notifications share the event pump's tracing boundary and outlive individual turns.
      const updateExtensionStatus = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        if (
          closed ||
          stopRequested ||
          runtimeRetired ||
          unsolicitedActivityDetected ||
          sessionEntity.status === "stopped"
        )
          return;
        const key = recordString(event, "statusKey");
        const rawText = recordField(event, "statusText");
        if (
          key === undefined ||
          key.trim().length === 0 ||
          key.length > MAX_EXTENSION_STATUS_KEY_LENGTH ||
          (rawText !== undefined && typeof rawText !== "string")
        )
          return;
        const text =
          typeof rawText === "string"
            ? NodeUtil.stripVTControlCharacters(
                rawText.slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH * 4),
              )
                .replaceAll(/\p{Cc}/gu, " ")
                .trim()
                .slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH)
            : "";
        const statuses = sessionEntity.extensionStatuses ?? [];
        if (extensionStatusReset?.previous.some((status) => status.key === key)) {
          extensionStatusReset.touched.add(key);
        }
        const index = statuses.findIndex((status) => status.key === key);
        if (
          index < 0
            ? text.length === 0 || statuses.length >= MAX_EXTENSION_STATUSES
            : statuses[index]?.text === text
        )
          return;
        sessionEntity = {
          ...sessionEntity,
          extensionStatuses:
            text.length === 0
              ? statuses.filter((status) => status.key !== key)
              : index < 0
                ? [...statuses, { key, text }]
                : statuses.map((status) => (status.key === key ? { key, text } : status)),
        };
        yield* updateProviderSession(sessionEntity.status);
      });

      const clearExtensionStatuses = Effect.fn("OmpAdapter.clearExtensionStatuses")(function* () {
        if (sessionEntity.extensionStatuses?.length === 0) return;
        sessionEntity = { ...sessionEntity, extensionStatuses: [] };
        yield* updateProviderSession(sessionEntity.status);
      });

      const updateProviderThread =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          state: OmpThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
          retainedNativeTurnIds?: ReadonlyArray<string>,
        ) {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: OMP_PROVIDER,
            providerThread: state.providerThread,
            ...(retainedNativeTurnIds === undefined ? {} : { retainedNativeTurnIds }),
          });
        });

      const itemOrdinal = (target: OmpItemTarget, nativeItemId: string): number => {
        const existing = target.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = target.nextItemOrdinal++;
        target.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const request = Effect.fnUntraced(function* (
        record: OmpRpcRecord,
        timeoutMs = OMP_REQUEST_TIMEOUT_MS,
      ) {
        if (!initialActivationPending || initialRequestStarted)
          return yield* connection.request(record, timeoutMs);
        initialRequestStarted = true;
        return yield* connection.request(record, timeoutMs).pipe(
          Effect.catchTags({
            OmpRpcError: Effect.fn("OmpAdapter.recoverSpawnSession")(function* (
              error: OmpRpcError,
            ) {
              if (
                closed ||
                stopRequested ||
                unsolicitedActivityDetected ||
                (error.operation !== "read" && error.operation !== "write")
              )
                return yield* error;
              // omp can exit on an unusable --session before RPC starts.
              // Finish failing its queue before retiring the readers.
              yield* Queue.fail(connection.events, error);
              yield* Scope.close(started.scope, Exit.void);
              yield* sessionEventPermit.withPermits(1)(cancelPendingPrompts(yield* DateTime.now));
              started = yield* startConnection().pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
              connection = started.connection;
              if (closed || stopRequested) {
                yield* connection.terminate;
                return yield* error;
              }
              return yield* connection.request(record, timeoutMs);
            }),
          }),
          Effect.ensuring(
            Effect.gen(function* () {
              initialActivationPending = false;
              yield* Deferred.succeed(initialActivationDone, undefined);
            }),
          ),
        );
      });

      const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
        const value = recordNumber(input, key);
        return value === undefined ? undefined : Math.max(0, Math.trunc(value));
      };

      // omp counts uncached input, cache reads and cache writes separately; input includes all three.
      const ompMessageTokenUsage = (usage: unknown): OmpMessageTokenUsage => {
        const uncachedInputTokens = nonNegativeInteger(usage, "input");
        const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
        const outputTokens = nonNegativeInteger(usage, "output");
        return {
          ...(uncachedInputTokens === undefined
            ? {}
            : {
                inputTokens:
                  uncachedInputTokens +
                  (cachedInputTokens ?? 0) +
                  (nonNegativeInteger(usage, "cacheWrite") ?? 0),
              }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        };
      };

      const rememberModelContextWindow = (model: unknown): number | null => {
        const provider = recordString(model, "provider");
        const id = recordString(model, "id");
        const capacity = nonNegativeInteger(model, "contextWindow");
        if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
          modelContextWindows.set(`${provider}/${id}`, capacity);
          return capacity;
        }
        return null;
      };

      const lifecycleRequest = Effect.fn("OmpAdapter.lifecycleRequest")(
        function* (record: OmpRpcRecord) {
          if (extensionStatusReset !== null)
            return yield* protocolError("A omp session lifecycle request is already pending");
          const reset = {
            previous: sessionEntity.extensionStatuses ?? [],
            touched: new Set<string>(),
            ready: yield* Deferred.make<void, ProviderAdapter.ProviderAdapterProtocolError>(),
          };
          extensionStatusReset = reset;
          return yield* Effect.gen(function* () {
            // RPC responses bypass the pump. Reset after all earlier native notifications.
            if (
              !(yield* Queue.offer(connection.events, { type: "t3.extension_status_reset", reset }))
            )
              return yield* protocolError("omp transport closed during status reset");
            yield* Deferred.await(reset.ready);
            const result = yield* request(record, OMP_SESSION_TIMEOUT_MS);
            if (recordField(result, "cancelled") === true) {
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (closed || stopRequested) return;
                  const current = sessionEntity.extensionStatuses ?? [];
                  // A veto keeps the old session. Preserve updates and clears from its lifecycle hooks.
                  const restored = reset.previous.flatMap((status) => {
                    if (!reset.touched.has(status.key)) return [status];
                    const updated = current.find((candidate) => candidate.key === status.key);
                    return updated === undefined ? [] : [updated];
                  });
                  restored.push(
                    ...current.filter(
                      (status) => !reset.previous.some((previous) => previous.key === status.key),
                    ),
                  );
                  const statuses = restored.slice(0, MAX_EXTENSION_STATUSES);
                  if (
                    statuses.length === current.length &&
                    statuses.every(
                      (status, index) =>
                        status.key === current[index]?.key && status.text === current[index]?.text,
                    )
                  )
                    return;
                  sessionEntity = { ...sessionEntity, extensionStatuses: statuses };
                  yield* updateProviderSession(sessionEntity.status);
                }),
              );
            }
            return result;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (extensionStatusReset === reset) extensionStatusReset = null;
              }),
            ),
          );
        },
        (effect, record) =>
          effect.pipe(
            Effect.tapError((error) =>
              Effect.logWarning("omp session lifecycle request failed", {
                providerSessionId: input.providerSessionId,
                operation: record["type"],
                errorTag: error._tag,
              }),
            ),
            // A failed lifecycle RPC can leave omp's previous native session disposed.
            Effect.tapError((error) =>
              error._tag === "OmpRpcError" || error._tag === "OmpRpcTimeoutError"
                ? connection.terminate
                : Effect.void,
            ),
            Effect.onInterrupt(() => connection.terminate),
          ),
      );

      const tokenUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
        messageUsage: OmpMessageTokenUsage | undefined,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;
        // Stats `tokens` are whole-session totals; the breakdown comes from the turn's last message.
        return { usedTokens, maxTokens, ...messageUsage, updatedAt: DateTime.formatIso(updatedAt) };
      };

      const readTokenUsage = (turn: ActiveOmpTurn, updatedAt: DateTime.Utc) =>
        request({ type: "get_session_stats" }, 2_000).pipe(
          Effect.map((stats) =>
            tokenUsageFromStats(
              stats,
              turn.latestCompactionAfterTokens,
              turn.lastMessageUsage,
              updatedAt,
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        );

      /**
       * omp attaches the current message's cumulative usage to every streaming update (0.84.2+).
       */
      const reportLiveUsage =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActiveOmpTurn, usage: unknown) {
          const usedTokens = nonNegativeInteger(usage, "totalTokens");
          if (usedTokens !== undefined && usedTokens > 0) {
            turn.lastMessageUsage = ompMessageTokenUsage(usage);
          }
          if (
            usedTokens === undefined ||
            usedTokens === 0 ||
            usedTokens === turn.lastLiveUsedTokens ||
            contextWindow === null ||
            contextWindow === 0
          ) {
            return;
          }
          turn.lastLiveUsedTokens = usedTokens;
          const updatedAt = yield* DateTime.now;
          yield* emit({
            type: "provider_turn.updated",
            driver: OMP_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              tokenUsage: {
                usedTokens,
                maxTokens: contextWindow,
                ...turn.lastMessageUsage,
                updatedAt: DateTime.formatIso(updatedAt),
              },
            },
          });
        });

      const baseItemFields = (
        target: OmpItemTarget,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
        parentNativeItemId?: string,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: OMP_PROVIDER,
          nativeItemId,
        }),
        threadId: target.threadId,
        runId: target.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: OMP_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: target.providerThreadId,
        providerTurnId: target.providerTurnId,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId:
          parentNativeItemId === undefined
            ? null
            : idAllocator.derive.turnItemFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: parentNativeItemId,
              }),
        ordinal: itemOrdinal(target, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        target: OmpItemTarget,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
        parentNativeItemId?: string,
      ) =>
        emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId,
            }),
            threadId: target.threadId,
            runId: target.runId,
            parentNodeId:
              parentNativeItemId === undefined
                ? target.rootNodeId
                : idAllocator.derive.nodeFromProviderItem({
                    driver: OMP_PROVIDER,
                    nativeItemId: parentNativeItemId,
                  }),
            rootNodeId: target.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: target.providerThreadId,
            providerTurnId: target.providerTurnId,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      const emitProviderRetry = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        providerRetry: OmpProviderRetryState,
        status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        updatedAt: DateTime.Utc,
      ) {
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: makeProviderRetryTurnItem({
            driver: OMP_PROVIDER,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: turn.turnInput.rootNodeId,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: providerRetry.itemOrdinal,
            failure: providerRetry.failure,
            retry: providerRetry.retry,
            status,
            startedAt: providerRetry.startedAt,
            updatedAt,
          }),
        });
      });

      const compactionNativeItemId = (turn: ActiveOmpTurn): string =>
        `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

      const emitCompaction = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        compaction: OmpCompactionState,
        status: OmpCompactionStatus,
        details: {
          readonly summary?: string;
          readonly beforeTokenCount?: number;
          readonly afterTokenCount?: number;
        } = {},
      ) {
        const emittedAt = yield* DateTime.now;
        const completedAt = status === "running" ? null : emittedAt;
        yield* emitItemNode(
          turn,
          compaction.nativeItemId,
          "system",
          status,
          compaction.startedAt,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
            status,
            title: compactionTitle(status),
            completedAt,
            type: "compaction",
            driver: OMP_PROVIDER,
            ...details,
          },
        });
      });

      const emitStreamItem =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          target: OmpItemTarget,
          item: OmpStreamItemState,
          streaming: boolean,
        ) {
          item.published = true;
          const emittedAt = yield* DateTime.now;
          const base = baseItemFields(target, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            target,
            item.nativeItemId,
            item.kind,
            streaming ? "running" : "completed",
            item.startedAt,
            streaming ? null : emittedAt,
          );
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming,
              },
            });
            yield* emit({
              type: "message.updated",
              driver: OMP_PROVIDER,
              message: {
                id: messageId,
                threadId: target.threadId,
                runId: target.runId,
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: OMP_PROVIDER,
                  nativeItemId: item.nativeItemId,
                }),
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt: emittedAt,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...base,
              status: streaming ? "running" : "completed",
              title: null,
              completedAt: streaming ? null : emittedAt,
              type: "reasoning",
              text: item.text,
              streaming,
            },
          });
        });

      const scheduleStreamFlush =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (target: OmpItemTarget, item: OmpStreamItemState) {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(target, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemId = (target: OmpItemTarget, contentIndex: number) =>
        `${target.streamKey}:m${target.messageOrdinal}:c${contentIndex}`;

      const streamItemFor = Effect.fnUntraced(function* (
        target: OmpItemTarget,
        kind: OmpStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = streamItemId(target, contentIndex);
        const existing = target.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: OmpStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          published: false,
          startedAt,
        };
        target.streamItems.set(nativeItemId, item);
        itemOrdinal(target, nativeItemId);
        return item;
      });

      const completeStreamItem = (target: OmpItemTarget, item: OmpStreamItemState, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          // A block that was shown and then started again empty still replaces what it showed.
          return item.text.length === 0 && !item.published
            ? Effect.void
            : emitStreamItem(target, item, false);
        });

      const completeOpenStreamItems = (target: OmpItemTarget) =>
        Effect.forEach(
          Array.from(target.streamItems.values()).filter((item) => !item.completed),
          (item) => completeStreamItem(target, item),
          { discard: true },
        );

      const applyAssistantDelta =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (target: OmpItemTarget, delta: unknown) {
          const deltaType = recordString(delta, "type");
          const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
          if (deltaType === "text_start" || deltaType === "thinking_start") {
            // A provider that reconnects mid-block starts it again; its earlier text is abandoned.
            const restarted = target.streamItems.get(streamItemId(target, contentIndex));
            if (restarted !== undefined && !restarted.completed) restarted.text = "";
            return;
          }
          if (deltaType === "text_delta" || deltaType === "thinking_delta") {
            const item = yield* streamItemFor(
              target,
              deltaType === "text_delta" ? "assistant_message" : "reasoning",
              contentIndex,
            );
            item.text += recordString(delta, "delta") ?? "";
            yield* scheduleStreamFlush(target, item);
            return;
          }
          if (deltaType === "text_end" || deltaType === "thinking_end") {
            const item = yield* streamItemFor(
              target,
              deltaType === "text_end" ? "assistant_message" : "reasoning",
              contentIndex,
            );
            yield* completeStreamItem(
              target,
              item,
              recordString(delta, "content") ?? recordString(delta, "thinking"),
            );
          }
        });

      // omp resends the whole output tail on every update; stored snapshots grow quadratically.
      const emitCommandOutputDelta = (target: OmpItemTarget, toolCallId: string, result: unknown) =>
        Effect.suspend(() => {
          const text = contentText(recordField(result, "content"));
          const tail = Buffer.from(text, "utf8");
          const totalBytes =
            recordNumber(recordField(recordField(result, "details"), "truncation"), "totalBytes") ??
            tail.length;
          const previousBytes = target.commandOutputBytes.get(toolCallId) ?? 0;
          target.commandOutputBytes.set(toolCallId, totalBytes);
          if (totalBytes <= previousBytes) return Effect.void;
          let start = Math.max(0, tail.length - (totalBytes - previousBytes));
          while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
          const chunk = tail.subarray(start).toString("utf8");
          if (chunk.length === 0) return Effect.void;
          return emit({
            type: "command_output.delta",
            driver: OMP_PROVIDER,
            threadId: target.threadId,
            itemId: idAllocator.derive.turnItemFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId: target.nativeItemId(toolCallId),
            }),
            chunk,
          });
        });

      // omp mounts host tools as xd:// devices and runs one by writing its JSON arguments there.
      const deviceCall = (toolName: string, args: unknown) => {
        if (toolName !== "write") return undefined;
        const devicePath = recordString(args, "path");
        if (devicePath === undefined || !devicePath.startsWith("xd://")) return undefined;
        const device = devicePath.slice("xd://".length);
        if (device.length === 0) return undefined;
        const content = recordString(args, "content");
        const parsed =
          content === undefined ? undefined : Option.getOrUndefined(decodeSessionLine(content));
        return {
          device,
          input: Predicate.isObject(parsed) ? parsed : content === undefined ? {} : { content },
        };
      };

      // omp's todo tool reports its whole list; one item and plan per target show the latest one.
      const emitTodoList = Effect.fnUntraced(function* (
        target: OmpItemTarget,
        steps: ReadonlyArray<OrchestrationV2PlanStep>,
      ) {
        const emittedAt = yield* DateTime.now;
        const todoList = target.todoList ?? {
          planId: yield* idAllocator.allocate.plan({
            threadId: target.threadId,
            ...(target.runId === null ? {} : { runId: target.runId }),
            driver: OMP_PROVIDER,
          }),
          startedAt: emittedAt,
        };
        target.todoList = todoList;
        const { planId, startedAt } = todoList;
        const nativeItemId = `todo:${target.streamKey}`;
        const base = baseItemFields(target, nativeItemId, startedAt, emittedAt);
        yield* emitItemNode(target, nativeItemId, "todo_list", "completed", startedAt, emittedAt);
        yield* emit({
          type: "plan.updated",
          driver: OMP_PROVIDER,
          plan: {
            id: planId,
            threadId: target.threadId,
            runId: target.runId,
            nodeId: base.nodeId,
            kind: "todo_list",
            status: steps.every((step) => step.status === "completed") ? "completed" : "active",
            steps,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...base,
            status: "completed",
            title: null,
            completedAt: emittedAt,
            type: "todo_list",
            planId,
            steps,
          },
        });
      });

      const emitToolItem = Effect.fnUntraced(function* (
        target: OmpItemTarget,
        event: OmpRpcRecord,
        phase: "start" | "update" | "end",
      ) {
        const toolCallId = recordString(event, "toolCallId");
        if (toolCallId === undefined) return;
        const rawToolName =
          recordString(event, "toolName") ?? target.toolNames.get(toolCallId) ?? "tool";
        // omp tags every phase of a call made from inside another tool, such as eval.
        const parentToolCallId = recordString(event, "parentToolCallId");
        // A detached task keeps reporting progress on its call after the call returned;
        // its subagent card shows that progress.
        if (phase === "update" && (rawToolName === "task" || target.endedToolCalls.has(toolCallId)))
          return;
        if (phase === "end") target.endedToolCalls.add(toolCallId);
        if (phase === "update" && rawToolName === "bash") {
          yield* emitCommandOutputDelta(target, toolCallId, event["partialResult"]);
          return;
        }
        if (phase === "start") {
          target.toolNames.set(toolCallId, rawToolName);
          target.toolArgs.set(toolCallId, event["args"]);
        }
        const rawArgs = event["args"] ?? target.toolArgs.get(toolCallId);
        const device = deviceCall(rawToolName, rawArgs);
        const toolName = device?.device ?? rawToolName;
        const args = device?.input ?? rawArgs;
        const emittedAt = yield* DateTime.now;
        const startedAt = target.toolStartedAt.get(toolCallId) ?? emittedAt;
        target.toolStartedAt.set(toolCallId, startedAt);
        const completed = phase === "end";
        const isError = event["isError"] === true;
        const resultRecord = completed ? event["result"] : event["partialResult"];
        const details = recordField(resultRecord, "details");
        const outputText = contentText(recordField(resultRecord, "content"));
        const status = completed
          ? isError
            ? target.interrupted
              ? "interrupted"
              : "failed"
            : "completed"
          : "running";
        // A successful todo call shows as the target's todo list; a failed one keeps its tool row.
        if (toolName === "todo") {
          const phases = completed && !isError ? recordField(details, "phases") : undefined;
          if (Array.isArray(phases)) {
            yield* emitTodoList(target, ompTodoPlanSteps(phases));
            return;
          }
          if (!completed) return;
        }
        const itemId = target.nativeItemId(toolCallId);
        const parentItemId =
          parentToolCallId === undefined ? undefined : target.nativeItemId(parentToolCallId);
        const base = baseItemFields(target, itemId, startedAt, emittedAt, parentItemId);
        yield* emitItemNode(
          target,
          itemId,
          "tool_call",
          status,
          startedAt,
          completed ? emittedAt : null,
          parentItemId,
        );
        const shared = {
          ...base,
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        if (toolName === "bash") {
          const exitCode = recordNumber(details, "exitCode");
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "command_execution",
              input: recordString(args, "command") ?? "",
              ...(outputText.length > 0 ? { output: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            },
          });
          return;
        }
        if (device === undefined && !isError && (toolName === "edit" || toolName === "write")) {
          // omp's hashline edit input opens with a `[path#hash]` header naming its file.
          const fileName =
            recordString(details, "path") ??
            recordString(args, "path") ??
            /^\[([^\]#\n]+)(?:#[^\]\n]*)?\]/.exec(recordString(args, "input") ?? "")?.[1];
          if (fileName !== undefined) {
            const oldStr = toolName === "edit" ? recordString(details, "oldText") : undefined;
            const newStr =
              toolName === "edit"
                ? recordString(details, "newText")
                : recordString(args, "content");
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...shared,
                title: toolName,
                type: "file_change",
                fileName,
                ...(oldStr === undefined ? {} : { oldStr }),
                ...(newStr === undefined ? {} : { newStr }),
              },
            });
            return;
          }
        }
        const output = ompToolOutput(resultRecord, toolName);
        const readPath = toolName === "read" ? recordString(args, "path")?.trim() : undefined;
        const viewedImagePath =
          readPath &&
          readPath.length <= 4096 &&
          !/[\r\n]/.test(readPath) &&
          isWorkspaceImagePreviewPath(readPath)
            ? readPath
            : undefined;
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName,
            type: "dynamic_tool",
            ...mcpToolPresentation({ toolName }),
            toolName,
            input: args ?? {},
            ...(output === undefined ? {} : { output }),
            ...(viewedImagePath === undefined ? {} : { viewedImagePath }),
          },
        });
      });

      const subagentNativeTaskId = (id: string) => `subagent:${id}`;
      // providerTurn ids whose detached subagents still run, so their background work stays open.
      const backgroundSubagentTurns = new Set<OrchestrationV2ProviderTurn["id"]>();

      const emitOmpSubagent = Effect.fnUntraced(function* (tracked: TrackedOmpSubagent) {
        const key = [
          tracked.status,
          tracked.title,
          tracked.model,
          tracked.progress,
          tracked.prompt.length,
          tracked.result?.length ?? -1,
        ].join("\u0000");
        if (key === tracked.emittedKey) return;
        tracked.emittedKey = key;
        const emittedAt = yield* DateTime.now;
        const owner = tracked.owner;
        const nativeTaskRef = providerRef(subagentNativeTaskId(tracked.id));
        const subagentId = idAllocator.derive.nodeFromProviderItem({
          driver: OMP_PROVIDER,
          nativeItemId: tracked.key,
        });
        const parentItemId =
          tracked.parentToolCallId === undefined
            ? undefined
            : owner.nativeItemId(tracked.parentToolCallId);
        const parentNodeId =
          parentItemId === undefined
            ? owner.rootNodeId
            : idAllocator.derive.nodeFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: parentItemId,
              });
        const completedAt = isSubagentActive(tracked.status) ? null : emittedAt;
        const childThreadId = tracked.child?.appThread.id ?? null;
        const progress = tracked.progress === undefined ? {} : { progress: tracked.progress };
        yield* emitItemNode(
          owner,
          tracked.key,
          "subagent",
          tracked.status,
          tracked.startedAt,
          completedAt,
          parentItemId,
        );
        yield* emit({
          type: "subagent.updated",
          driver: OMP_PROVIDER,
          subagent: {
            id: subagentId,
            threadId: owner.threadId,
            runId: owner.runId,
            parentNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: OMP_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: owner.providerThreadId,
            childThreadId,
            nativeTaskRef,
            prompt: tracked.prompt,
            title: tracked.title,
            model: tracked.model,
            status: tracked.status,
            ...progress,
            result: tracked.result,
            startedAt: tracked.startedAt,
            completedAt,
            updatedAt: emittedAt,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...baseItemFields(owner, tracked.key, tracked.startedAt, emittedAt),
            status: tracked.status,
            title: tracked.title ?? tracked.agent,
            completedAt,
            type: "subagent",
            subagentId,
            origin: "provider_native",
            driver: OMP_PROVIDER,
            providerInstanceId: options.instanceId,
            childThreadId,
            prompt: tracked.prompt,
            ...progress,
            result: tracked.result,
          },
        });
        if (tracked.child === null) return;
        // A provider-native child thread has no run; its root node carries the subagent's status.
        const child = tracked.child.target;
        yield* emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: {
            id: child.rootNodeId,
            threadId: child.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: child.rootNodeId,
            kind: "root_turn",
            status: tracked.status,
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: nativeTaskRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: tracked.startedAt,
            completedAt,
          },
        });
      });

      // The final answer lives in the subagent's transcript; the lifecycle frame only says it ended.
      const readSubagentResult = (id: string) =>
        request({ type: "get_subagent_messages", subagentId: id }, 5_000).pipe(
          Effect.map((data) => {
            const messages = recordField(data, "messages");
            if (!Array.isArray(messages)) return null;
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              const message = messages[index];
              if (recordString(message, "role") !== "assistant") continue;
              const text = contentText(recordField(message, "content")).trim();
              if (text.length > 0) return text.slice(0, MAX_SUBAGENT_RESULT_CHARS);
            }
            return null;
          }),
          Effect.orElseSucceed(() => null),
        );

      const settleSubagentBackgroundWork = Effect.fnUntraced(function* (
        providerTurnId: OrchestrationV2ProviderTurn["id"],
      ) {
        if (!backgroundSubagentTurns.has(providerTurnId)) return;
        for (const other of ompSubagents.values()) {
          if (other.turn.providerTurn.id === providerTurnId && isSubagentActive(other.status))
            return;
        }
        backgroundSubagentTurns.delete(providerTurnId);
        yield* emit({
          type: "background_work.updated",
          driver: OMP_PROVIDER,
          providerTurnId,
          pending: false,
        });
      });

      const handleSubagentLifecycle = Effect.fnUntraced(function* (payload: unknown) {
        const id = recordString(payload, "id");
        if (id === undefined) return;
        const lifecycleStatus = recordString(payload, "status");
        const description = recordString(payload, "description");
        if (lifecycleStatus === "started") {
          if (ompSubagents.has(id)) return;
          // omp names a nested subagent `<parent id>.<name>`; it lives in its parent's child thread.
          const dot = id.lastIndexOf(".");
          const parent = dot < 0 ? undefined : ompSubagents.get(id.slice(0, dot));
          const turn = dot < 0 ? (threadState?.activeTurn ?? null) : (parent?.turn ?? null);
          const owner = dot < 0 ? turn : (parent?.child?.target ?? null);
          if (turn === null || owner === null) return;
          const key = `${turn.providerTurn.id}:subagent:${id}`;
          const startedAt = yield* DateTime.now;
          const title = description ?? id;
          // T3 adopts a new child thread only while the root turn that owns it runs.
          let child: OmpSubagentThread | null = null;
          if (threadState?.activeTurn === turn) {
            const parentThread = parent?.child?.appThread ?? turn.turnInput.appThread;
            const childThreadId = idAllocator.derive.subagentThread({
              driver: OMP_PROVIDER,
              providerInstanceId: options.instanceId,
              nativeThreadId: key,
            });
            child = {
              target: {
                threadId: childThreadId,
                runId: null,
                rootNodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: OMP_PROVIDER,
                  nativeItemId: `${key}:root`,
                }),
                providerThreadId: null,
                providerTurnId: null,
                // Tool call ids are only unique within one session.
                nativeItemId: (nativeId) => `${key}:${nativeId}`,
                streamKey: key,
                itemOrdinals: new Map(),
                nextItemOrdinal: 1,
                messageOrdinal: 0,
                streamItems: new Map(),
                toolNames: new Map(),
                toolArgs: new Map(),
                toolStartedAt: new Map(),
                commandOutputBytes: new Map(),
                endedToolCalls: new Set(),
                interrupted: false,
                todoList: null,
              },
              appThread: makeSubagentChildThread({
                parentThread,
                childThreadId,
                parentNodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: OMP_PROVIDER,
                  nativeItemId: key,
                }),
                activeProviderThreadId: null,
                providerInstanceId: options.instanceId,
                modelSelection: parentThread.modelSelection,
                title: subagentThreadTitle({
                  parentTitle: parentThread.title,
                  title,
                  prompt: "",
                  ordinal: ompSubagents.size + 1,
                }),
                now: startedAt,
                createdBy: "agent",
                creationSource: "provider",
              }),
            };
            yield* emit({
              type: "app_thread.created",
              driver: OMP_PROVIDER,
              appThread: child.appThread,
            });
          }
          const tracked: TrackedOmpSubagent = {
            id,
            turn,
            owner,
            key,
            parentToolCallId: recordString(payload, "parentToolCallId"),
            startedAt,
            child,
            agent: recordString(payload, "agent") ?? "task",
            prompt: "",
            title,
            model: null,
            status: "running",
            progress: undefined,
            result: null,
            emittedKey: "",
          };
          ompSubagents.set(id, tracked);
          // A detached subagent outlives the task call; keep ingesting until it ends.
          if (recordField(payload, "detached") === true) {
            if (!backgroundSubagentTurns.has(turn.providerTurn.id)) {
              backgroundSubagentTurns.add(turn.providerTurn.id);
              yield* emit({
                type: "background_work.updated",
                driver: OMP_PROVIDER,
                providerTurnId: turn.providerTurn.id,
                pending: true,
              });
            }
          }
          yield* emitOmpSubagent(tracked);
          return;
        }
        const tracked = ompSubagents.get(id);
        if (tracked === undefined) return;
        tracked.status = ompSubagentStatus(lifecycleStatus);
        if (description !== undefined) tracked.title = description;
        if (isSubagentActive(tracked.status)) {
          yield* emitOmpSubagent(tracked);
          return;
        }
        ompSubagents.delete(id);
        tracked.progress = undefined;
        if (tracked.child !== null) {
          // Its session ended, so whatever it left open was cut off.
          const target = tracked.child.target;
          target.interrupted = true;
          yield* completeOpenStreamItems(target);
          for (const [toolCallId, toolName] of target.toolNames) {
            if (target.endedToolCalls.has(toolCallId)) continue;
            yield* emitToolItem(target, { toolCallId, toolName, isError: true }, "end");
          }
        }
        if (tracked.status === "completed" || tracked.status === "failed") {
          tracked.result = (yield* readSubagentResult(id)) ?? tracked.result;
        }
        yield* emitOmpSubagent(tracked);
        yield* settleSubagentBackgroundWork(tracked.turn.providerTurn.id);
      });

      const handleSubagentProgress = Effect.fnUntraced(function* (payload: unknown) {
        const progress = recordField(payload, "progress");
        const id = recordString(progress, "id");
        const tracked = id === undefined ? undefined : ompSubagents.get(id);
        if (tracked === undefined) return;
        tracked.prompt =
          recordString(payload, "assignment") ?? recordString(payload, "task") ?? tracked.prompt;
        tracked.title = recordString(progress, "description") ?? tracked.title;
        const model =
          recordString(progress, "resolvedModel") ??
          recordString(progress, "resolvedModelIdentity") ??
          tracked.model;
        if (model !== null && model !== tracked.model && tracked.child !== null) {
          // Show the model the subagent runs; app_thread.created on an existing thread updates it.
          const selector = parseOmpModelSelector(model);
          tracked.child.appThread = {
            ...tracked.child.appThread,
            modelSelection: {
              instanceId: options.instanceId,
              model: selector.model,
              ...(selector.thinking === undefined
                ? {}
                : { options: [{ id: "thinking", value: selector.thinking }] }),
            },
            updatedAt: yield* DateTime.now,
          };
          yield* emit({
            type: "app_thread.created",
            driver: OMP_PROVIDER,
            appThread: tracked.child.appThread,
          });
        }
        tracked.model = model;
        const status = ompSubagentStatus(recordString(progress, "status"));
        // Lifecycle frames own the terminal status and its result.
        if (isSubagentActive(status)) tracked.status = status;
        const recentOutput = recordField(progress, "recentOutput");
        const latest =
          recordString(progress, "lastIntent") ??
          (Array.isArray(recentOutput) && typeof recentOutput.at(-1) === "string"
            ? (recentOutput.at(-1) as string)
            : undefined);
        tracked.progress =
          latest === undefined ? tracked.progress : latest.slice(0, MAX_SUBAGENT_PROGRESS_CHARS);
        yield* emitOmpSubagent(tracked);
      });

      // At subscription level "events" omp forwards each subagent's own session; its child thread shows it.
      const handleSubagentEvent = Effect.fnUntraced(function* (payload: unknown) {
        const id = recordString(payload, "id");
        const tracked = id === undefined ? undefined : ompSubagents.get(id);
        const event = recordField(payload, "event");
        if (tracked?.child == null || !Predicate.isObject(event)) return;
        const target = tracked.child.target;
        switch (event["type"]) {
          case "message_start":
            if (recordString(event["message"], "role") === "assistant") target.messageOrdinal += 1;
            return;
          case "message_update":
            yield* applyAssistantDelta(target, event["assistantMessageEvent"]);
            return;
          case "message_end": {
            const message = event["message"];
            const role = recordString(message, "role");
            if (role === "assistant") {
              yield* completeOpenStreamItems(target);
              return;
            }
            // The task and steers from its parent; omp's own reminders are synthetic.
            if (role !== "user" || recordField(message, "synthetic") === true) return;
            const text = contentText(recordField(message, "content")).trim();
            if (text.length === 0) return;
            const nativeItemId = `${target.streamKey}:user:${target.nextItemOrdinal}`;
            const artifacts = makeSubagentConversationArtifacts({
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId,
              }),
              senderThreadId: tracked.owner.threadId,
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId,
              }),
              threadId: target.threadId,
              rootNodeId: target.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: providerRef(nativeItemId, "weak"),
              role: "user",
              text,
              ordinal: itemOrdinal(target, nativeItemId),
              now: yield* DateTime.now,
            });
            yield* emit({
              type: "message.updated",
              driver: OMP_PROVIDER,
              message: artifacts.message,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            return;
          }
          case "tool_execution_start":
            yield* emitToolItem(target, event, "start");
            return;
          case "tool_execution_update":
            yield* emitToolItem(target, event, "update");
            return;
          case "tool_execution_end":
            yield* emitToolItem(target, event, "end");
            return;
        }
      });

      const handleHostToolCall = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        const id = recordString(event, "id");
        const toolName = recordString(event, "toolName");
        if (id === undefined || toolName === undefined) return;
        const activeConnection = connection;
        const args = recordField(event, "arguments");
        const call =
          hostTools === null || !toolName.startsWith(OMP_T3_MCP_TOOL_PREFIX)
            ? Effect.succeed({
                result: { content: [{ type: "text", text: `Tool ${toolName} is unavailable.` }] },
                isError: true,
              })
            : hostTools.call(toolName, Predicate.isObject(args) ? args : {}).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    result: { content: [{ type: "text", text: error.message }] },
                    isError: true,
                  }),
                ),
              );
        const fiber = yield* call.pipe(
          Effect.flatMap((outcome) =>
            activeConnection.send({
              type: "host_tool_result",
              id,
              result: outcome.result,
              ...(outcome.isError ? { isError: true } : {}),
            }),
          ),
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => hostToolCalls.delete(id))),
          Effect.forkIn(scope),
        );
        hostToolCalls.set(id, fiber);
      });

      const cancelPrompt = Effect.fn("OmpAdapter.cancelPrompt")(function* (
        pending: PendingOmpPrompt,
        resolvedAt: DateTime.Utc,
        expired = false,
      ) {
        if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
        yield* connection
          .send({
            type: "extension_ui_response",
            id: pending.nativeRequestId,
            cancelled: true,
            // omp answers a timed-out ask or form with its own defaults.
            ...(expired && (pending.method === "ask" || pending.method === "form")
              ? { timedOut: true }
              : {}),
          })
          .pipe(Effect.ignore);
        pending.runtimeRequest = {
          ...pending.runtimeRequest,
          status: "cancelled",
          resolvedAt,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: OMP_PROVIDER,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        yield* emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...pending.turnItem,
            status: "cancelled",
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
      });

      const cancelPendingPrompts = Effect.fn("OmpAdapter.cancelPendingPrompts")(function* (
        resolvedAt: DateTime.Utc,
      ) {
        const pending = Array.from(pendingPrompts.values());
        pendingPrompts.clear();
        yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
          discard: true,
        });
      });

      const emitSystemNotice = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        nativeItemId: string,
        message: string,
        level?: "info" | "warning" | "error",
      ) {
        const emittedAt = yield* DateTime.now;
        yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "completed",
            completedAt: emittedAt,
            title: message,
            type: "system_notice",
            message,
            ...(level === undefined ? {} : { level }),
          },
        });
      });

      // Abort alone leaves queued steers and follow-ups for omp's next prompt; Stop withdraws them.
      const abortNative = Effect.fnUntraced(function* (turn: ActiveOmpTurn, timeoutMs?: number) {
        const data = yield* request({ type: "abort_and_restore_queue" }, timeoutMs);
        const withdrawn = ["steering", "followUp"].flatMap((key) => {
          const entries = recordField(data, key);
          return Array.isArray(entries)
            ? entries.flatMap((entry) => {
                const text = typeof entry === "string" ? entry : recordString(entry, "text");
                return text === undefined ? [] : [text];
              })
            : [];
        });
        if (withdrawn.length === 0) return;
        yield* sessionEventPermit.withPermits(1)(
          threadState?.activeTurn === turn
            ? emitSystemNotice(
                turn,
                `queue-cleared:${turn.providerTurn.id}`,
                [
                  `Stop cleared ${withdrawn.length} queued ${withdrawn.length === 1 ? "message" : "messages"} omp had not read:`,
                  // Image-only messages come back as empty text.
                  ...withdrawn.filter((text) => text.length > 0),
                ]
                  .join("\n\n")
                  .slice(0, 2_000),
              )
            : Effect.void,
        );
      });

      const handleExtensionUiRequest = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        const method = recordString(event, "method");
        const nativeRequestId = recordString(event, "id");
        if (method === undefined) return;
        if (method === "notify") {
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          const message = recordString(event, "message") ?? "";
          if (turn === null || message.length === 0) return;
          const notifyType = recordString(event, "notifyType");
          yield* emitSystemNotice(
            turn,
            `notify:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
            message,
            notifyType === "warning" || notifyType === "error" ? notifyType : "info",
          );
          return;
        }
        if (method === "cancel") {
          // omp withdrew a dialog it no longer needs, such as one whose tool call was aborted.
          const targetId = recordString(event, "targetId");
          const entry = Array.from(pendingPrompts.entries()).find(
            ([, pending]) => pending.nativeRequestId === targetId,
          );
          if (entry === undefined) return;
          pendingPrompts.delete(entry[0]);
          yield* cancelPrompt(entry[1], yield* DateTime.now);
          return;
        }
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor" &&
          method !== "ask" &&
          method !== "form"
        ) {
          yield* Effect.logDebug("Ignoring omp extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        const title = recordString(event, "title") ?? method;
        const options = Array.isArray(event["options"])
          ? event["options"].filter((option): option is string => typeof option === "string")
          : [];
        const approval = method === "select" ? ompApprovalPrompt(title, options) : undefined;
        const approvalKey = `${title.length}:${title}${recordString(event, "message") ?? ""}`;
        if (method === "confirm" && sessionApprovals.has(approvalKey)) {
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            confirmed: true,
          });
          return;
        }
        const isApproval = method === "confirm" || approval !== undefined;
        const askQuestions =
          method === "ask" ? ompAskQuestions(recordField(event, "questions")) : undefined;
        const form =
          method === "form" ? parseOmpHtmlForm(recordString(event, "html") ?? "") : undefined;
        // omp needs every question answered, so a dialog T3 cannot show is declined at once.
        if (
          (method === "ask" && askQuestions === undefined) ||
          (method === "form" && form === undefined)
        ) {
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            cancelled: true,
          });
          return;
        }
        const structuredQuestions = askQuestions ?? form?.questions ?? [];
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        const createdAt = yield* DateTime.now;
        const timeout = recordNumber(event, "timeout");
        // omp treats zero as no timeout and negative durations as immediate expiry.
        const expiresAt =
          timeout === undefined || timeout === 0
            ? null
            : DateTime.toEpochMillis(createdAt) + Math.max(0, timeout);
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: OMP_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const threadId =
          turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const requestKind = approval?.kind ?? "command";
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: isApproval ? requestKind : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: isApproval ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const turnItem: OrchestrationV2TurnItem =
          approval !== undefined
            ? {
                ...itemBase,
                title: `Allow ${approval.toolName}?`,
                type: "approval_request",
                requestId,
                requestKind: approval.kind,
                // The first line repeats the tool name the title already shows.
                prompt: title.split("\n").slice(1).join("\n").trim() || title,
                ...(input.runtimePolicy.runtimeMode === "full-access"
                  ? { fullAccessOverride: "provider_check" as const }
                  : {}),
                options: [
                  { decision: "accept", label: approval.choices.once },
                  ...(approval.choices.session === undefined
                    ? []
                    : [{ decision: "acceptForSession" as const, label: approval.choices.session }]),
                  { decision: "decline", label: approval.choices.deny },
                ],
              }
            : method === "confirm"
              ? {
                  ...itemBase,
                  title,
                  type: "approval_request",
                  requestId,
                  requestKind: "command",
                  prompt: recordString(event, "message") ?? title,
                }
              : {
                  ...itemBase,
                  title:
                    method === "ask" || method === "form"
                      ? (structuredQuestions[0]?.header ?? "Question")
                      : title,
                  type: "user_input_request",
                  requestId,
                  questions:
                    method === "ask" || method === "form"
                      ? structuredQuestions
                      : [ompQuestion(nativeRequestId, method, title, event)],
                };
        const pending: PendingOmpPrompt = {
          nativeRequestId,
          method,
          questionId: nativeRequestId,
          approvalKey,
          expiresAt,
          expirationFiber: null,
          runtimeRequest,
          node,
          turnItem,
          approval: approval?.choices,
          askQuestions,
          form,
        };
        pendingPrompts.set(String(requestId), pending);
        yield* emit({
          type: "runtime_request.updated",
          driver: OMP_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: OMP_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: OMP_PROVIDER, turnItem });
        if (expiresAt !== null) {
          const now = yield* DateTime.now;
          pending.expirationFiber = yield* Effect.sleep(
            Duration.millis(Math.max(0, expiresAt - DateTime.toEpochMillis(now))),
          ).pipe(
            Effect.andThen(
              Queue.offer(connection.events, {
                type: "t3.ui_request_expired",
                requestId: String(requestId),
                pending,
              }),
            ),
            Effect.asVoid,
            Effect.forkIn(scope),
          );
        }
      });

      const emitExtensionError = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null) {
          outOfTurnExtensionErrors.push(event);
          return;
        }
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `extension-error:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;
        const extensionName = ompExtensionDisplayName(recordString(event, "extensionPath"));
        const extensionEvent = recordString(event, "event");
        const detail = recordString(event, "error")?.trim();
        const message = [
          `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
          detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n");
        const failure = makeProviderFailure({
          message,
          class: "provider_error",
          retryable: false,
        });
        yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "failed",
            title: extensionName,
            completedAt: emittedAt,
            type: "error",
            failure,
          },
        });
      });

      const listSessionEntries = (since: string | null, timeoutMs: number) =>
        request({ type: "get_entries", ...(since === null ? {} : { since }) }, timeoutMs).pipe(
          Effect.map(ompSessionListing),
          Effect.orElseSucceed(() => null),
        );

      // get_entries includes abandoned branches in append order; follow leaf parentId ancestry instead.
      const captureTurnTreeRefs = Effect.fnUntraced(function* (
        timeoutMs = OMP_REQUEST_TIMEOUT_MS,
      ): Effect.fn.Return<OmpTurnTreeRefs | null> {
        const cursorWasStale = leafCursorStale;
        const previousLeaf = lastKnownLeaf;
        const fullListing = cursorWasStale || previousLeaf === null;
        const listing = yield* listSessionEntries(fullListing ? null : previousLeaf, timeoutMs);
        const turnWalk =
          listing === null ? null : walkOmpBranch(listing.entries, listing.leafId, previousLeaf);
        const rewound = turnWalk !== null && previousLeaf !== null && !turnWalk.reachedStop;
        // since ends at the previous leaf; rewound ancestry requires the whole tree.
        const tree = rewound && !fullListing ? yield* listSessionEntries(null, timeoutMs) : listing;
        if (listing === null || turnWalk === null || tree === null) {
          leafCursorStale = true;
          return null;
        }
        lastKnownLeaf = listing.leafId;
        leafCursorStale = false;
        const turnStartEntryId = turnWalk.userEntryIds.at(-1);
        // Only a complete acyclic root walk proves all survivors.
        // The old leaf must remain in this tree to prove rewind rather than session replacement.
        const branch =
          rewound && previousLeaf !== null && tree.entries.has(previousLeaf)
            ? walkOmpBranch(tree.entries, listing.leafId, null)
            : undefined;
        return {
          // Stale cursors span earlier turns; keep a synthetic ref to avoid rolling back too far.
          nativeTurnRef: cursorWasStale
            ? undefined
            : turnStartEntryId !== undefined
              ? providerRef(turnStartEntryId)
              : turnWalk.entryCount === 0
                ? null
                : undefined,
          leafId: listing.leafId,
          retainedNativeTurnIds: branch?.reachedStop === true ? branch.userEntryIds : undefined,
        };
      });

      const finalizeTurn = Effect.fnUntraced(function* (state: OmpThreadState, readUsage = true) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        const interrupted = turn.interrupted || turn.nativeAborted;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        if (turn.activeCompaction !== null) {
          const status = interrupted ? "cancelled" : turn.failure === null ? "completed" : "failed";
          yield* emitCompaction(turn, turn.activeCompaction, status);
          turn.activeCompaction = null;
        }
        if (turn.activeProviderRetry !== null) {
          if (interrupted) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
            turn.activeProviderRetry = null;
          } else if (turn.failure === null) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
            turn.activeProviderRetry = null;
          }
        }
        yield* cancelPendingPrompts(completedAt);
        // Stop clears omp's queue, so an unread steer was dropped; otherwise omp read it before settling.
        for (const messageId of turn.unreadSteers.splice(0)) {
          yield* emitSteerStatus(turn, messageId, interrupted ? "cancelled" : "completed");
        }
        const treeRefs =
          turn.stopTreeRefs !== undefined ? turn.stopTreeRefs : yield* captureTurnTreeRefs();
        const tokenUsage = readUsage ? yield* readTokenUsage(turn, completedAt) : undefined;
        const failure = interrupted ? null : (turn.rejectedPromptFailure ?? turn.failure);
        yield* emit({
          type: "provider_turn.updated",
          driver: OMP_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(treeRefs === null || treeRefs.nativeTurnRef === undefined
              ? {}
              : { nativeTurnRef: treeRefs.nativeTurnRef }),
            ...(state.providerThread.nativeThreadRef === null
              ? {}
              : { nativeThreadRef: state.providerThread.nativeThreadRef }),
            status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            ...(turn.reportedModel === undefined ? {} : { model: turn.reportedModel }),
          },
        });
        yield* updateProviderThread(
          state,
          {
            status: "idle",
            ...(treeRefs === null
              ? {}
              : {
                  nativeConversationHeadRef:
                    treeRefs.leafId === null ? null : providerRef(treeRefs.leafId),
                }),
          },
          treeRefs?.retainedNativeTurnIds,
        );
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          if (turn.activeProviderRetry !== null) {
            yield* emitProviderRetry(
              turn,
              { ...turn.activeProviderRetry, failure },
              "failed",
              completedAt,
            );
          } else {
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...baseItemFields(turn, failureItemId, completedAt, completedAt),
                status: "failed",
                title: null,
                completedAt,
                type: "error",
                failure,
              },
            });
          }
          yield* emit({
            type: "turn.terminal",
            driver: OMP_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            ...(turn.activeProviderRetry === null
              ? {}
              : {
                  retry: turn.activeProviderRetry.retry,
                  retryStartedAt: turn.activeProviderRetry.startedAt,
                }),
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: OMP_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }
      });

      // Extensions can move omp to another session file (ctx.newSession); resume that one.
      const adoptLiveSessionFile = (state: OmpThreadState, stateData: unknown) => {
        const sessionFile = recordString(stateData, "sessionFile");
        const previousFile = state.providerThread.nativeThreadRef?.nativeId;
        if (sessionFile === undefined || sessionFile === previousFile) return;
        if (previousFile != null) state.supersededSessionFiles.add(previousFile);
        state.supersededSessionFiles.delete(sessionFile);
        state.providerThread = {
          ...state.providerThread,
          nativeThreadRef: providerRef(sessionFile),
        };
        lastNativeThreadId = sessionFile;
      };

      const scheduleSettleProbe = (
        turn: ActiveOmpTurn,
        settleAfterAgentActivity = false,
        attempt = 1,
      ) => {
        const providerTurnId = turn.providerTurn.id;
        const settleProbeGeneration = turn.settleProbeGeneration;
        return request({ type: "get_state" }, 2_000).pipe(
          Effect.matchEffect({
            onSuccess: (data) =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                data,
              }),
            // Failed probes must reach the pump; command-only turns emit no agent events to settle them.
            onFailure: () =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                probeFailed: true,
              }),
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      };

      const stopPendingWake = Effect.fnUntraced(function* (wake: OmpWake) {
        if (pendingWake !== wake || threadState !== wake.state || closed) return;
        pendingWake = null;
        stopRequested = true;
        yield* cancelPendingPrompts(yield* DateTime.now);
        yield* connection.terminate;
      });

      const handleSessionEvent = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        if (event["type"] === "t3.extension_status_reset") {
          const reset = extensionStatusReset;
          if (reset !== null && event["reset"] === reset) {
            reset.previous = sessionEntity.extensionStatuses ?? [];
            reset.touched.clear();
            yield* clearExtensionStatuses();
            yield* Deferred.succeed(reset.ready, undefined);
          }
          return;
        }
        // A native wake may wait for a turn owner; status belongs to the live session immediately.
        if (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {
          yield* updateExtensionStatus(event);
          return;
        }
        // Host tool calls answer omp directly and may run before any turn owns the session.
        if (event["type"] === "host_tool_call") {
          yield* handleHostToolCall(event);
          return;
        }
        if (event["type"] === "host_tool_cancel") {
          const targetId = recordString(event, "targetId");
          const fiber = targetId === undefined ? undefined : hostToolCalls.get(targetId);
          if (targetId !== undefined && fiber !== undefined) {
            hostToolCalls.delete(targetId);
            yield* Fiber.interrupt(fiber).pipe(Effect.forkIn(scope));
          }
          return;
        }
        // Model hooks can show dialogs before turn ownership; keep requests session-scoped and buffer output.
        const interactiveUiRequest =
          event["type"] === "extension_ui_request" &&
          ["select", "confirm", "input", "editor", "ask", "form", "cancel"].includes(
            String(event["method"]),
          );
        if (
          threadState?.activeTurn === null &&
          pendingWake !== null &&
          !interactiveUiRequest &&
          !String(event["type"]).startsWith("t3.") &&
          event["type"] !== "response"
        ) {
          pendingWake.events.push(event);
          if (event["type"] === "agent_start") yield* updateProviderSession("running", null);
          if (event["type"] === "agent_settled") yield* updateProviderSession("ready", null);
          return;
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        switch (event["type"]) {
          case "agent_start": {
            if (
              turn === null &&
              state?.providerThread.appThreadId != null &&
              continuationRequests !== undefined &&
              !closed &&
              !stopRequested
            ) {
              const wake: OmpWake = { state, events: [event] };
              pendingWake = wake;
              if (rollbackBarrier !== null) {
                yield* stopPendingWake(wake);
                return;
              }
              yield* updateProviderSession("running", null);
              yield* continuationRequests
                .offer({
                  threadId: state.providerThread.appThreadId,
                  providerThreadId: state.providerThread.id,
                  driver: OMP_PROVIDER,
                  detail: null,
                  delivery: "adapter_buffered",
                  dispatchIfCurrent: (dispatch) =>
                    sessionEventPermit.withPermits(1)(
                      Effect.suspend(() =>
                        pendingWake === wake && threadState === state && !closed
                          ? dispatch.pipe(
                              Effect.asSome,
                              Effect.tapError(() => stopPendingWake(wake)),
                            )
                          : Effect.succeedNone,
                      ),
                    ),
                  clearIfCurrent: () => sessionEventPermit.withPermits(1)(stopPendingWake(wake)),
                })
                .pipe(Effect.tapError(() => stopPendingWake(wake)));
              return;
            }
            if (turn === null) {
              unsolicitedActivityDetected = true;
              yield* updateProviderSession("error", OMP_UNSOLICITED_ACTIVITY_ERROR);
              yield* connection.terminate;
              return;
            }
            turn.sawAgentActivity = true;
            turn.nativeAborted = false;
            turn.lastAssistantAborted = false;
            turn.settleProbeGeneration += 1;
            return;
          }
          case "message_start": {
            const role = recordString(event["message"], "role");
            if (turn !== null && role === "assistant") {
              turn.sawAgentActivity = true;
              turn.messageOrdinal += 1;
            }
            const readSteer = role === "user" ? turn?.unreadSteers.shift() : undefined;
            if (turn !== null && readSteer !== undefined) {
              yield* emitSteerStatus(turn, readSteer, "completed");
            }
            return;
          }
          case "message_update": {
            if (turn === null) return;
            turn.sawAgentActivity = true;
            // omp sends auto_retry_end only after the message ends; streamed output is recovery.
            if (turn.activeProviderRetry !== null) {
              const recoveredAt = yield* DateTime.now;
              yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", recoveredAt);
              turn.activeProviderRetry = null;
            }
            yield* reportLiveUsage(turn, event["usage"]);
            yield* applyAssistantDelta(turn, event["assistantMessageEvent"]);
            return;
          }
          case "message_end": {
            if (turn === null) return;
            const message = event["message"];
            if (recordString(message, "role") !== "assistant") return;
            yield* completeOpenStreamItems(turn);
            // Delta updates carry no usage; each finished message reports its own.
            yield* reportLiveUsage(turn, recordField(message, "usage"));
            const reportedProvider = recordString(message, "provider");
            const reportedModelId = recordString(message, "model");
            if (reportedProvider && reportedModelId) {
              turn.reportedModel = `${reportedProvider}/${reportedModelId}`;
            }
            turn.lastAssistantAborted = recordString(message, "stopReason") === "aborted";
            if (recordString(message, "stopReason") === "error" && turn.failure === null) {
              turn.failure = makeProviderFailure({
                message: recordString(message, "errorMessage") ?? "omp reported a model error.",
                class: "provider_error",
              });
            }
            return;
          }
          case "tool_execution_start":
            if (turn !== null) {
              turn.sawAgentActivity = true;
              yield* emitToolItem(turn, event, "start");
            }
            return;
          case "tool_execution_update":
            if (turn !== null) yield* emitToolItem(turn, event, "update");
            return;
          case "tool_execution_end":
            if (turn !== null) yield* emitToolItem(turn, event, "end");
            return;
          case "compaction_start": {
            if (turn === null) return;
            turn.settleProbeGeneration += 1;
            if (turn.activeCompaction !== null) {
              yield* emitCompaction(turn, turn.activeCompaction, "cancelled");
            }
            const startedAt = yield* DateTime.now;
            const compaction = {
              nativeItemId: compactionNativeItemId(turn),
              startedAt,
            } satisfies OmpCompactionState;
            turn.activeCompaction = compaction;
            yield* emitCompaction(turn, compaction, "running");
            return;
          }
          case "compaction_end": {
            if (turn === null) return;
            const observedAt = yield* DateTime.now;
            const compaction = turn.activeCompaction ?? {
              nativeItemId: compactionNativeItemId(turn),
              startedAt: observedAt,
            };
            turn.activeCompaction = null;
            turn.compactionCancelled = event["aborted"] === true;
            const result = event["result"];
            if (result === null || result === undefined) {
              if (event["aborted"] === true) {
                yield* emitCompaction(turn, compaction, "cancelled");
                if (
                  (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                  releasedPromptTurnId !== turn.providerTurn.id
                ) {
                  yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
                }
                return;
              }
              const errorMessage =
                recordString(event, "errorMessage") ?? "omp context compaction failed.";
              yield* emitCompaction(turn, compaction, "failed", {
                summary: errorMessage.slice(0, 1_000),
              });
              if (
                (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                releasedPromptTurnId !== turn.providerTurn.id
              ) {
                yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
              }
              return;
            }
            // Clear overflow failures only when compaction will retry; ordinary compaction must retain exhausted retries.
            if (event["willRetry"] === true) turn.failure = null;
            turn.latestCompactionAfterTokens =
              nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
            const summary = recordString(result, "summary");
            const beforeTokenCount = nonNegativeInteger(result, "tokensBefore");
            const afterTokenCount = nonNegativeInteger(result, "estimatedTokensAfter");
            yield* emitCompaction(turn, compaction, "completed", {
              ...(summary === undefined ? {} : { summary }),
              ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
              ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
            });
            if (
              (turn.settleWhenIdle || !turn.sawAgentActivity) &&
              releasedPromptTurnId !== turn.providerTurn.id
            ) {
              yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          case "auto_retry_start": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const maxAttempts = Math.max(
              attempt,
              Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
            );
            const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
            const failure = makeProviderFailure({
              message: recordString(event, "errorMessage") ?? "omp provider request failed.",
              class: "provider_error",
              retryable: true,
            });
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: { attempt, maxAttempts, retryDelayMs },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies OmpProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            yield* emitProviderRetry(turn, providerRetry, "running", emittedAt);
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            if (event["success"] === true) {
              // Successful retries supersede the failure agent_settled would reuse.
              if (turn.activeProviderRetry !== null) {
                const attempt = Math.max(
                  1,
                  Math.trunc(
                    recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
                  ),
                );
                const recoveredRetry = {
                  ...turn.activeProviderRetry,
                  retry: { ...turn.activeProviderRetry.retry, attempt },
                };
                yield* emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
                turn.activeProviderRetry = null;
              }
              turn.failure = null;
              return;
            }
            const failure = makeProviderFailure({
              message: recordString(event, "finalError") ?? "omp auto-retry failed.",
              class: "provider_error",
              retryable: false,
            });
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: {
                attempt,
                maxAttempts: current?.retry.maxAttempts ?? attempt,
                retryDelayMs: current?.retry.retryDelayMs ?? null,
              },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies OmpProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            turn.failure = failure;
            yield* emitProviderRetry(turn, providerRetry, "failed", emittedAt);
            return;
          }
          case "extension_ui_request":
            yield* handleExtensionUiRequest(event);
            return;
          case "extension_error": {
            yield* emitExtensionError(event);
            return;
          }
          case "subagent_lifecycle":
            yield* handleSubagentLifecycle(event["payload"]);
            return;
          case "subagent_progress":
            yield* handleSubagentProgress(event["payload"]);
            return;
          case "subagent_event":
            yield* handleSubagentEvent(event["payload"]);
            return;
          case "notice": {
            const level = recordString(event, "level");
            const message = recordString(event, "message");
            if (
              turn === null ||
              message === undefined ||
              (level !== "warning" && level !== "error")
            )
              return;
            yield* emitSystemNotice(
              turn,
              `notice:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
              message.slice(0, 2_000),
              level,
            );
            return;
          }
          case "retry_fallback_applied": {
            const from = recordString(event, "from");
            const to = recordString(event, "to");
            if (turn === null || from === undefined || to === undefined) return;
            const role = recordString(event, "role")?.trim();
            const reason = recordString(event, "reason")?.trim();
            const message = `omp switched from ${from} to ${to}${role ? ` (${role})` : ""}`;
            yield* emitSystemNotice(
              turn,
              `retry-fallback:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
              (reason ? `${message}: ${reason}` : message).slice(0, 2_000),
              "warning",
            );
            return;
          }
          case "ttsr_triggered": {
            const rules = event["rules"];
            if (turn === null || !Array.isArray(rules)) return;
            // omp names each injected rule; a rule without a name is known by its file.
            const names = [
              ...new Set(
                rules.flatMap((rule) => {
                  const name =
                    recordString(rule, "name")?.trim() || recordString(rule, "path")?.trim();
                  return name ? [name] : [];
                }),
              ),
            ];
            if (names.length === 0) return;
            const label = names.length === 1 ? "rule" : "rules";
            yield* emitSystemNotice(
              turn,
              `ttsr:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
              `omp applied ${label}: ${names.join(", ")}`.slice(0, 2_000),
              "info",
            );
            return;
          }
          case "prompt_result": {
            // Reports a prompt that failed or ran locally without starting the agent.
            if (turn === null || recordString(event, "id") !== turn.turnStartPromptId) return;
            if (recordString(event, "status") === "error" && turn.failure === null) {
              turn.failure = makeProviderFailure({
                message:
                  recordString(recordField(event, "error"), "message") ?? "omp failed the prompt.",
                class: "provider_error",
                retryable: recordField(recordField(event, "error"), "retryable") === true,
              });
            }
            if (recordField(event, "agentInvoked") === false && !turn.sawAgentActivity) {
              turn.promptMayBeCommandOnly = true;
              yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          case "agent_settled": {
            if (turn?.interrupted === true) {
              if (state === null) return;
              const liveState = yield* request({ type: "get_state" }, 2_000).pipe(
                Effect.orElseSucceed(() => undefined),
              );
              adoptLiveSessionFile(state, liveState);
              yield* finalizeTurn(state);
              return;
            }
            if (turn !== null) {
              turn.nativeAborted = event["aborted"] === true || turn.lastAssistantAborted;
              turn.settleWhenIdle = true;
              turn.settleProbeGeneration += 1;
              if (
                turn.adoptedWake &&
                pendingPromptResponses.some(
                  (pending) =>
                    pending.providerTurnId === turn.providerTurn.id &&
                    pending.kind === "turn_start",
                )
              )
                return;
              yield* scheduleSettleProbe(turn, true);
            }
            return;
          }
          case "response": {
            const command = recordString(event, "command");
            if (command === "compact") {
              const pendingCompact = pendingCompactResponses.shift();
              const compactTurn =
                pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
              if (compactTurn !== null) compactTurn.manualCompactInFlight = false;
              if (event["success"] === true) {
                if (
                  compactTurn !== null &&
                  (compactTurn.settleWhenIdle ||
                    (compactTurn.promptMayBeCommandOnly && !compactTurn.sawAgentActivity))
                ) {
                  yield* scheduleSettleProbe(compactTurn, compactTurn.settleWhenIdle);
                }
                return;
              }
              if (event["success"] !== false) return;
              if (compactTurn === null) return;
              if (compactTurn.activeCompaction !== null) return;
              if (pendingCompact?.kind === "steer") {
                yield* Effect.logWarning("omp rejected a compact steer.", {
                  errorLength: recordString(event, "error")?.length,
                });
                if (
                  compactTurn.settleWhenIdle ||
                  (compactTurn.promptMayBeCommandOnly && !compactTurn.sawAgentActivity)
                ) {
                  yield* scheduleSettleProbe(compactTurn, compactTurn.settleWhenIdle);
                }
                return;
              }
              if (!compactTurn.compactionCancelled) {
                compactTurn.failure = makeProviderFailure({
                  message: recordString(event, "error") ?? "omp compact failed.",
                  class: "provider_error",
                });
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (!compactTurn.sawAgentActivity) {
                yield* scheduleSettleProbe(compactTurn);
              }
              return;
            }
            const responseId = recordString(event, "id");
            const promptIndex =
              command !== "prompt"
                ? -1
                : responseId === undefined
                  ? 0
                  : pendingPromptResponses.findIndex((pending) => pending.id === responseId);
            const pendingPrompt =
              promptIndex < 0 ? undefined : pendingPromptResponses.splice(promptIndex, 1)[0];
            if (
              pendingPrompt !== undefined &&
              pendingPromptResponses.length === 0 &&
              pendingPromptResponsesDrained !== null
            ) {
              yield* Deferred.succeed(pendingPromptResponsesDrained, undefined);
              pendingPromptResponsesDrained = null;
            }
            const responseTurn =
              pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
            if (
              event["success"] === false &&
              nativeCompacting &&
              recordString(event, "error")?.startsWith(OMP_COMPACTING_PROMPT_REJECTION) === true &&
              pendingPrompt !== undefined &&
              responseTurn !== null
            ) {
              heldPrompts.splice(rejectedHeldCount++, 0, pendingPrompt);
              return;
            }
            if (
              event["success"] === true &&
              pendingPrompt?.kind === "turn_start" &&
              responseTurn !== null &&
              recordField(event["data"], "agentInvoked") === false
            ) {
              responseTurn.promptMayBeCommandOnly = true;
            }
            const consumedInputIsIdleCandidate =
              responseTurn !== null &&
              (responseTurn.settleWhenIdle ||
                (responseTurn.promptMayBeCommandOnly && !responseTurn.sawAgentActivity)) &&
              !pendingPromptResponses.some(
                (pending) => pending.providerTurnId === responseTurn.providerTurn.id,
              );
            if (event["success"] === true) {
              // omp acknowledges a steer once queued; the user message that follows marks it read.
              if (
                pendingPrompt?.kind === "steer" &&
                pendingPrompt.messageId !== undefined &&
                responseTurn !== null &&
                recordField(event["data"], "agentInvoked") !== false
              ) {
                responseTurn.unreadSteers.push(pendingPrompt.messageId);
                yield* emitSteerStatus(responseTurn, pendingPrompt.messageId, "pending");
              }
              // Consumed input may never yield; probe idle behind preceding native events.
              if (
                responseTurn !== null &&
                (consumedInputIsIdleCandidate ||
                  (pendingPrompt?.kind === "turn_start" &&
                    responseTurn.adoptedWake &&
                    (responseTurn.settleWhenIdle || responseTurn.promptMayBeCommandOnly)))
              ) {
                yield* scheduleSettleProbe(
                  responseTurn,
                  responseTurn.adoptedWake || responseTurn.settleWhenIdle,
                );
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer" || pendingPrompt?.kind === "steer") {
              // A rejected steer refuses only that message; its target turn keeps running.
              yield* Effect.logWarning("omp rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              if (consumedInputIsIdleCandidate && responseTurn !== null)
                yield* scheduleSettleProbe(responseTurn, responseTurn.settleWhenIdle);
              return;
            }
            const failedTurn =
              command === "prompt" && pendingPrompt?.kind === "turn_start"
                ? responseTurn
                : command === "parse"
                  ? turn
                  : null;
            if (failedTurn !== null) {
              const failure = makeProviderFailure({
                message: recordString(event, "error") ?? "omp rejected the prompt.",
                class: "provider_error",
              });
              if (failedTurn.adoptedWake && command === "prompt") {
                failedTurn.rejectedPromptFailure = failure;
                failedTurn.settleWhenIdle = true;
                yield* scheduleSettleProbe(failedTurn, true);
              } else {
                failedTurn.failure = failure;
                if (state !== null) yield* finalizeTurn(state);
              }
            }
            return;
          }
          case "t3.ui_request_expired": {
            const requestId = recordString(event, "requestId");
            if (requestId === undefined) return;
            const pending = pendingPrompts.get(requestId);
            if (pending === undefined || pending !== event["pending"]) return;
            pendingPrompts.delete(requestId);
            yield* cancelPrompt(pending, yield* DateTime.now, true);
            return;
          }
          case "t3.flush_extension_errors": {
            for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
              yield* emitExtensionError(extensionError);
            }
            return;
          }
          case "t3.rollback_barrier": {
            if (rollbackBarrier !== null && event["barrier"] === rollbackBarrier)
              yield* Deferred.succeed(rollbackBarrier, undefined);
            return;
          }
          case "t3.settle_probe": {
            const data = event["data"];
            const probeFailed = event["probeFailed"] === true;
            const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            if (
              turn === null ||
              turn.providerTurn.id !== event["providerTurnId"] ||
              turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
              (!settleAfterAgentActivity && turn.sawAgentActivity) ||
              turn.activeCompaction !== null
            ) {
              return;
            }
            if (
              turn.manualCompactInFlight ||
              pendingCompactResponses.some(
                (pending) => pending.providerTurnId === turn.providerTurn.id,
              ) ||
              pendingPromptResponses.some(
                (pending) => pending.providerTurnId === turn.providerTurn.id,
              )
            ) {
              turn.settleWhenIdle = true;
              return;
            }
            if (probeFailed) {
              if (!settleAfterAgentActivity) {
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
                yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
                  Effect.andThen(scheduleSettleProbe(turn, true, attempt + 1)),
                  Effect.forkIn(scope),
                );
                return;
              }
              stopRequested = true;
              yield* connection.terminate;
              return;
            }
            if (
              recordField(data, "isStreaming") !== true &&
              recordField(data, "isCompacting") !== true &&
              (recordNumber(data, "queuedMessageCount") ?? 0) === 0
            ) {
              turn.settleWhenIdle = false;
              if (state === null) return;
              adoptLiveSessionFile(state, data);
              yield* finalizeTurn(state);
            }
            return;
          }
          default:
            return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const activeConnection = connection;
          const event = yield* Queue.take(activeConnection.events).pipe(
            Effect.catchTags({
              // Untraced: this runs inside the per-event pump loop.
              OmpRpcError: Effect.fnUntraced(function* (error: OmpRpcError) {
                // Let activation replace the failed startup before publishing its transport error.
                if (initialActivationPending) yield* Deferred.await(initialActivationDone);
                if (activeConnection !== connection) return undefined;
                return yield* error;
              }),
            }),
          );
          if (event === undefined || activeConnection !== connection) continue;
          for (const normalized of normalizeOmpFrame(event)) {
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                // Tracked here rather than in handleSessionEvent, which also
                // replays buffered wake events after they were observed.
                if (normalized["type"] === "compaction_start") nativeCompacting = true;
                if (normalized["type"] === "compaction_end") {
                  nativeCompacting = false;
                  // Send before the handler can probe settlement, so omp sees the
                  // prompt first. Prompts whose turn ended or is stopping are dropped.
                  rejectedHeldCount = 0;
                  for (const held of heldPrompts.splice(0)) {
                    const turn = threadState?.activeTurn;
                    if (
                      turn?.providerTurn.id !== held.providerTurnId ||
                      turn.interrupted ||
                      stopRequested
                    )
                      continue;
                    yield* sendPrompt(held);
                    releasedPromptTurnId = held.providerTurnId;
                  }
                }
                yield* handleSessionEvent(normalized).pipe(
                  Effect.ensuring(Effect.sync(() => (releasedPromptTurnId = null))),
                );
              }),
            );
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              runtimeRetired = true;
              const state = threadState;
              closed = true;
              if (pendingPromptResponsesDrained !== null)
                yield* Deferred.fail(
                  pendingPromptResponsesDrained,
                  protocolError("omp transport closed while awaiting prompt acknowledgment"),
                );
              if (extensionStatusReset !== null)
                yield* Deferred.fail(
                  extensionStatusReset.ready,
                  protocolError("omp transport closed during status reset"),
                );
              if (rollbackBarrier !== null)
                yield* Deferred.fail(
                  rollbackBarrier,
                  protocolError("omp transport closed during rollback"),
                );
              pendingWake = null;
              const interrupted = state?.activeTurn?.interrupted === true;
              if (state?.activeTurn != null) {
                state.activeTurn.failure = interrupted
                  ? null
                  : makeProviderFailure({
                      cause,
                      message: "omp process exited unexpectedly.",
                      class: "transport_error",
                    });
                yield* finalizeTurn(state, false);
              } else {
                yield* cancelPendingPrompts(yield* DateTime.now);
              }
              if (unsolicitedActivityDetected) {
                yield* updateProviderSession("error", OMP_UNSOLICITED_ACTIVITY_ERROR);
                yield* Queue.end(events);
              } else if (stopRequested) {
                yield* updateProviderSession("stopped", null);
                yield* Queue.end(events);
              } else {
                yield* updateProviderSession(
                  "error",
                  interrupted ? "omp process was stopped." : "omp process exited unexpectedly.",
                );
                yield* Queue.fail(
                  events,
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: OMP_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
                );
              }
            }),
          ),
        ),
        Effect.forkIn(scope),
      );

      const discoverModels = Effect.fnUntraced(function* () {
        const modelsData = yield* request({ type: "get_available_models" }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const models = recordField(modelsData, "models");
        if (Array.isArray(models)) {
          for (const model of models) rememberModelContextWindow(model);
          discoveredModels = models;
        }
      });

      // omp places a fork beside its source with the source's cwd and resumes sessions in the cwd
      // their header names, so a copy for another workspace is forked and then moved there.
      const forkSessionIntoCwd = Effect.fnUntraced(function* (
        sourceFile: string,
        boundary: OmpForkBoundary,
        providerThreadCreatedAt: DateTime.Utc,
      ) {
        const forkLaunch = buildOmpRpcLaunch({
          launchArgs: resolvedLaunchArgs.args,
          environment: options.environment,
          sessionPath: sourceFile,
          bare: true,
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const forkConnection = yield* makeOmpRpcConnection({
              command: options.settings.binaryPath || "omp",
              args: forkLaunch.args,
              cwd,
              env: forkLaunch.env,
            });
            yield* Stream.fromQueue(forkConnection.events).pipe(
              Stream.runDrain,
              Effect.ignore,
              Effect.forkScoped,
            );
            const beforeEntry =
              boundary.type === "nothing"
                ? null
                : yield* ompForkEntry(
                    boundary,
                    providerThreadCreatedAt,
                    forkConnection.request({ type: "get_entries" }),
                  );
            // `branch` keeps the path before a user message; a bare `fork` copies the whole session.
            const result = yield* forkConnection.request(
              beforeEntry === null ? { type: "fork" } : { type: "branch", entryId: beforeEntry },
              OMP_SESSION_TIMEOUT_MS,
            );
            if (recordField(result, "cancelled") === true) {
              return yield* protocolError("An omp extension cancelled the session fork");
            }
            const state = yield* forkConnection.request({ type: "get_state" });
            const file = recordString(state, "sessionFile");
            if (file === undefined || file === sourceFile) {
              return yield* protocolError("omp fork did not create a distinct session file");
            }
            if (yield* sessionHeaderNamesCwd(file)) return file;
            const moved = yield* forkConnection.request(
              { type: "prompt", message: `/move ${cwd}` },
              OMP_SESSION_TIMEOUT_MS,
            );
            if (recordField(moved, "agentInvoked") === true) {
              return yield* protocolError("omp did not treat /move as a command");
            }
            const movedState = yield* forkConnection.request({ type: "get_state" });
            const movedFile = recordString(movedState, "sessionFile");
            if (movedFile === undefined || !(yield* sessionHeaderNamesCwd(movedFile))) {
              return yield* protocolError(
                "omp could not move the forked session to this workspace",
              );
            }
            return movedFile;
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      });

      const sessionFileInCwd = Effect.fnUntraced(function* (
        sessionFile: string,
        providerThreadCreatedAt: DateTime.Utc,
      ) {
        if (yield* sessionHeaderNamesCwd(sessionFile)) return sessionFile;
        return yield* forkSessionIntoCwd(sessionFile, { type: "nothing" }, providerThreadCreatedAt);
      });

      const registerThread = Effect.fnUntraced(
        function* (
          threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
          publish = true,
        ) {
          if (rollbackBarrier !== null)
            return yield* protocolError("Cannot register a omp thread during rollback");
          if (threadState !== null && threadState.activeTurn !== null) {
            return yield* protocolError("Cannot register a omp thread while a turn is active");
          }
          if (pendingWake !== null) {
            const state = threadState;
            if (
              state !== null &&
              state === pendingWake.state &&
              state.providerThread.appThreadId === threadInput.threadId &&
              (threadInput.existingProviderThread === undefined ||
                threadInput.existingProviderThread.nativeThreadRef?.nativeId ===
                  state.providerThread.nativeThreadRef?.nativeId)
            )
              return state.providerThread;
            return yield* protocolError(
              "Cannot switch omp threads while native work is awaiting a turn",
            );
          }
          const existing = threadInput.existingProviderThread;
          const resumeId = existing?.nativeThreadRef?.nativeId;
          const needsNewSession = resumeId == null && registrationAttempted;
          registrationAttempted = true;
          // This probe replaces switch_session as a resume's first request, so it keeps the lifecycle deadline.
          // It also recovers a failed spawn session before lifecycleRequest offers to its dead queue.
          let stateData =
            resumeId != null || initialActivationPending
              ? yield* request({ type: "get_state" }, OMP_SESSION_TIMEOUT_MS)
              : undefined;
          const liveSessionFile = recordString(stateData, "sessionFile");
          // Switching replaces the session and reloads extensions, so keep an already attached file.
          const alreadyOnResumeFile =
            resumeId != null &&
            liveSessionFile !== undefined &&
            path.resolve(cwd, liveSessionFile) === path.resolve(cwd, resumeId);
          if (!alreadyOnResumeFile && (resumeId != null || needsNewSession)) {
            if (pendingWake !== null) {
              return yield* protocolError(
                "Cannot switch omp threads while native work is awaiting a turn",
              );
            }
            lastNativeThreadId = resumeId ?? lastNativeThreadId;
            // Failed lifecycle operations can still change native sessions; invalidate bindings and defaults.
            threadState = null;
            appliedModel = null;
            appliedThinking = null;
            appliedSessionName = null;
            baselineModel = null;
            baselineThinking = null;
            contextWindow = null;
            const result = yield* lifecycleRequest(
              resumeId != null && existing !== undefined
                ? {
                    type: "switch_session",
                    sessionPath: yield* sessionFileInCwd(resumeId, existing.createdAt),
                  }
                : { type: "new_session" },
            );
            if (recordField(result, "cancelled") === true) {
              return yield* protocolError("A omp extension cancelled the session switch");
            }
            stateData = undefined;
          }
          stateData ??= yield* request({ type: "get_state" });
          if (discoveredModels === null) yield* discoverModels();
          contextWindow = rememberModelContextWindow(recordField(stateData, "model"));
          // Capture each baseline before applying selections so our own choices cannot become omp defaults.
          if (baselineModel === null && appliedModel === null) {
            const stateModel = recordField(stateData, "model");
            const provider = recordString(stateModel, "provider");
            const modelId = recordString(stateModel, "id");
            if (provider !== undefined && modelId !== undefined) {
              baselineModel = { provider, modelId };
            }
          }
          if (baselineThinking === null && appliedThinking === null) {
            baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
            appliedThinking = baselineThinking;
          }
          // switch_session accepts a file path, not omp's display session UUID.
          const nativeId = recordString(stateData, "sessionFile");
          if (nativeId === undefined) {
            return yield* protocolError("get_state returned no persisted sessionFile", stateData);
          }
          if (needsNewSession && nativeId === lastNativeThreadId) {
            return yield* protocolError("omp did not create a distinct session file");
          }
          lastNativeThreadId = nativeId;
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread =
            existing !== undefined
              ? {
                  ...existing,
                  providerSessionId: input.providerSessionId,
                  nativeThreadRef: providerRef(nativeId),
                  ...(needsNewSession
                    ? { nativeConversationHeadRef: null, contextUsage: null }
                    : {}),
                  status: "idle",
                  updatedAt: createdAt,
                }
              : {
                  id: idAllocator.derive.providerThread({
                    driver: OMP_PROVIDER,
                    nativeThreadId: nativeId,
                  }),
                  driver: OMP_PROVIDER,
                  providerInstanceId: options.instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadInput.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  pendingBackgroundTasks: [],
                  createdAt,
                  updatedAt: createdAt,
                };
          if (
            threadState !== null &&
            threadState.providerThread.id === providerThread.id &&
            threadState.providerThread.appThreadId === threadInput.threadId &&
            threadState.providerThread.nativeThreadRef?.nativeId === resumeId
          ) {
            // A wake arriving during the reads still owns this same-session binding.
            threadState.providerThread = providerThread;
          } else {
            if (pendingWake !== null) {
              return yield* protocolError(
                "Cannot switch omp threads while native work is awaiting a turn",
              );
            }
            threadState = { providerThread, activeTurn: null, supersededSessionFiles: new Set() };
          }
          const baselineEntries = yield* request({ type: "get_entries" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
          leafCursorStale = baselineEntries === undefined;
          if (publish)
            yield* emit({
              type: "provider_thread.updated",
              driver: OMP_PROVIDER,
              providerThread,
            });
          return providerThread;
        },
        (effect) =>
          Effect.acquireUseRelease(
            Effect.suspend(() => {
              if (registrationInProgress)
                return protocolError("Cannot register a omp thread during registration");
              registrationInProgress = true;
              return Effect.void;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                registrationInProgress = false;
              }),
          ),
      );

      // Role entries in the picker follow omp's modelRoles; read them once per session.
      let modelRoles: Readonly<Record<string, string>> | null = null;
      const resolveModelRole = Effect.fnUntraced(function* (role: string) {
        if (modelRoles === null) {
          const configured = yield* readOmpModelRoles(
            options.settings,
            options.environment,
            cwd,
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
          );
          modelRoles = { ...configured, ...ompModelRoleOverrides(options.settings) };
        }
        const selector = modelRoles[role];
        if (selector === undefined) {
          return yield* protocolError(`omp has no model configured for its ${role} role`);
        }
        return parseOmpModelSelector(selector);
      });

      // omp role selectors may name a model without its provider.
      const resolveModelSelector = (selector: string) => {
        const reported = resolveOmpModelSlug(selector, discoveredModels);
        if (reported !== null) return reported;
        if (!Array.isArray(discoveredModels)) return null;
        for (const model of discoveredModels) {
          const provider = recordString(model, "provider");
          const modelId = recordString(model, "id");
          if (provider !== undefined && modelId === selector) return { provider, modelId };
        }
        return null;
      };

      const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
        let thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        let targetModel = modelSelection.model;
        if (targetModel.startsWith(OMP_ROLE_MODEL_PREFIX)) {
          const role = yield* resolveModelRole(targetModel.slice(OMP_ROLE_MODEL_PREFIX.length));
          targetModel = role.model;
          thinking ??= role.thinking;
        }
        // Extensions and slash commands can change the model without an RPC event.
        // Confirm cached selections against omp before skipping them.
        const modelCached = targetModel !== OMP_INHERIT_MODEL_SLUG && targetModel === appliedModel;
        let modelDrifted = false;
        if (modelCached || (thinking !== undefined && thinking === appliedThinking)) {
          const state = yield* request({ type: "get_state" });
          const stateModel = recordField(state, "model");
          const liveModel = `${recordString(stateModel, "provider")}/${recordString(stateModel, "id")}`;
          modelDrifted = modelCached && liveModel !== appliedModel;
          appliedThinking = recordString(state, "thinkingLevel") ?? null;
        }
        if (targetModel === OMP_INHERIT_MODEL_SLUG) {
          if (appliedModel !== null && baselineModel !== null) {
            const restoredModel = yield* request({ type: "set_model", ...baselineModel });
            appliedThinking = null;
            contextWindow = rememberModelContextWindow(restoredModel);
            appliedModel = null;
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, model: OMP_INHERIT_MODEL_SLUG, updatedAt };
            yield* emit({
              type: "provider_session.updated",
              driver: OMP_PROVIDER,
              providerSession: sessionEntity,
            });
          }
          if (
            thinking === undefined &&
            baselineThinking !== null &&
            appliedThinking !== baselineThinking
          ) {
            yield* request({ type: "set_thinking_level", level: baselineThinking });
            appliedThinking = baselineThinking;
          }
        } else if (modelDrifted || targetModel !== appliedModel) {
          // Extensions and models.yml edits can add providers after the first discovery.
          if (findReportedOmpModel(targetModel, discoveredModels) === undefined) {
            yield* discoverModels();
          }
          const parsed = resolveModelSelector(targetModel);
          if (parsed === null) {
            return yield* protocolError(
              `omp model '${targetModel}' must use provider/model format`,
            );
          }
          const selectedModel = yield* request({
            type: "set_model",
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
          appliedThinking = null;
          contextWindow = rememberModelContextWindow(selectedModel);
          appliedModel = targetModel;
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: OMP_PROVIDER,
            providerSession: sessionEntity,
          });
        }
        if (
          thinking !== undefined &&
          thinking !== appliedThinking &&
          isOmpThinkingLevel(thinking)
        ) {
          yield* request({ type: "set_thinking_level", level: thinking });
          appliedThinking = thinking;
        }
      });

      // The instructions extension reads this file before each agent run.
      const writeInstructions = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        const hasT3Mcp = hostTools !== null;
        const instructions = [
          buildRuntimeInstructions({
            harness: "omp (oh-my-pi)",
            agentFeedback: hasT3Mcp ? (turnInput.agentFeedback ?? "off") : "off",
            model: turnInput.modelSelection.model,
            pullRequestLinking: hasT3Mcp,
            runtimePolicy: turnInput.runtimePolicy,
          }),
          t3OrchestrationSystemPrompt(hasT3Mcp, mcpSession?.capabilities?.has("device") === true),
          hasT3Mcp && mcpSession?.browserToolsAvailable === true
            ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS
            : undefined,
          hasT3Mcp
            ? "T3 Code tools are named `mcp__t3-code__<tool>`. Those not listed as tools are mounted as `xd://mcp__t3-code__<tool>` devices: read the device for its schema, then write JSON arguments to it to call the tool. To wait for a background shell you started (tests, a build), call `t3_background_wait` with its shell ID before you end your turn."
            : undefined,
        ]
          .filter((part): part is string => part !== undefined && part.trim().length > 0)
          .map((part) => part.trim())
          .join("\n\n");
        if (instructions === appliedInstructions) return;
        yield* fileSystem.writeFileString(instructionsFile, instructions);
        appliedInstructions = instructions;
      });

      const resolvePromptPayload = Effect.fnUntraced(function* (
        text: string,
        attachments: ReadonlyArray<ChatAttachment>,
      ) {
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const message = yield* providerMessageTextWithAttachmentPaths({
          text,
          attachments,
          resolveAttachmentPath: host.resolveAttachmentPath,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
        });
        for (const attachment of attachments) {
          const path = host.resolveAttachmentPath(attachment);
          if (path === null) continue;
          if (attachment.mimeType.startsWith("image/")) {
            const bytes = yield* fileSystem.readFile(path);
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }
        return { message, images };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: OMP_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        backgroundTasksEndWithProcess: true,
        hasPendingBackgroundWork: Effect.sync(() => pendingWake !== null),
        hasPendingBackgroundWorkForThread: (providerThread) =>
          Effect.sync(
            () => pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id,
          ),
        getModelContextWindow: (selection) => {
          if (selection.instanceId !== options.instanceId) return undefined;
          const slug =
            selection.model === OMP_INHERIT_MODEL_SLUG
              ? baselineModel === null
                ? undefined
                : `${baselineModel.provider}/${baselineModel.modelId}`
              : selection.model;
          return slug === undefined ? undefined : modelContextWindows.get(slug);
        },
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: OMP_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: OMP_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        compactThread: (turnInput) =>
          runtime.startTurn({
            ...turnInput,
            message: { ...turnInput.message, text: "/compact" },
          }),
        startTurn: Effect.fn("OmpAdapter.startTurn")(
          function* (turnInput) {
            if (registrationInProgress)
              return yield* protocolError("Cannot start a omp turn during registration");
            if (rollbackBarrier !== null)
              return yield* protocolError("Cannot start a omp turn during rollback");
            const state = threadState;
            if (state === null) {
              return yield* protocolError("omp session has no registered thread");
            }
            while (true) {
              if (state.activeTurn !== null) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: OMP_PROVIDER,
                  detail: `omp provider thread ${turnInput.providerThread.id} already has an active turn`,
                  reason: "previous_turn_active",
                });
              }
              if (closed || stopRequested)
                return yield* protocolError("Cannot start a omp turn after session closure");
              if (pendingPromptResponsesDrained === null) break;
              yield* Deferred.await(pendingPromptResponsesDrained);
            }
            if (!isLiveSessionOf(state, turnInput.providerThread.nativeThreadRef?.nativeId)) {
              return yield* protocolError("omp turn requested for a different native session");
            }
            // Fork adoption uses the orchestrator-allocated row; preserve that identity in later updates.
            const continuation =
              turnInput.message.createdBy === "agent" &&
              turnInput.message.creationSource === "provider";
            if (!continuation) yield* applySelection(turnInput.modelSelection);
            yield* writeInstructions(turnInput);
            if (turnInput.appThread.title !== appliedSessionName) {
              yield* request({
                type: "set_session_name",
                name: turnInput.appThread.title,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => (appliedSessionName = turnInput.appThread.title)),
                ),
                Effect.ignore,
              );
            }
            // Resolve attachments before turn installation so failures cannot strand activeTurn.
            // Inject instructions through before_agent_start; wrapping user text breaks slash-command expansion.
            const compactCommand = continuation
              ? null
              : parseOmpCompactCommand(turnInput.message.text);
            const payload =
              !continuation && compactCommand === null
                ? yield* resolvePromptPayload(turnInput.message.text, turnInput.message.attachments)
                : null;
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: OMP_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ...(state.providerThread.nativeThreadRef === null
                ? {}
                : { nativeThreadRef: state.providerThread.nativeThreadRef }),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const activeTurn: ActiveOmpTurn = {
              turnInput,
              providerTurn,
              startedAt,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              rootNodeId: turnInput.rootNodeId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId: providerTurn.id,
              nativeItemId: (nativeId) => nativeId,
              streamKey: providerTurn.id,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              messageOrdinal: 0,
              streamItems: new Map(),
              toolNames: new Map(),
              toolArgs: new Map(),
              toolStartedAt: new Map(),
              commandOutputBytes: new Map(),
              endedToolCalls: new Set(),
              interrupted: false,
              todoList: null,
              nativeAborted: false,
              sawAgentActivity: false,
              adoptedWake: false,
              promptMayBeCommandOnly:
                compactCommand !== null || (payload?.message.trimStart().startsWith("/") ?? false),
              latestCompactionAfterTokens: null,
              lastLiveUsedTokens: null,
              lastMessageUsage: undefined,
              settleProbeGeneration: 0,
              settleWhenIdle: false,
              compactionCancelled: false,
              manualCompactInFlight: compactCommand !== null,
              activeCompaction: null,
              activeProviderRetry: null,
              failure: null,
              rejectedPromptFailure: null,
              unreadSteers: [],
              turnStartPromptId: null,
              lastAssistantAborted: false,
            };
            // Lock only install/send/start events; correlated setup must leave the pump free for dialogs.
            while (true) {
              const pendingAck = yield* Effect.gen(function* () {
                if (
                  threadState !== state ||
                  registrationInProgress ||
                  state.activeTurn !== null ||
                  closed ||
                  stopRequested ||
                  rollbackBarrier !== null ||
                  !isLiveSessionOf(state, turnInput.providerThread.nativeThreadRef?.nativeId)
                ) {
                  return yield* protocolError("omp turn ownership changed before it could start");
                }
                if (pendingPromptResponsesDrained !== null) return pendingPromptResponsesDrained;
                const wake = pendingWake?.state === state ? pendingWake : null;
                if (wake !== null && wake.state.providerThread.appThreadId !== turnInput.threadId) {
                  return yield* protocolError("omp native wake belongs to a different app thread");
                }
                pendingWake = null;
                state.providerThread = {
                  ...turnInput.providerThread,
                  nativeThreadRef: state.providerThread.nativeThreadRef,
                };
                state.activeTurn = activeTurn;
                activeTurn.adoptedWake = wake !== null && !continuation;
                if (compactCommand !== null) {
                  yield* connection.send(compactRpcRecord(compactCommand));
                  pendingCompactResponses.push({
                    providerTurnId: providerTurn.id,
                    kind: "turn_start",
                  });
                } else if (payload !== null) {
                  yield* sendPrompt({
                    providerTurnId: providerTurn.id,
                    kind: "turn_start",
                    record: {
                      type: "prompt",
                      message: payload.message,
                      streamingBehavior: "steer",
                      ...(payload.images.length === 0 ? {} : { images: payload.images }),
                    },
                  });
                }
                yield* emit({
                  type: "provider_turn.updated",
                  driver: OMP_PROVIDER,
                  threadId: turnInput.threadId,
                  providerTurn,
                });
                yield* updateProviderThread(state, {
                  status: "active",
                  firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                  lastRunOrdinal: turnInput.runOrdinal,
                });
                yield* updateProviderSession("running", null);
                if (wake !== null) {
                  for (const event of wake.events) {
                    if (!continuation && event["type"] === "agent_settled") {
                      activeTurn.nativeAborted = event["aborted"] === true;
                      activeTurn.settleWhenIdle = true;
                      continue;
                    }
                    yield* handleSessionEvent(event);
                  }
                } else if (continuation) {
                  yield* finalizeTurn(state);
                }
                if (outOfTurnExtensionErrors.length > 0) {
                  yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
                }
                return null;
              }).pipe(
                sessionEventPermit.withPermits(1),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    if (state.activeTurn === activeTurn) state.activeTurn = null;
                  }),
                ),
              );
              if (pendingAck === null) break;
              // The native event pump needs the permit to consume the actual ACK.
              yield* Deferred.await(pendingAck);
            }
            // omp acks `prompt` only after slash-command expansion completes,
            // and extension commands may block on user dialogs indefinitely.
            // Correlated responses therefore return later through the event pump.
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: OMP_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: Effect.fn("OmpAdapter.steerTurn")(
          function* (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
              return yield* protocolError(`omp turn ${steerInput.providerTurnId} is not active`);
            }
            const compactCommand = parseOmpCompactCommand(steerInput.message.text);
            const payload =
              compactCommand === null
                ? yield* resolvePromptPayload(
                    steerInput.message.text,
                    steerInput.message.attachments,
                  )
                : null;
            // prompt with steer atomically queues or starts; fire-and-forget under the permit avoids dialog deadlocks.
            // /compact uses its RPC, which aborts the agent first.
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (threadState?.activeTurn !== turn) {
                  return yield* protocolError(
                    `omp turn ${steerInput.providerTurnId} is not active`,
                  );
                }
                if (compactCommand !== null) {
                  turn.manualCompactInFlight = true;
                  yield* connection.send(compactRpcRecord(compactCommand));
                  pendingCompactResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                } else if (payload !== null) {
                  yield* sendPrompt({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                    messageId: steerInput.message.messageId,
                    record: {
                      type: "prompt",
                      message: payload.message,
                      streamingBehavior: "steer",
                      ...(payload.images.length === 0 ? {} : { images: payload.images }),
                    },
                  });
                }
                turn.settleProbeGeneration += 1;
              }),
            );
          },
          (effect, steerInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: OMP_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        interruptTurn: Effect.fn("OmpAdapter.interruptTurn")(
          function* (interruptInput) {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null && interruptInput.requestRuntimeRestart === true) {
              if (pendingWake !== null)
                yield* sessionEventPermit.withPermits(1)(stopPendingWake(pendingWake));
              return;
            }
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(
                `omp turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            if (
              interruptInput.requestRuntimeRestart === true ||
              turn.settleWhenIdle ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight ||
              nativeCompacting
            ) {
              // Generic abort misses manual compaction; terminate so Stop covers /compact and recovery.
              stopRequested = true;
              if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                yield* abortNative(turn, 2_000).pipe(Effect.ignore);
              }
              // Capture session identity and rollback refs while omp can still answer; serialize with settlement.
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  const state = threadState;
                  if (state?.activeTurn === turn) {
                    // Probes answered before Stop may carry a session file the extension already left.
                    turn.settleProbeGeneration += 1;
                    const liveState = yield* request({ type: "get_state" }, 2_000).pipe(
                      Effect.orElseSucceed(() => undefined),
                    );
                    adoptLiveSessionFile(state, liveState);
                    if (turn.stopTreeRefs === undefined) {
                      turn.stopTreeRefs = yield* captureTurnTreeRefs(2_000);
                    }
                  }
                  yield* connection.terminate;
                }),
              );
              return;
            }
            yield* abortNative(turn).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          },
          (effect, interruptInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: OMP_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        stopSubagent: Effect.fn("OmpAdapter.stopSubagent")(
          function* (stopInput) {
            const id = stopInput.nativeTaskId.startsWith("subagent:")
              ? stopInput.nativeTaskId.slice("subagent:".length)
              : stopInput.nativeTaskId;
            const tracked = ompSubagents.get(id);
            if (
              tracked !== undefined &&
              stopInput.requestedAt !== undefined &&
              DateTime.toEpochMillis(tracked.startedAt) >
                DateTime.toEpochMillis(stopInput.requestedAt)
            )
              return;
            const result = yield* request({ type: "cancel_subagent", subagentId: id });
            if (recordField(result, "cancelled") !== true) return;
            return {
              status: "cancelled" as const,
              completedAt: yield* DateTime.now,
              result: null,
            };
          },
          (effect) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: OMP_PROVIDER,
                    detail: "omp could not stop the subagent",
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("OmpAdapter.respondToRuntimeRequest")(
          function* (requestInput) {
            const pending = pendingPrompts.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(
                `No pending omp extension request ${requestInput.requestId}`,
              );
            }
            const answeredAt = yield* DateTime.now;
            if (
              pending.expiresAt !== null &&
              DateTime.toEpochMillis(answeredAt) >= pending.expiresAt
            ) {
              pendingPrompts.delete(String(requestInput.requestId));
              yield* cancelPrompt(pending, answeredAt, true);
              return yield* protocolError(
                `omp extension request ${requestInput.requestId} has expired`,
              );
            }
            const response = ompUiResponse(pending, requestInput.decision, requestInput.answers);
            yield* connection.send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              ...response,
            });
            pendingPrompts.delete(String(requestInput.requestId));
            if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
            if (pending.method === "confirm" && requestInput.decision === "acceptForSession") {
              sessionApprovals.add(pending.approvalKey);
            }
            const resolvedAt = yield* DateTime.now;
            pending.runtimeRequest = {
              ...pending.runtimeRequest,
              status: "resolved",
              resolvedAt,
            };
            yield* emit({
              type: "runtime_request.updated",
              driver: OMP_PROVIDER,
              threadId: pending.node.threadId,
              runtimeRequest: pending.runtimeRequest,
            });
            yield* emit({
              type: "node.updated",
              driver: OMP_PROVIDER,
              node: { ...pending.node, status: "completed", completedAt: resolvedAt },
            });
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...pending.turnItem,
                status: "completed",
                completedAt: resolvedAt,
                updatedAt: resolvedAt,
              },
            });
          },
          (effect, requestInput) =>
            effect.pipe(
              sessionEventPermit.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: OMP_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: Effect.fn("OmpAdapter.readThreadSnapshot")(
          function* (snapshotInput) {
            const state = threadState;
            const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
              return yield* protocolError(
                "omp snapshot requested for a thread this session does not host",
              );
            }
            // get_messages contains only the active branch; get_entries would leak abandoned branches into handoffs.
            const messagesData = yield* request({ type: "get_messages" });
            const activeMessages = recordField(messagesData, "messages");
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
              (message, index) => {
                const role = recordString(message, "role");
                if (role !== "user" && role !== "assistant") return [];
                const text = contentText(recordField(message, "content"));
                if (text.length === 0) return [];
                const timestamp = recordNumber(message, "timestamp");
                const at = Option.getOrElse(
                  DateTime.make(timestamp ?? Number.NaN),
                  () => state.providerThread.createdAt,
                );
                return [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: OMP_PROVIDER,
                      nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                    }),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: role as "user" | "assistant",
                    text,
                    attachments: [],
                    streaming: false,
                    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                    creationSource: "provider" as const,
                    createdAt: at,
                    updatedAt: at,
                  },
                ];
              },
            );
            return {
              providerThread: state.providerThread,
              messages,
              runtimeRequests: [],
            };
          },
          (effect, snapshotInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: OMP_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: Effect.fn("OmpAdapter.rollbackThread")(
          function* (rollbackInput) {
            if (registrationInProgress)
              return yield* protocolError("Cannot roll back a omp thread during registration");
            // A fresh runtime (restart or idle release) must load the persisted session before forking.
            // Unpublished: the rollback service persists the returned snapshot.
            if (
              threadState === null &&
              rollbackInput.providerThread.nativeThreadRef?.nativeId != null
            ) {
              yield* registerThread(
                {
                  threadId: rollbackInput.providerThread.appThreadId ?? input.threadId,
                  modelSelection: input.modelSelection,
                  runtimePolicy: input.runtimePolicy,
                  existingProviderThread: rollbackInput.providerThread,
                },
                false,
              );
            }
            const state = threadState;
            if (state === null) {
              return yield* protocolError("omp session has no registered thread");
            }
            if (state.providerThread.id !== rollbackInput.providerThread.id) {
              return yield* protocolError(
                "omp rollback requested for a thread this session does not host",
              );
            }
            if (state.activeTurn !== null) {
              return yield* protocolError("Cannot roll back while a omp turn is active");
            }
            if (pendingWake !== null) {
              return yield* protocolError("Cannot roll back while native omp work awaits a turn");
            }
            const boundary = ompForkBoundary(rollbackInput);
            if (boundary.type === "nothing") {
              return ompThreadSnapshot(state.providerThread);
            }
            const forkEntryId = yield* ompForkEntry(
              boundary,
              rollbackInput.providerThread.createdAt,
              request({ type: "get_entries" }),
            );
            return yield* Effect.acquireUseRelease(
              sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    rollbackBarrier !== null ||
                    registrationInProgress ||
                    threadState !== state ||
                    state.activeTurn !== null ||
                    pendingWake !== null ||
                    closed ||
                    stopRequested
                  )
                    return yield* protocolError(
                      "omp rollback ownership changed before its fork could start",
                    );
                  const barrier = yield* Deferred.make<
                    void,
                    ProviderAdapter.ProviderAdapterProtocolError
                  >();
                  rollbackBarrier = barrier;
                  return barrier;
                }),
              ),
              (barrier) =>
                Effect.gen(function* () {
                  const forkData = yield* lifecycleRequest({
                    type: "branch",
                    entryId: forkEntryId,
                  });
                  if (recordField(forkData, "cancelled") === true)
                    return yield* protocolError("A omp extension cancelled the session fork");
                  const forkState = yield* request({ type: "get_state" }).pipe(
                    Effect.onError(() =>
                      Effect.sync(() => {
                        threadState = null;
                      }),
                    ),
                  );
                  const forkSessionFile = recordString(forkState, "sessionFile");
                  if (forkSessionFile === undefined) {
                    threadState = null;
                    return yield* protocolError("omp fork did not return a persisted session file");
                  }
                  const entriesData = yield* request({ type: "get_entries" }).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  const leafId = recordString(entriesData, "leafId") ?? null;
                  // RPC responses bypass the pump; drain prior native events before replacing their binding.
                  const queued = yield* Queue.offer(connection.events, {
                    type: "t3.rollback_barrier",
                    barrier,
                  });
                  if (!queued) return yield* protocolError("omp transport closed during rollback");
                  yield* Deferred.await(barrier);
                  return yield* sessionEventPermit.withPermits(1)(
                    Effect.gen(function* () {
                      if (pendingWake !== null) {
                        yield* stopPendingWake(pendingWake);
                        return yield* protocolError(
                          "Native omp work started while rollback was changing the session",
                        );
                      }
                      if (
                        threadState !== state ||
                        state.activeTurn !== null ||
                        closed ||
                        stopRequested
                      )
                        return yield* protocolError(
                          "omp rollback ownership changed during its fork",
                        );
                      lastNativeThreadId = forkSessionFile;
                      appliedModel = null;
                      appliedThinking = null;
                      appliedSessionName = null;
                      lastKnownLeaf = leafId;
                      leafCursorStale = entriesData === undefined;
                      yield* updateProviderThread(state, {
                        nativeThreadRef: providerRef(forkSessionFile),
                        nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
                      });
                      rollbackBarrier = null;
                      return ompThreadSnapshot(state.providerThread);
                    }),
                  );
                }).pipe(Effect.onInterrupt(() => connection.terminate)),
              (barrier) =>
                Effect.sync(() => {
                  if (rollbackBarrier === barrier) rollbackBarrier = null;
                }),
            );
          },
          (effect, rollbackInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: OMP_PROVIDER,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
              ),
            ),
        ),
        forkThread: Effect.fn("OmpAdapter.forkThread")(
          function* (forkInput) {
            if (threadState?.activeTurn != null) {
              return yield* protocolError("Cannot fork while a omp turn is active");
            }
            const source = forkInput.sourceProviderThread;
            const currentFile = source.nativeThreadRef?.nativeId;
            if (currentFile == null)
              return yield* protocolError("omp fork source has no session file");
            const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
              (turn) => turn.providerThreadId === source.id,
            );
            const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && target === undefined) {
              return yield* protocolError("omp fork target turn is missing");
            }
            const targetFile = target?.nativeThreadRef?.nativeId ?? undefined;
            const boundary: OmpForkBoundary =
              target === undefined
                ? { type: "nothing" }
                : ompForkBoundary({
                    target: { type: "provider_turn", providerTurn: target },
                    providerThreadTurns: sourceTurns,
                    sessionFile: targetFile,
                  });
            const boundaryFile =
              boundary.type === "nothing" ? undefined : boundary.turn.nativeThreadRef?.nativeId;
            const sourceFile = targetFile ?? boundaryFile ?? currentFile;
            const nativeId = yield* forkSessionIntoCwd(sourceFile, boundary, source.createdAt);
            const now = yield* DateTime.now;
            return yield* registerThread(
              {
                threadId: forkInput.targetThreadId,
                modelSelection: forkInput.modelSelection ?? input.modelSelection,
                runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
                existingProviderThread: {
                  ...source,
                  id: idAllocator.derive.providerThread({
                    driver: OMP_PROVIDER,
                    nativeThreadId: nativeId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: options.instanceId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
              false,
            );
          },
          (effect, forkInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: OMP_PROVIDER,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        ),
      };
      return runtime;
    }),
  });
});

const decodeSessionLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface OmpSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
  /** omp's `timestamp` as epoch milliseconds; null when missing or unparsable. */
  readonly timestamp: number | null;
}

interface OmpSessionListing {
  readonly entries: ReadonlyMap<string, OmpSessionEntry>;
  readonly leafId: string | null;
}

function ompSessionListing(data: unknown): OmpSessionListing | null {
  const leafId = recordField(data, "leafId");
  const entries = ompSessionEntries(recordField(data, "entries"));
  return entries !== null && (typeof leafId === "string" || leafId === null)
    ? { entries, leafId }
    : null;
}

function ompSessionEntries(entries: unknown): ReadonlyMap<string, OmpSessionEntry> | null {
  if (!Array.isArray(entries)) return null;
  const byId = new Map<string, OmpSessionEntry>();
  for (const raw of entries) {
    const entry = readOmpSessionEntry(raw);
    if (entry === null || byId.has(entry[0])) return null;
    byId.set(...entry);
  }
  return byId;
}

function readOmpSessionEntry(entry: unknown): [string, OmpSessionEntry] | null {
  const id = recordString(entry, "id");
  const parentId = recordField(entry, "parentId");
  if (id === undefined || (parentId !== null && typeof parentId !== "string")) return null;
  const timestamp = recordString(entry, "timestamp");
  return [
    id,
    {
      parentId,
      isUserMessage:
        recordField(entry, "type") === "message" &&
        recordString(recordField(entry, "message"), "role") === "user",
      timestamp:
        timestamp === undefined
          ? null
          : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
    },
  ];
}

function walkOmpBranch(
  entries: ReadonlyMap<string, OmpSessionEntry>,
  leafId: string | null,
  stopAt: string | null,
): {
  readonly entryCount: number;
  readonly userEntryIds: ReadonlyArray<string>;
  readonly reachedStop: boolean;
} | null {
  const visited = new Set<string>();
  const userEntryIds: Array<string> = [];
  let current = leafId;
  while (current !== null && current !== stopAt) {
    const entry = entries.get(current);
    if (entry === undefined) break;
    if (visited.has(current)) return null;
    visited.add(current);
    if (entry.isUserMessage) userEntryIds.push(current);
    current = entry.parentId;
  }
  return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

type OmpForkBoundary =
  | {
      readonly type: "entry";
      readonly entryId: string;
      readonly turn: OrchestrationV2ProviderTurn;
      readonly target: OrchestrationV2ProviderTurn | null;
    }
  | { readonly type: "nothing" }
  | {
      readonly type: "uncaptured";
      readonly turn: OrchestrationV2ProviderTurn;
      readonly target: OrchestrationV2ProviderTurn | null;
    };

/**
 * Turns without a ref left nothing on the active branch, so the boundary is the first discarded
 * turn that has one. `uncaptured` is a boundary turn still carrying its synthetic ref (only
 * `captureTurnTreeRefs` records strong ones); `ompForkEntry` locates it in the session tree.
 */
function ompForkBoundary(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  /** Only turns recorded in this session can bound a fork from it. */
  readonly sessionFile?: string | undefined;
}): OmpForkBoundary {
  const target = input.target.type === "thread_start" ? null : input.target.providerTurn;
  const boundary = input.providerThreadTurns
    .filter(
      (turn) =>
        turn.ordinal > (target?.ordinal ?? 0) &&
        turn.nativeTurnRef !== null &&
        (input.sessionFile === undefined || turn.nativeThreadRef?.nativeId === input.sessionFile),
    )
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  const ref = boundary?.nativeTurnRef;
  if (boundary === undefined || ref == null) return { type: "nothing" };
  return ref.strength === "strong" && ref.nativeId !== null
    ? { type: "entry", entryId: ref.nativeId, turn: boundary, target }
    : { type: "uncaptured", turn: boundary, target };
}

/** Reads the session tree only for an uncaptured boundary. */
function ompForkEntry<E>(
  boundary: Exclude<OmpForkBoundary, { type: "nothing" }>,
  providerThreadCreatedAt: DateTime.Utc,
  readEntries: Effect.Effect<unknown, E>,
): Effect.Effect<string, E | ProviderAdapter.ProviderAdapterProtocolError> {
  if (boundary.type === "entry") return Effect.succeed(boundary.entryId);
  return readEntries.pipe(
    Effect.flatMap((data) => {
      const listing = ompSessionListing(data);
      const entryId =
        listing === null
          ? undefined
          : ompUncapturedForkEntry(listing, boundary, providerThreadCreatedAt);
      return entryId === undefined
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OMP_PROVIDER,
              detail: `omp turn ${boundary.turn.ordinal} has no captured session-tree entry and none was found in the session tree`,
            }),
          )
        : Effect.succeed(entryId);
    }),
  );
}

/**
 * omp shares the server clock. An adopted wake can precede its T3 turn, so search from the target
 * turn's end through the boundary turn's end. A boundary turn still running has no end yet, so
 * the window stays open through the tree read. At thread start, use the earlier of thread
 * creation and turn start to include adopted wakes while preserving inherited session history.
 */
function ompUncapturedForkEntry(
  listing: OmpSessionListing,
  boundary: Extract<OmpForkBoundary, { type: "uncaptured" }>,
  providerThreadCreatedAt: DateTime.Utc,
): string | undefined {
  const { startedAt, completedAt } = boundary.turn;
  if (startedAt === null) return undefined;
  const from =
    boundary.target === null
      ? Math.min(DateTime.toEpochMillis(providerThreadCreatedAt), DateTime.toEpochMillis(startedAt))
      : DateTime.toEpochMillis(boundary.target.completedAt ?? startedAt);
  const to = completedAt === null ? Infinity : DateTime.toEpochMillis(completedAt);
  const targetRef = boundary.target?.nativeTurnRef;
  const stopAt = targetRef?.strength === "strong" ? targetRef.nativeId : null;
  if (stopAt !== null && !listing.entries.has(stopAt)) return undefined;
  const walk = walkOmpBranch(listing.entries, listing.leafId, stopAt);
  if (walk === null || !walk.reachedStop) return undefined;
  let earliest: string | undefined;
  for (const id of walk.userEntryIds) {
    const timestamp = listing.entries.get(id)?.timestamp;
    if (timestamp == null) return undefined;
    if (timestamp >= from && timestamp <= to) earliest = id;
  }
  return earliest;
}

function ompExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "omp extension";
  const segments = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  // omp loads a directory extension from its index file; the folder names it.
  const name = fileName === "index" ? (segments.at(-2) ?? fileName) : fileName;
  return name.length === 0 ? "omp extension" : name;
}

function ompThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, messages: [], runtimeRequests: [] };
}

function ompQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: OmpRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({
            label: option || "Empty value",
            description: option || "Empty value",
            value: option,
          }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  // omp's select and editor dialogs carry only a title, so show it once, as the question.
  // Extensions may send a blank placeholder, which is not a valid question.
  const detail = [recordString(event, "message"), recordString(event, "placeholder")].find(
    (text) => text !== undefined && text.trim().length > 0,
  );
  const questionTitle = title.trim() ? title : "Question";
  return {
    id: questionId,
    header: detail === undefined ? "Question" : questionTitle,
    question: detail ?? questionTitle,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    options,
  };
}

/**
 * omp `ask` questions; omp always accepts free text beside the listed options. Undefined when a
 * question cannot be shown, since omp needs an answer to every question, in order.
 */
export function ompAskQuestions(
  input: unknown,
): ReadonlyArray<OrchestrationV2UserInputQuestion> | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const ids = new Set<string>();
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [index, entry] of input.entries()) {
    // Answers come back keyed by T3's trimmed question id; omp matches its own id exactly.
    const id = recordString(entry, "id");
    if (id === undefined || id.length === 0 || id.trim() !== id || ids.has(id)) return undefined;
    ids.add(id);
    const header = recordString(entry, "header")?.trim() || `Question ${index + 1}`;
    const recommended = recordNumber(entry, "recommended");
    const options = recordField(entry, "options");
    questions.push({
      id,
      header,
      question: recordString(entry, "question")?.trim() || header,
      options: (Array.isArray(options) ? options : []).flatMap((option, optionIndex) => {
        const value = recordString(option, "label");
        const label = value?.trim();
        if (value === undefined || !label) return [];
        const preview = recordString(option, "preview");
        return [
          {
            label,
            description: recordString(option, "description")?.trim() || label,
            // omp accepts only the exact label it sent.
            value,
            ...(preview === undefined ? {} : { preview }),
            ...(optionIndex === recommended ? { selected: true } : {}),
          },
        ];
      }),
      ...(recordField(entry, "multi") === true ? { multiSelect: true } : {}),
      allowCustomAnswer: true,
    });
  }
  return questions;
}

function ompAskAnswer(
  question: OrchestrationV2UserInputQuestion,
  answer: unknown,
): { id: string; selectedOptions: Array<string>; customInput?: string } | undefined {
  const values = (Array.isArray(answer) ? answer : [answer]).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (values.length === 0) return undefined;
  const optionValues = new Set(question.options.map((option) => option.value ?? option.label));
  const selectedOptions = values.filter((value) => optionValues.has(value));
  const custom = values.filter((value) => !optionValues.has(value)).join("\n");
  return {
    id: question.id,
    selectedOptions,
    ...(custom.length > 0 ? { customInput: custom } : {}),
  };
}

function ompUiResponse(
  pending: PendingOmpPrompt,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): OmpRpcRecord {
  if (pending.approval !== undefined) {
    if (decision === "accept") return { value: pending.approval.once };
    if (decision === "acceptForSession" || decision === "acceptAlways") {
      return { value: pending.approval.session ?? pending.approval.once };
    }
    if (decision === "decline") return { value: pending.approval.deny };
    return { cancelled: true };
  }
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  if (pending.form !== undefined) {
    return answers === undefined ? { cancelled: true } : { data: pending.form.toData(answers) };
  }
  if (pending.method === "ask") {
    const questions = pending.askQuestions ?? [];
    const replies = questions.flatMap((question) => {
      const reply = ompAskAnswer(question, answers?.[question.id]);
      return reply === undefined ? [] : [reply];
    });
    // omp rejects a reply that skips any question, so a partial answer cancels the ask.
    return replies.length === questions.length && replies.length > 0
      ? { answers: replies }
      : { cancelled: true };
  }
  const answer = answers?.[pending.questionId];
  // RPC distinguishes empty dialog values from cancellation (undefined).
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}

/** omp's todo phases as plan steps; abandoned tasks drop out, and several phases prefix tasks. */
export function ompTodoPlanSteps(phases: ReadonlyArray<unknown>): Array<OrchestrationV2PlanStep> {
  const ids = new Set<string>();
  return phases.flatMap((phase, phaseIndex) => {
    const phaseName = phases.length > 1 ? recordString(phase, "name")?.trim() : undefined;
    const tasks = recordField(phase, "tasks");
    return (Array.isArray(tasks) ? tasks : []).flatMap((task): Array<OrchestrationV2PlanStep> => {
      const content = recordString(task, "content")?.trim();
      const nativeStatus = recordString(task, "status");
      const status =
        nativeStatus === "in_progress"
          ? "running"
          : nativeStatus === "pending" || nativeStatus === "completed"
            ? nativeStatus
            : undefined;
      if (!content || status === undefined) return [];
      // omp addresses tasks by content, so phase and content keep a step's id across updates.
      const baseId = `${phaseIndex + 1}:${content}`;
      let id = baseId;
      for (let copy = 2; ids.has(id); copy += 1) id = `${baseId}#${copy}`;
      ids.add(id);
      return [{ id, text: phaseName ? `${phaseName}: ${content}` : content, status }];
    });
  });
}

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_DRIVER_KIND,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        continuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create omp adapter.",
              cause,
            }),
        ),
      ),
  ),
};
