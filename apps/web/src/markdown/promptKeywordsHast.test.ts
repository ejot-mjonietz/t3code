import type { ServerProviderPromptKeyword } from "@t3tools/contracts";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast, type WordsHastOptions } from "./wordsHast";

const ORCHESTRATE: ServerProviderPromptKeyword = {
  word: "orchestrate",
  hue: { from: 150, to: 280 },
};
const ULTRATHINK: ServerProviderPromptKeyword = { word: "ultrathink", hue: { from: 0, to: 330 } };

const USER: WordsHastOptions = {
  math: false,
  breaks: true,
  escapeHtml: true,
  insights: false,
  extensions: { promptKeywords: [ORCHESTRATE, ULTRATHINK] },
};

/** The words a rendered user bubble paints, in order. */
const painted = (markdown: string, options: Partial<WordsHastOptions> = {}) =>
  [
    ...toHtml(wordsHast(markdown, { ...USER, ...options })).matchAll(
      /<span class="prompt-keyword"[^>]*>([^<]*)<\/span>/g,
    ),
  ].map((match) => match[1]);

describe("prompt keywords in user messages", () => {
  it("paints standalone keywords in prose, lists and emphasis", () => {
    expect(painted("please orchestrate this")).toEqual(["orchestrate"]);
    expect(painted("- ultrathink first\n- then **orchestrate**")).toEqual([
      "ultrathink",
      "orchestrate",
    ]);
  });

  it("leaves code, file names and other casings plain", () => {
    expect(painted("run `orchestrate` and orchestrate.ts or Orchestrate")).toEqual([]);
    expect(painted("```\norchestrate\n```\n\nthen orchestrate")).toEqual(["orchestrate"]);
  });

  it("stays aligned after code that repeats the word", () => {
    expect(painted("`orchestrate` then orchestrate, and `x` ultrathink")).toEqual([
      "orchestrate",
      "ultrathink",
    ]);
  });

  it("keeps the text and paints nothing without keywords", () => {
    const html = toHtml(wordsHast("please orchestrate this", { ...USER, extensions: {} }));
    expect(html).not.toContain("prompt-keyword");
    expect(html).toContain("please orchestrate this");
  });
});
