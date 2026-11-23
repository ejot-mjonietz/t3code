import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  initialPendingUserInputDraft,
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput.ts";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Focus on orchestration first" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "surfaces",
  header: "Surfaces",
  question: "Which surfaces should change?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
    { label: "Mobile", value: "native", description: "Mobile" },
  ],
  multiSelect: true,
} as const;

describe("initialPendingUserInputDraft", () => {
  it("submits the provider's default options as if the user picked them", () => {
    const single = {
      ...singleSelectQuestion,
      options: [
        { label: "Orchestration-first", description: "Focus on orchestration first" },
        { label: "Node.js", description: "Reuse TypeScript", selected: true },
      ],
    };
    const multi = {
      ...multiSelectQuestion,
      options: multiSelectQuestion.options.map((option) => ({
        ...option,
        selected: option.label !== "Web",
      })),
    };
    const drafts = {
      scope: initialPendingUserInputDraft(single) ?? {},
      surfaces: initialPendingUserInputDraft(multi) ?? {},
    };

    expect(drafts).toEqual({
      scope: { selectedOptionValues: ["Node.js"] },
      surfaces: { selectedOptionValues: ["Server", "native"] },
    });
    expect(isPendingUserInputOptionSelected(single, drafts.scope, "Node.js")).toBe(true);
    expect(isPendingUserInputOptionSelected(multi, drafts.surfaces, "native")).toBe(true);
    expect(buildPendingUserInputAnswers([single, multi], drafts)).toEqual({
      scope: "Node.js",
      surfaces: ["Server", "native"],
    });
    expect(
      buildPendingUserInputAnswers([multi], {
        surfaces: togglePendingUserInputOptionSelection(multi, drafts.surfaces, "Web"),
      }),
    ).toEqual({ surfaces: ["Server", "native", "Web"] });
  });

  it("keeps only the first default of a single-select question", () => {
    const question = {
      ...singleSelectQuestion,
      options: singleSelectQuestion.options.map((option) => ({ ...option, selected: true })),
    };
    expect(initialPendingUserInputDraft(question)).toEqual({
      selectedOptionValues: ["Orchestration-first"],
    });
  });

  it("starts free text from the suggested answer and suggests nothing otherwise", () => {
    const textQuestion = { id: "notes", options: [], allowCustomAnswer: true };
    expect(initialPendingUserInputDraft({ ...textQuestion, initialAnswer: "Draft" })).toEqual({
      customAnswer: "Draft",
    });
    expect(initialPendingUserInputDraft(textQuestion)).toBeUndefined();
    expect(initialPendingUserInputDraft(singleSelectQuestion)).toBeUndefined();
    expect(
      initialPendingUserInputDraft({
        ...nativeChoiceQuestion,
        initialAnswer: "Ignored",
        options: [{ value: "second", label: "Result", selected: true }],
      }),
    ).toEqual({ selectedOptionValues: ["second"] });
  });
});

describe("resolvePendingUserInputAnswer", () => {
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(resolvePendingUserInputAnswer(question, { customAnswer: question.initialAnswer })).toBe(
      question.initialAnswer,
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "  Edited message\n\n" })).toBe(
      "  Edited message\n\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "" })).toBe("");
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \n" })).toBe(" \n");
    expect(
      setPendingUserInputCustomAnswer(
        question,
        { selectedOptionValues: ["Orchestration-first"] },
        "",
      ),
    ).toEqual({ customAnswer: "" });
  });

  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
  });

  it("matches a label only for an option without a value", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, { selectedOptionValues: [" Node.js "] }),
    ).toBe("Node.js");
  });

  it("lets an optional text question stay blank", () => {
    const textQuestion = { id: "notes", options: [] };
    expect(resolvePendingUserInputAnswer({ ...textQuestion, required: false }, undefined)).toBe("");
    expect(
      resolvePendingUserInputAnswer({ ...textQuestion, required: false }, { customAnswer: " " }),
    ).toBe("");
    expect(resolvePendingUserInputAnswer(textQuestion, { customAnswer: " " })).toBeNull();
    expect(
      resolvePendingUserInputAnswer({ ...textQuestion, required: true }, { customAnswer: "" }),
    ).toBeNull();
  });

  it("accepts ready attachment-only answers while preserving selected options", () => {
    expect(resolvePendingUserInputAnswer(singleSelectQuestion, { attachmentCount: 1 })).toBe("");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        selectedOptionValues: ["Node.js"],
      }),
    ).toBe("Node.js");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        attachmentsBlocked: true,
      }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(
        { ...singleSelectQuestion, allowCustomAnswer: false },
        { attachmentCount: 1 },
      ),
    ).toBeNull();
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("selects and removes options with the same label independently", () => {
    const question = { ...nativeChoiceQuestion, multiSelect: true };
    const firstSelected = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const bothSelected = togglePendingUserInputOptionSelection(question, firstSelected, "second");

    expect(buildPendingUserInputAnswers([question], { result: bothSelected })).toEqual({
      result: [" first\t", "second"],
    });

    const secondSelected = togglePendingUserInputOptionSelection(
      question,
      bothSelected,
      " first\t",
    );
    expect(buildPendingUserInputAnswers([question], { result: secondSelected })).toEqual({
      result: ["second"],
    });
  });

  it("submits raw option values and leaves the draft alone for an unknown option", () => {
    const first = togglePendingUserInputOptionSelection(
      nativeChoiceQuestion,
      undefined,
      " first\t",
    );
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, " first\t")).toBe(true);
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, "second")).toBe(false);
    expect(buildPendingUserInputAnswers([nativeChoiceQuestion], { result: first })).toEqual({
      result: " first\t",
    });
    expect(togglePendingUserInputOptionSelection(nativeChoiceQuestion, first, "Result")).toBe(
      first,
    );
  });
});

describe("setPendingUserInputCustomAnswer", () => {
  it("rejects arbitrary text when the provider only accepts offered options", () => {
    expect(setPendingUserInputCustomAnswer(nativeChoiceQuestion, undefined, "Other")).toEqual({});
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], { result: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], {
        result: { selectedOptionValues: ["second"], customAnswer: "stale draft" },
      }),
    ).toEqual({ result: "second" });
  });

  it("adds custom text to multi-select selections", () => {
    const server = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server");
    const typed = setPendingUserInputCustomAnswer(multiSelectQuestion, server, "Docs site");
    expect(typed).toEqual({ customAnswer: "Docs site", selectedOptionValues: ["Server"] });
    expect(isPendingUserInputOptionSelected(multiSelectQuestion, typed, "Server")).toBe(true);
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, typed)).toEqual([
      "Server",
      "Docs site",
    ]);

    const withMobile = togglePendingUserInputOptionSelection(multiSelectQuestion, typed, "native");
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, withMobile)).toEqual([
      "Server",
      "native",
      "Docs site",
    ]);
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        ...withMobile,
        customAnswer: "Server",
      }),
    ).toEqual(["Server", "native"]);
    expect(
      resolvePendingUserInputAnswer(
        multiSelectQuestion,
        setPendingUserInputCustomAnswer(multiSelectQuestion, withMobile, ""),
      ),
    ).toEqual(["Server", "native"]);
    expect(resolvePendingUserInputAnswer(multiSelectQuestion, { customAnswer: "Docs site" })).toBe(
      "Docs site",
    );
  });

  it("replaces a single-select choice with custom text", () => {
    const typed = setPendingUserInputCustomAnswer(
      singleSelectQuestion,
      { selectedOptionValues: ["Node.js"] },
      "Deno",
    );
    expect(typed).toEqual({ customAnswer: "Deno" });
    expect(isPendingUserInputOptionSelected(singleSelectQuestion, typed, "Node.js")).toBe(false);
    expect(togglePendingUserInputOptionSelection(singleSelectQuestion, typed, "Node.js")).toEqual({
      customAnswer: "",
      selectedOptionValues: ["Node.js"],
    });
  });
});

const compatQuestion = {
  id: "compat",
  header: "Compat",
  question: "How strict should compatibility be?",
  options: [{ label: "Keep current envelope", description: "Preserve current wire format" }],
  multiSelect: false,
} as const;

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, compatQuestion], {
        scope: { selectedOptionValues: ["Orchestration-first"] },
        compat: { customAnswer: "Keep the current envelope for one release window" },
      }),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });
});

it.each([
  ["single-select", singleSelectQuestion, ["Orchestration-first"], '"Orchestration-first"'],
  [
    "multi-select",
    {
      ...singleSelectQuestion,
      multiSelect: true,
      options: [{ label: "Server" }, { label: "Web" }],
    },
    ["Server", "Web"],
    '["Server","Web"]',
  ],
])("sends a %s answer to a question with the id __proto__", (_kind, question, selected, json) => {
  const answers = buildPendingUserInputAnswers(
    [
      { ...question, id: "__proto__" },
      { ...singleSelectQuestion, id: "name" },
    ],
    {
      ["__proto__"]: { selectedOptionValues: selected },
      name: { selectedOptionValues: ["Orchestration-first"] },
    },
  );

  expect(JSON.stringify(answers)).toBe(`{"__proto__":${json},"name":"Orchestration-first"}`);
});
