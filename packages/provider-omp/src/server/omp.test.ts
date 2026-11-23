import { assert, describe, it } from "@effect/vitest";

import { normalizeOmpFrame, ompApprovalPrompt, ompAskQuestions } from "./adapter.ts";
import { parseOmpAvailableCommands, parseOmpCompactCommand } from "./commands.ts";
import { buildOmpRpcLaunch, ompModelRolesOverlay, resolveOmpLaunchArgs } from "./launch.ts";
import { ompHostToolResult } from "./mcpHostTools.ts";
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
      environment: { T3_OMP_INSTRUCTIONS_FILE: "/inherited" },
      sessionPath: "/sessions/a.jsonl",
      runtimeMode: "approval-required",
      extensionPath: "/cache/ext.ts",
      instructionsFile: "/cache/instructions.md",
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
    assert.strictEqual(launch.env["T3_OMP_INSTRUCTIONS_FILE"], "/cache/instructions.md");
    const full = buildOmpRpcLaunch({ launchArgs: [], environment: {}, runtimeMode: "full-access" });
    assert.include(full.args.join(" "), "--approval-mode yolo");
    const edits = buildOmpRpcLaunch({
      launchArgs: [],
      environment: {},
      runtimeMode: "auto-accept-edits",
    });
    assert.include(edits.args.join(" "), "--approval-mode write");
  });

  it("runs background helpers without tools, extensions or inherited instructions", () => {
    const launch = buildOmpRpcLaunch({
      launchArgs: [],
      environment: { T3_OMP_INSTRUCTIONS_FILE: "/inherited" },
      ephemeral: true,
      extensionPath: "/cache/ext.ts",
      instructionsFile: "/cache/instructions.md",
      bare: true,
    });
    assert.include(launch.args, "--no-tools");
    assert.include(launch.args, "--no-session");
    assert.notInclude(launch.args, "--extension");
    assert.isUndefined(launch.env["T3_OMP_INSTRUCTIONS_FILE"]);
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
    // A device call writes to xd://, which runs a tool rather than editing a file.
    assert.deepInclude(
      ompApprovalPrompt("Allow tool: write\nPath: xd://mcp__t3-code__echo", ["Approve", "Deny"]),
      { toolName: "mcp__t3-code__echo", kind: "command" },
    );
    assert.isUndefined(ompApprovalPrompt("Pick a branch", ["main", "dev"]));
  });

  it("turns ask dialogs into questions that accept free text", () => {
    assert.deepStrictEqual(
      ompAskQuestions([
        {
          id: "color",
          question: "Which color?",
          header: "Color",
          options: [{ label: "Red" }, { label: "Blue", description: "Calm" }],
          multi: true,
        },
        { id: "blank", question: "  " },
      ]),
      [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          options: [
            { label: "Red", description: "Red", value: "Red" },
            { label: "Blue", description: "Calm", value: "Blue" },
          ],
          multiSelect: true,
          allowCustomAnswer: true,
        },
      ],
    );
  });
});

describe("omp host tools", () => {
  it("passes MCP text and images through and keeps errors", () => {
    assert.deepStrictEqual(
      ompHostToolResult("t3-code", "echo", {
        content: [
          { type: "text", text: "hi" },
          { type: "image", data: "AAA", mimeType: "image/png" },
          { type: "resource", uri: "x" },
        ],
        isError: true,
      }),
      {
        result: {
          content: [
            { type: "text", text: "hi" },
            { type: "image", data: "AAA", mimeType: "image/png" },
          ],
          details: { server: "t3-code", tool: "echo" },
        },
        isError: true,
      },
    );
    assert.deepStrictEqual(
      ompHostToolResult("t3-code", "status", { content: [], structuredContent: { ok: true } })
        .result.content,
      [{ type: "text", text: '{"ok":true}' }],
    );
  });
});
