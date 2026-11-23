// Relay MCP payloads verbatim; schema decoding would reject foreign tool results.
// @effect-diagnostics globalJsonInEffect:off
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

const MCP_PROTOCOL_VERSION = "2025-06-18";
export const OMP_T3_MCP_TOOL_PREFIX = "mcp__t3-code__";
// Keep orchestration entry points top-level; omp mounts the rest as discoverable xd:// devices.
const ESSENTIAL_T3_TOOLS = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);

export class OmpMcpBridgeError extends Schema.TaggedError<OmpMcpBridgeError>()(
  "OmpMcpBridgeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `T3 Code MCP bridge failed: ${this.detail}`;
  }
}

const bridgeError = (cause: unknown) =>
  Predicate.isTagged(cause, "OmpMcpBridgeError")
    ? (cause as OmpMcpBridgeError)
    : new OmpMcpBridgeError({
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const asEnvelope = (value: unknown): JsonRpcEnvelope | null =>
  Predicate.isObject(value) ? (value as JsonRpcEnvelope) : null;

interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly title?: string };
}

function readTools(value: unknown): ReadonlyArray<McpTool> {
  const tools = Predicate.isObject(value) ? value["tools"] : undefined;
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool): tool is McpTool => Predicate.isObject(tool) && typeof tool["name"] === "string",
  );
}

export interface OmpHostToolResult {
  readonly result: {
    readonly content: ReadonlyArray<Record<string, unknown>>;
    readonly details?: Record<string, unknown>;
  };
  readonly isError: boolean;
}

/** MCP `CallToolResult` as an omp `AgentToolResult`: text and image blocks, else the JSON. */
export function ompHostToolResult(server: string, tool: string, value: unknown): OmpHostToolResult {
  const record = Predicate.isObject(value) ? value : {};
  const content: Array<Record<string, unknown>> = [];
  if (Array.isArray(record["content"])) {
    for (const part of record["content"]) {
      if (!Predicate.isObject(part)) continue;
      if (part["type"] === "text" && typeof part["text"] === "string") {
        content.push({ type: "text", text: part["text"] });
      } else if (
        part["type"] === "image" &&
        typeof part["data"] === "string" &&
        typeof part["mimeType"] === "string"
      ) {
        content.push({ type: "image", data: part["data"], mimeType: part["mimeType"] });
      }
    }
  }
  if (content.length === 0) {
    content.push({
      type: "text",
      text: JSON.stringify(record["structuredContent"] ?? value ?? null),
    });
  }
  const isError = record["isError"] === true;
  return {
    result: {
      content,
      details: {
        server,
        tool,
        ...(record["structuredContent"] === undefined
          ? {}
          : { structuredContent: record["structuredContent"] }),
      },
    },
    isError,
  };
}

export interface OmpT3McpHostTools {
  /** `set_host_tools` definitions. */
  readonly definitions: ReadonlyArray<Record<string, unknown>>;
  readonly call: (
    hostToolName: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<OmpHostToolResult, OmpMcpBridgeError>;
}

/**
 * One MCP session over T3 Code's HTTP endpoint, exposed to omp as RPC host tools.
 * The session ends when the scope closes.
 */
export const openOmpT3McpHostTools = Effect.fn("openOmpT3McpHostTools")(function* (
  config: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
  fetchImplementation: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;

  const headers = () => ({
    accept: "application/json, text/event-stream",
    authorization: config.authorizationHeader,
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    "mcp-protocol-version": protocolVersion ?? MCP_PROTOCOL_VERSION,
  });

  const send: (message: unknown) => Effect.Effect<ReadonlyArray<unknown>, OmpMcpBridgeError> =
    Effect.fnUntraced(function* (message: unknown) {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetchImplementation(config.endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers() },
            body: JSON.stringify(message),
            signal,
          }),
        catch: bridgeError,
      });
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      if (!response.ok) {
        yield* discardResponseBody(response);
        return yield* new OmpMcpBridgeError({
          detail: `T3 Code MCP endpoint responded with HTTP ${response.status}`,
        });
      }
      const payloads: Array<unknown> = [];
      yield* Stream.runForEach(responsePayloads(response, bridgeError), (payload) => {
        const envelope = asEnvelope(payload);
        const result = envelope?.result;
        const version = Predicate.isObject(result) ? result["protocolVersion"] : undefined;
        if (typeof version === "string" && version.length > 0) protocolVersion = version;
        // Answer server pings; refuse other server-initiated requests.
        if (envelope?.id !== undefined && typeof envelope.method === "string") {
          return send(
            envelope.method === "ping"
              ? { jsonrpc: "2.0", id: envelope.id, result: {} }
              : {
                  jsonrpc: "2.0",
                  id: envelope.id,
                  error: { code: -32601, message: "Method not found" },
                },
          ).pipe(Effect.asVoid);
        }
        payloads.push(payload);
        return Effect.void;
      });
      return payloads;
    });

  const request = Effect.fnUntraced(function* (method: string, params: unknown) {
    const id = `t3-omp-${nextId++}`;
    const responses = yield* send({ jsonrpc: "2.0", id, method, params });
    const envelope = asEnvelope(responses.find((entry) => asEnvelope(entry)?.id === id));
    if (envelope === null || envelope.error !== undefined) {
      return yield* new OmpMcpBridgeError({
        detail: `${method} failed${envelope?.error === undefined ? "" : `: ${JSON.stringify(envelope.error).slice(0, 400)}`}`,
      });
    }
    return envelope.result;
  });

  yield* Effect.addFinalizer(() =>
    sessionId === null
      ? Effect.void
      : Effect.tryPromise({
          try: () => fetchImplementation(config.endpoint, { method: "DELETE", headers: headers() }),
          catch: bridgeError,
        }).pipe(Effect.flatMap(discardResponseBody), Effect.ignore),
  );
  yield* request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "t3-code-omp", version: "1.0.0" },
  });
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const tools: Array<McpTool> = [];
  let cursor: string | undefined;
  do {
    const page = yield* request("tools/list", cursor === undefined ? {} : { cursor });
    tools.push(...readTools(page));
    const next = Predicate.isObject(page) ? page["nextCursor"] : undefined;
    cursor = typeof next === "string" && next.length > 0 ? next : undefined;
  } while (cursor !== undefined);

  const toolNames = new Map<string, string>();
  const definitions = tools.map((tool) => {
    const hostToolName = `${OMP_T3_MCP_TOOL_PREFIX}${tool.name}`;
    toolNames.set(hostToolName, tool.name);
    const schema = tool.inputSchema ?? {};
    return {
      name: hostToolName,
      label: tool.annotations?.title ?? tool.name,
      description: tool.description ?? tool.name,
      // Zero-argument MCP tools may omit `properties`, which some model APIs reject.
      parameters: {
        ...schema,
        type: schema["type"] ?? "object",
        ...(schema["properties"] === undefined ? { properties: {} } : {}),
      },
      loadMode: ESSENTIAL_T3_TOOLS.has(tool.name) ? "essential" : "discoverable",
      ...(tool.annotations?.readOnlyHint === true ? { approval: "read" } : {}),
    } satisfies Record<string, unknown>;
  });

  return {
    definitions,
    call: (hostToolName, args) => {
      const tool = toolNames.get(hostToolName);
      if (tool === undefined) {
        return Effect.fail(new OmpMcpBridgeError({ detail: `Unknown host tool ${hostToolName}` }));
      }
      return request("tools/call", { name: tool, arguments: args }).pipe(
        Effect.map((result) => ompHostToolResult("t3-code", tool, result)),
      );
    },
  } satisfies OmpT3McpHostTools;
});
