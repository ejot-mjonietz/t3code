// @effect-diagnostics nodeBuiltinImport:off -- Executes the omp extension source at its native JavaScript boundary.
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  normalizeOmpFrame,
  ompApprovalPrompt,
  ompAskQuestions,
  ompTodoPlanSteps,
} from "./adapter.ts";
import { parseOmpAvailableCommands, parseOmpCompactCommand } from "./commands.ts";
import { buildOmpRpcLaunch, ompModelRolesOverlay, resolveOmpLaunchArgs } from "./launch.ts";
import { OMP_T3_EXTENSION_SOURCE } from "./t3ExtensionSource.ts";
import { ompModelCapabilities, parseOmpModelSelector } from "./modelCapabilities.ts";
import { parseOmpModelList } from "./status.ts";

describe("omp launch", () => {
  it("keeps session, mode and approval flags under T3 Code's control", () => {
    for (const reserved of ["--mode rpc", "--resume x", "--approval-mode yolo", "--auto-approve"]) {
      const resolved = resolveOmpLaunchArgs(reserved);
      assert.isFalse(resolved.ok);
    }
    assert.deepStrictEqual(resolveOmpLaunchArgs("--no-lsp --profile work"), {
      ok: true,
      args: ["--no-lsp", "--profile", "work"],
    });
    assert.isFalse(resolveOmpLaunchArgs("fix the bug").ok);
  });

  it("maps runtime modes onto omp approval modes after the user's arguments", () => {
    const launch = buildOmpRpcLaunch({
      launchArgs: ["--no-lsp"],
      environment: {
        T3_OMP_INSTRUCTIONS_FILE: "/inherited",
        T3_MCP_URL: "http://inherited.invalid/mcp",
        T3_MCP_BEARER_TOKEN: "inherited-token",
      },
      sessionPath: "/sessions/a.jsonl",
      runtimeMode: "approval-required",
      extensionPath: "/cache/ext.ts",
      instructionsFile: "/cache/instructions.json",
      mcpSession: {
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-token",
      },
    });
    assert.deepStrictEqual(launch.args, [
      "--mode",
      "rpc-ui",
      "--session",
      "/sessions/a.jsonl",
      "--no-lsp",
      "--approval-mode",
      "always-ask",
      "--extension",
      "/cache/ext.ts",
    ]);
    assert.strictEqual(launch.env["T3_OMP_INSTRUCTIONS_FILE"], "/cache/instructions.json");
    // The extension reads the thread's MCP endpoint from the environment, never from disk.
    assert.strictEqual(launch.env["T3_MCP_URL"], "http://127.0.0.1:3773/mcp");
    assert.strictEqual(launch.env["T3_MCP_BEARER_TOKEN"], "thread-token");
    const full = buildOmpRpcLaunch({ launchArgs: [], environment: {}, runtimeMode: "full-access" });
    assert.include(full.args.join(" "), "--approval-mode yolo");
    const edits = buildOmpRpcLaunch({
      launchArgs: [],
      environment: {},
      runtimeMode: "auto-accept-edits",
    });
    assert.include(edits.args.join(" "), "--approval-mode write");
  });

  it("runs background helpers without tools, extensions, instructions or T3 Code's MCP", () => {
    const launch = buildOmpRpcLaunch({
      launchArgs: [],
      environment: {
        T3_OMP_INSTRUCTIONS_FILE: "/inherited",
        T3_MCP_URL: "http://inherited.invalid/mcp",
        T3_MCP_BEARER_TOKEN: "inherited-token",
      },
      ephemeral: true,
      extensionPath: "/cache/ext.ts",
      instructionsFile: "/cache/instructions.json",
      mcpSession: {
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-token",
      },
      bare: true,
    });
    assert.include(launch.args, "--no-tools");
    assert.include(launch.args, "--no-session");
    assert.notInclude(launch.args, "--extension");
    assert.isUndefined(launch.env["T3_OMP_INSTRUCTIONS_FILE"]);
    assert.isUndefined(launch.env["T3_MCP_URL"]);
    assert.isUndefined(launch.env["T3_MCP_BEARER_TOKEN"]);
  });

  it("writes role overrides as a config overlay", () => {
    assert.isUndefined(ompModelRolesOverlay({}));
    assert.strictEqual(
      ompModelRolesOverlay({ smol: "github-copilot/gpt-6-luna:low" }),
      'modelRoles:\n  "smol": "github-copilot/gpt-6-luna:low"\n',
    );
  });
});

describe("omp models", () => {
  it("splits role selectors into a model and thinking level", () => {
    assert.deepStrictEqual(parseOmpModelSelector("github-copilot/claude-fable-5.2:xhigh"), {
      model: "github-copilot/claude-fable-5.2",
      thinking: "xhigh",
    });
    assert.deepStrictEqual(parseOmpModelSelector("ollama/llama3:8b"), {
      model: "ollama/llama3:8b",
      thinking: undefined,
    });
  });

  it("lists chat models with the efforts each accepts", () => {
    const models = parseOmpModelList(
      JSON.stringify({
        models: [
          {
            provider: "p",
            kind: "chat",
            id: "reasoner",
            name: "Reasoner",
            reasoning: true,
            thinking: ["low", "high", "max"],
          },
          { provider: "p", kind: "chat", id: "plain", reasoning: false },
          { provider: "p", kind: "image", id: "painter" },
        ],
      }),
      "medium",
    );
    assert.deepStrictEqual(
      models?.map((model) => model.slug),
      ["p/reasoner", "p/plain"],
    );
    const thinking = models?.[0]?.capabilities?.optionDescriptors?.[0];
    assert.deepStrictEqual(
      thinking?.type === "select" ? thinking.options.map((option) => option.id) : [],
      ["off", "low", "high", "max", "auto"],
    );
    // An unavailable configured level rounds up to the next one the model accepts.
    assert.strictEqual(
      thinking?.type === "select" ? thinking.options.find((option) => option.isDefault)?.id : null,
      "high",
    );
    assert.deepStrictEqual(models?.[1]?.capabilities?.optionDescriptors, []);
    assert.isUndefined(parseOmpModelList("not json", undefined));
  });

  it("reads efforts from the RPC model shape too", () => {
    const capabilities = ompModelCapabilities(
      { reasoning: true, thinking: { efforts: ["medium", "xhigh"] } },
      undefined,
    );
    const thinking = capabilities.optionDescriptors?.[0];
    assert.deepStrictEqual(
      thinking?.type === "select" ? thinking.options.map((option) => option.id) : [],
      ["off", "medium", "xhigh", "auto"],
    );
  });
});

describe("omp commands", () => {
  it("lists commands and skills, hiding builtins that would move the session", () => {
    const parsed = parseOmpAvailableCommands({
      commands: [
        { name: "compact", source: "builtin", input: { hint: "[soft|remote] [focus]" } },
        { name: "model", source: "builtin" },
        { name: "review", source: "custom", input: { hint: "arguments" } },
        { name: "skill:find-skills", source: "skill", description: "Find skills" },
      ],
    });
    assert.deepStrictEqual(
      parsed.slashCommands.map((command) => command.name),
      ["compact", "review"],
    );
    assert.deepStrictEqual(parsed.slashCommands[1]?.input, undefined);
    assert.deepStrictEqual(parsed.skills, [
      {
        name: "find-skills",
        path: "omp:skill:find-skills",
        enabled: true,
        description: "Find skills",
      },
    ]);
  });

  it("routes /compact to RPC compaction but leaves omp's compaction modes to omp", () => {
    assert.deepStrictEqual(parseOmpCompactCommand("/compact"), {});
    assert.deepStrictEqual(parseOmpCompactCommand("/compact keep the API notes"), {
      customInstructions: "keep the API notes",
    });
    assert.isNull(parseOmpCompactCommand("/compact snapcompact"));
    assert.isNull(parseOmpCompactCommand("/compactor"));
  });
});

describe("omp RPC frames", () => {
  it("treats a yielded run as settled and maps compaction events", () => {
    assert.deepStrictEqual(normalizeOmpFrame({ type: "agent_end", yielded: true }), [
      { type: "agent_end", yielded: true },
      { type: "agent_settled" },
    ]);
    assert.deepStrictEqual(normalizeOmpFrame({ type: "agent_end", yielded: false }), [
      { type: "agent_end", yielded: false },
    ]);
    assert.deepStrictEqual(normalizeOmpFrame({ type: "auto_compaction_start" }), [
      { type: "compaction_start" },
    ]);
    assert.deepStrictEqual(
      normalizeOmpFrame({ type: "manual_compaction_end", skipped: true, errorMessage: "nothing" }),
      [{ type: "compaction_end", aborted: true, willRetry: false }],
    );
  });

  it("recognizes omp's approval select and its choices", () => {
    const bash = ompApprovalPrompt("Allow tool: bash\nCommand: rm -rf build", [
      "Approve",
      "Approve bash for this session",
      "Deny",
    ]);
    assert.deepStrictEqual(bash, {
      toolName: "bash",
      kind: "command",
      choices: { once: "Approve", session: "Approve bash for this session", deny: "Deny" },
    });
    assert.strictEqual(
      ompApprovalPrompt("Allow tool: edit\nPath: src/a.ts", ["Approve", "Deny"])?.kind,
      "file-change",
    );
    assert.deepInclude(
      ompApprovalPrompt("Allow tool: mcp__t3-code__link_pull_request\nArguments: {}", [
        "Approve",
        "Deny",
      ]),
      { toolName: "mcp__t3-code__link_pull_request", kind: "command" },
    );
    assert.isUndefined(ompApprovalPrompt("Pick a branch", ["main", "dev"]));
  });

  it("shows omp's read-tier file tools as file reads", () => {
    for (const tool of ["read", "grep", "glob", "find", "ls", "ast_grep"]) {
      assert.strictEqual(
        ompApprovalPrompt(`Allow tool: ${tool}\nPath: /repo/src`, ["Approve", "Deny"])?.kind,
        "file-read",
        tool,
      );
    }
    for (const tool of ["bash", "eval", "think", "toString"]) {
      assert.strictEqual(
        ompApprovalPrompt(`Allow tool: ${tool}`, ["Approve", "Deny"])?.kind,
        "command",
        tool,
      );
    }
  });

  it("turns ask dialogs into questions that accept free text and keep omp's labels", () => {
    assert.deepStrictEqual(
      ompAskQuestions([
        {
          id: "color",
          question: "Which color?",
          header: "Color",
          options: [{ label: " Red " }, { label: "Blue", description: "Calm" }, { label: "  " }],
          multi: true,
          recommended: 1,
        },
        { id: "size", question: "  " },
      ]),
      [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          options: [
            { label: "Red", description: "Red", value: " Red " },
            { label: "Blue", description: "Calm", value: "Blue", selected: true },
          ],
          multiSelect: true,
          allowCustomAnswer: true,
        },
        {
          id: "size",
          header: "Question 2",
          question: "Question 2",
          options: [],
          allowCustomAnswer: true,
        },
      ],
    );
    // omp needs an answer to every question, so one T3 cannot key fails the whole dialog.
    assert.isUndefined(ompAskQuestions([{ id: "a", question: "A?" }, { question: "No id" }]));
    assert.isUndefined(
      ompAskQuestions([
        { id: "a", question: "A?" },
        { id: "a", question: "Again?" },
      ]),
    );
    assert.isUndefined(ompAskQuestions([{ id: " a", question: "A?" }]));
    assert.isUndefined(ompAskQuestions([]));
  });

  it("maps todo phases onto plan steps", () => {
    assert.deepStrictEqual(
      ompTodoPlanSteps([
        {
          name: "Build",
          tasks: [
            { content: "Parse", status: "completed" },
            { content: "Emit", status: "in_progress" },
            { content: "Cache", status: "abandoned" },
          ],
        },
        { name: "Ship", tasks: [{ content: "Release", status: "pending" }] },
      ]),
      [
        { id: "1:Parse", text: "Build: Parse", status: "completed" },
        { id: "1:Emit", text: "Build: Emit", status: "running" },
        { id: "2:Release", text: "Ship: Release", status: "pending" },
      ],
    );
    // A single phase needs no prefix; repeated content still gets distinct ids.
    assert.deepStrictEqual(
      ompTodoPlanSteps([
        {
          name: "Todo",
          tasks: [
            { content: "Check", status: "completed" },
            { content: "Check", status: "pending" },
          ],
        },
      ]),
      [
        { id: "1:Check", text: "Check", status: "completed" },
        { id: "1:Check#2", text: "Check", status: "pending" },
      ],
    );
  });
});

interface OmpExtensionTool {
  readonly name: string;
  readonly label: string;
  readonly parameters: Record<string, unknown>;
  readonly loadMode: string;
  readonly strict?: boolean;
  readonly approval?: string;
  readonly mcpReadOnlyHint?: boolean;
  readonly execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{
    readonly content: ReadonlyArray<Record<string, unknown>>;
    readonly details?: Record<string, unknown>;
    readonly isError?: boolean;
  }>;
}

interface McpReply {
  readonly status?: number;
  readonly result?: unknown;
  readonly sse?: boolean;
}

type BeforeAgentStart = (
  event: { systemPrompt: string[] },
  ctx: { ui: { notify: (message: string) => void } },
) => { systemPrompt: string[] } | undefined;

/** Runs the extension source against a fake omp and a fake T3 Code MCP endpoint. */
async function loadOmpT3Extension(
  reply: (method: string, params: Readonly<Record<string, unknown>>) => McpReply,
) {
  const tools: Array<OmpExtensionTool> = [];
  const requests: Array<{
    readonly method: string;
    readonly params: unknown;
    readonly headers: Record<string, string>;
  }> = [];
  const warnings: Array<string> = [];
  const notices: Array<string> = [];
  let beforeAgentStart: BeforeAgentStart | undefined;
  const source = NodeModule.stripTypeScriptTypes(
    OMP_T3_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3Code(omp)`, {
    process: {
      env: {
        T3_MCP_URL: "http://t3.invalid/mcp",
        T3_MCP_BEARER_TOKEN: "thread-token",
        T3_OMP_INSTRUCTIONS_FILE: "/cache/instructions.json",
      },
    },
    AbortSignal,
    fetch: async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const message = JSON.parse(init.body) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      requests.push({ method: message.method, params: message.params, headers: init.headers });
      if (message.id === undefined) return new Response(null, { status: 202 });
      const { status, result, sse } = reply(message.method, message.params ?? {});
      if (status !== undefined) return new Response("unknown session", { status });
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      return new Response(sse === true ? `event: message\ndata: ${body}\n\n` : body, {
        headers: {
          "content-type": sse === true ? "text/event-stream" : "application/json",
          "mcp-session-id": "session-1",
        },
      });
    },
    readFileSync: () =>
      JSON.stringify({ withT3Tools: "T3 tool guidance", withoutT3Tools: "Plain guidance" }),
    omp: {
      logger: { warn: (message: string) => warnings.push(message) },
      on: (_event: string, handler: BeforeAgentStart) => {
        beforeAgentStart = handler;
      },
      registerTool: (tool: OmpExtensionTool) => tools.push(tool),
    },
  });
  const startAgent = () =>
    beforeAgentStart!(
      { systemPrompt: ["omp prompt"] },
      { ui: { notify: (message) => notices.push(message) } },
    );
  return { tools, requests, warnings, notices, startAgent };
}

describe("omp T3 Code tools extension", () => {
  it("registers every T3 tool, keeping orchestration top-level and reads unprompted", async () => {
    const extension = await loadOmpT3Extension((method, params) => {
      if (method !== "tools/list") return { result: { protocolVersion: "2025-06-18" } };
      return params["cursor"] === undefined
        ? {
            sse: true,
            result: {
              tools: [
                {
                  name: "orchestrator_capabilities",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
                {
                  name: "delegate_task",
                  inputSchema: {
                    type: "object",
                    properties: { prompt: { type: "string" } },
                    required: ["prompt"],
                  },
                },
              ],
              nextCursor: "page-2",
            },
          }
        : {
            result: {
              tools: [
                { name: "task_status", annotations: { readOnlyHint: true } },
                { name: "link_pull_request", annotations: { title: "Link a pull request" } },
                { description: "not a tool" },
              ],
            },
          };
    });
    assert.deepEqual(
      extension.tools.map((tool) => [tool.name, tool.loadMode, tool.approval]),
      [
        ["mcp__t3-code__orchestrator_capabilities", "essential", "read"],
        ["mcp__t3-code__delegate_task", "essential", undefined],
        ["mcp__t3-code__task_status", "essential", "read"],
        ["mcp__t3-code__link_pull_request", "discoverable", undefined],
      ],
    );
    const link = extension.tools[3]!;
    assert.strictEqual(link.label, "Link a pull request");
    assert.deepEqual(link.parameters, { type: "object", properties: {} });
    assert.isFalse(link.strict);
    assert.notProperty(link, "approval");
    assert.isTrue(extension.tools[2]!.mcpReadOnlyHint);
    assert.deepEqual(
      extension.requests.map((request) => [request.method, request.params ?? null]),
      [
        ["initialize", extension.requests[0]!.params],
        ["notifications/initialized", null],
        ["tools/list", {}],
        ["tools/list", { cursor: "page-2" }],
      ],
    );
    assert.strictEqual(extension.requests[0]!.headers["authorization"], "Bearer thread-token");
    assert.strictEqual(extension.requests[3]!.headers["mcp-session-id"], "session-1");
    assert.deepEqual(extension.startAgent(), {
      systemPrompt: ["omp prompt", "T3 tool guidance"],
    });
  });

  it("passes MCP text and images through, falls back to structured JSON and keeps errors", async () => {
    const extension = await loadOmpT3Extension((method, params) => {
      if (method === "tools/list") {
        return { result: { tools: [{ name: "preview_screenshot" }, { name: "task_status" }] } };
      }
      if (method !== "tools/call") return { result: {} };
      return params["name"] === "preview_screenshot"
        ? {
            result: {
              content: [
                { type: "text", text: "hi" },
                { type: "image", data: "AAA", mimeType: "image/png" },
                { type: "resource", uri: "x" },
              ],
              isError: true,
            },
          }
        : { result: { content: [], structuredContent: { ok: true } } };
    });
    const [screenshot, status] = extension.tools;
    assert.deepEqual(await screenshot!.execute("call-1", { fullPage: true }), {
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "AAA", mimeType: "image/png" },
      ],
      details: { server: "t3-code", tool: "preview_screenshot" },
      isError: true,
    });
    assert.deepEqual(extension.requests.at(-1)?.params, {
      name: "preview_screenshot",
      arguments: { fullPage: true },
    });
    assert.deepEqual(await status!.execute("call-2", undefined), {
      content: [{ type: "text", text: '{"ok":true}' }],
      details: { server: "t3-code", tool: "task_status", structuredContent: { ok: true } },
    });
  });

  it("starts a new MCP session once when T3 Code forgot the current one", async () => {
    let forgotten = false;
    const extension = await loadOmpT3Extension((method) => {
      if (method === "tools/list") return { result: { tools: [{ name: "task_status" }] } };
      if (method === "tools/call" && !forgotten) {
        forgotten = true;
        return { status: 404 };
      }
      return { result: method === "tools/call" ? { content: [{ type: "text", text: "ok" }] } : {} };
    });
    const result = await extension.tools[0]!.execute("call-1", {});
    assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
    assert.deepEqual(
      extension.requests.slice(3).map((request) => request.method),
      ["tools/call", "initialize", "notifications/initialized", "tools/call"],
    );
  });

  it("registers nothing and keeps turns working when T3 Code's MCP is unreachable", async () => {
    const extension = await loadOmpT3Extension(() => {
      throw new Error("connect ECONNREFUSED");
    });
    assert.lengthOf(extension.tools, 0);
    assert.isAbove(extension.warnings.length, 0);
    assert.deepEqual(extension.startAgent(), { systemPrompt: ["omp prompt", "Plain guidance"] });
    extension.startAgent();
    assert.lengthOf(extension.notices, 1);
    assert.include(extension.notices[0] ?? "", "connect ECONNREFUSED");
  });
});
