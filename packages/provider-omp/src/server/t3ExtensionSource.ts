/** Extension file omp loads with `--extension`; its subagents rebind the same module. */
export const OMP_T3_EXTENSION_FILENAME = "omp-t3-extension.ts";

export const T3_OMP_INSTRUCTIONS_FILE_ENV = "T3_OMP_INSTRUCTIONS_FILE";
export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";

/**
 * Prefix of every T3 Code tool in omp. omp keeps extension-registered `mcp__` tools across its
 * own MCP manager refreshes, and its manager mints `mcp__<server>_<tool>` with one underscore,
 * so this Claude Code spelling never collides with a configured server.
 */
const OMP_T3_TOOL_PREFIX = "mcp__t3-code__";

/** Top-level T3 tools; omp mounts every other T3 tool as a bash command of the same name. */
const OMP_T3_ESSENTIAL_TOOLS = ["orchestrator_capabilities", "delegate_task", "task_status"];

/** How the model reaches T3 tools, whether or not omp mounts discoverable tools as commands. */
export const OMP_T3_TOOL_INSTRUCTIONS = `T3 Code tools are named \`${OMP_T3_TOOL_PREFIX}<tool>\`. ${OMP_T3_ESSENTIAL_TOOLS.map((tool) => `\`${OMP_T3_TOOL_PREFIX}${tool}\``).join(", ")} are always in your tool list. Any other T3 Code tool missing from your tool list is a bash command of the same name: run \`${OMP_T3_TOOL_PREFIX}<tool> --help\` for its arguments.`;

/** The instructions file: the extension appends `withT3Tools` only once T3's tools registered. */
export interface OmpT3Instructions {
  readonly withT3Tools?: string | undefined;
  readonly withoutT3Tools: string;
}

export function ompT3InstructionsFileContents(instructions: OmpT3Instructions): string {
  return JSON.stringify(instructions);
}

// The extension runs inside omp, so it imports nothing from T3 Code. It reads T3's MCP endpoint
// and token from the environment, registers every T3 MCP tool, and appends the instructions the
// adapter rewrites before each turn (--append-system-prompt would replace the user's own
// APPEND_SYSTEM.md). An unreachable endpoint registers nothing and leaves turns working.
export const OMP_T3_EXTENSION_SOURCE = `\
import { readFileSync } from "node:fs";

const INSTRUCTIONS_FILE_ENV = ${JSON.stringify(T3_OMP_INSTRUCTIONS_FILE_ENV)};
const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const TOOL_PREFIX = ${JSON.stringify(OMP_T3_TOOL_PREFIX)};
const ESSENTIAL_TOOLS = new Set(${JSON.stringify(OMP_T3_ESSENTIAL_TOOLS)});
const PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 10_000;

type JsonRpcMessage = {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly title?: string };
};

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

type ToolResult = {
  content: ToolContent[];
  details: Record<string, unknown>;
  isError?: boolean;
};

type OmpApi = {
  readonly logger: { warn(message: string, context?: Record<string, unknown>): void };
  on(
    event: "before_agent_start",
    handler: (
      event: { systemPrompt: string[] },
      ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
    ) => { systemPrompt: string[] } | undefined,
  ): void;
  registerTool(tool: Record<string, unknown>): void;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sseMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) {
      try {
        messages.push(JSON.parse(data.join("\\n")));
      } catch {
        // Not a JSON-RPC event.
      }
    }
    data = [];
  };
  for (const raw of body.split("\\n")) {
    const line = raw.endsWith("\\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) flush();
    else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  flush();
  return messages;
}

/** The JSON-RPC response to request \`id\` in a JSON or SSE body. */
function responseTo(id: number, body: string, contentType: string): JsonRpcMessage | undefined {
  let messages: unknown[];
  if (contentType.includes("text/event-stream")) {
    messages = sseMessages(body);
  } else {
    const parsed: unknown = body.trim().length === 0 ? [] : JSON.parse(body);
    messages = Array.isArray(parsed) ? parsed : [parsed];
  }
  return messages.find(
    (message): message is JsonRpcMessage => isRecord(message) && message.id === id,
  );
}

function createMcpClient(endpoint: string, token: string) {
  const authorization = token.startsWith("Bearer ") ? token : "Bearer " + token;
  let nextId = 1;
  let sessionId: string | undefined;
  let protocolVersion = PROTOCOL_VERSION;
  let session: Promise<void> | undefined;

  const post = async (message: Record<string, unknown>, signal?: AbortSignal) => {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    };
    if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return response;
  };

  const request = async (method: string, params: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await post({ jsonrpc: "2.0", id, method, params }, signal);
    const body = await response.text();
    if (!response.ok) {
      throw Object.assign(
        new Error("T3 Code MCP " + method + " failed (HTTP " + response.status + "): " + body.slice(0, 400)),
        { status: response.status },
      );
    }
    const reply = responseTo(id, body, response.headers.get("content-type") ?? "");
    if (reply === undefined) throw new Error("T3 Code MCP " + method + " returned no response");
    if (reply.error !== undefined) {
      throw new Error(
        "T3 Code MCP " + method + " failed: " + (reply.error.message ?? JSON.stringify(reply.error)),
      );
    }
    return reply.result;
  };

  // One handshake at a time, shared by concurrent callers; a failed one is retried by the next call.
  const open = () => {
    if (session !== undefined) return session;
    const attempt = (async () => {
      const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
      sessionId = undefined;
      protocolVersion = PROTOCOL_VERSION;
      const result = await request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3-code-omp", version: "1.0.0" },
        },
        signal,
      );
      const version = isRecord(result) ? result.protocolVersion : undefined;
      if (typeof version === "string" && version.length > 0) protocolVersion = version;
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).then(
        (response) => response.body?.cancel(),
        () => undefined,
      );
    })();
    session = attempt;
    attempt.catch(() => {
      if (session === attempt) session = undefined;
    });
    return attempt;
  };

  const call = async (method: string, params: unknown, signal?: AbortSignal) => {
    const current = open();
    await current;
    try {
      return await request(method, params, signal);
    } catch (error) {
      // HTTP 404 means the server forgot this session; the call never ran, so start another once.
      const forgotten = error instanceof Error && "status" in error && error.status === 404;
      if (!forgotten || sessionId === undefined) throw error;
      if (session === current) session = undefined;
      await open();
      return request(method, params, signal);
    }
  };

  const listTools = async () => {
    const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await call("tools/list", cursor === undefined ? {} : { cursor }, signal);
      const listed = isRecord(page) && Array.isArray(page.tools) ? page.tools : [];
      for (const tool of listed) {
        if (isRecord(tool) && typeof tool.name === "string") tools.push(tool as McpTool);
      }
      const next = isRecord(page) ? page.nextCursor : undefined;
      cursor = typeof next === "string" && next.length > 0 ? next : undefined;
    } while (cursor !== undefined);
    return tools;
  };

  return { call, listTools };
}

/** An MCP CallToolResult as an omp tool result: text and image blocks, else the structured JSON. */
function toolResult(tool: string, value: unknown): ToolResult {
  const record = isRecord(value) ? value : {};
  const content: ToolContent[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? value ?? null) });
  }
  return {
    content,
    details: {
      server: "t3-code",
      tool,
      ...(record.structuredContent === undefined ? {} : { structuredContent: record.structuredContent }),
    },
    ...(record.isError === true ? { isError: true } : {}),
  };
}

const endpoint = env(URL_ENV);
const token = env(TOKEN_ENV);
const client = endpoint !== undefined && token !== undefined ? createMcpClient(endpoint, token) : undefined;

// omp subagents rebind this module's factory, so they reuse the parent's catalog.
let catalog: Promise<McpTool[]> | undefined;
function loadCatalog(): Promise<McpTool[]> {
  if (client === undefined) return Promise.resolve([]);
  if (catalog !== undefined) return catalog;
  const attempt = client.listTools();
  catalog = attempt;
  attempt.catch(() => {
    if (catalog === attempt) catalog = undefined;
  });
  return attempt;
}

function registerTools(omp: OmpApi, tools: readonly McpTool[]) {
  const mcp = client;
  if (mcp === undefined) return;
  for (const tool of tools) {
    const schema = tool.inputSchema ?? {};
    const readOnly = tool.annotations?.readOnlyHint === true;
    omp.registerTool({
      name: TOOL_PREFIX + tool.name,
      label: tool.annotations?.title ?? tool.name,
      description: tool.description ?? tool.name,
      // Zero-argument MCP tools may omit \`properties\`, which some model APIs reject.
      parameters: {
        ...schema,
        type: schema.type ?? "object",
        ...(schema.properties === undefined ? { properties: {} } : {}),
      },
      // Discoverable tools run as bash commands named after the tool while omp's tool commands are on.
      loadMode: ESSENTIAL_TOOLS.has(tool.name) ? "essential" : "discoverable",
      // T3 validates arguments; strict grammars make models fill optional fields they should omit.
      strict: false,
      // Read-only tools skip Supervised prompts; the rest keep omp's default exec tier.
      ...(readOnly ? { approval: "read", mcpReadOnlyHint: true } : {}),
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) =>
        toolResult(
          tool.name,
          await mcp.call(
            "tools/call",
            { name: tool.name, arguments: isRecord(params) ? params : {} },
            signal,
          ),
        ),
    });
  }
}

export default async function t3Code(omp: OmpApi) {
  let loaded = false;
  let hasTools = false;
  let failure: string | undefined;
  let notified = false;
  let loading: Promise<void> | undefined;
  const load = () => {
    if (client === undefined || loaded) return Promise.resolve();
    loading ??= loadCatalog()
      .then(
        (tools) => {
          registerTools(omp, tools);
          loaded = true;
          hasTools = tools.length > 0;
          failure = undefined;
        },
        (error) => {
          failure = error instanceof Error ? error.message : String(error);
          omp.logger.warn("T3 Code MCP tools unavailable", { error: failure });
        },
      )
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };
  // Tools registered while the extension loads are in the session's first tool set.
  await load();

  const instructionsFile = env(INSTRUCTIONS_FILE_ENV);
  omp.on("before_agent_start", (event, ctx) => {
    if (client !== undefined && !loaded) {
      if (failure !== undefined && !notified) {
        notified = true;
        ctx.ui.notify("T3 Code tools are unavailable in this omp session: " + failure, "warning");
      }
      // omp adds tools registered later to the live session.
      void load();
    }
    if (instructionsFile === undefined) return undefined;
    let instructions: unknown;
    try {
      instructions = JSON.parse(readFileSync(instructionsFile, "utf8"));
    } catch {
      return undefined;
    }
    if (!isRecord(instructions)) return undefined;
    const text = (hasTools ? instructions.withT3Tools : undefined) ?? instructions.withoutT3Tools;
    return typeof text === "string" && text.trim().length > 0
      ? { systemPrompt: [...event.systemPrompt, text.trim()] }
      : undefined;
  });
}
`;
