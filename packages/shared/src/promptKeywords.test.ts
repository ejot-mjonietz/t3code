import type { ServerProviderPromptKeyword } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findPromptKeywords, promptKeywordGradient } from "./promptKeywords.ts";

const ULTRATHINK: ServerProviderPromptKeyword = { word: "ultrathink", hue: { from: 0, to: 330 } };
const CHILLAX: ServerProviderPromptKeyword = {
  word: "chillax",
  hue: { from: 180, to: 235 },
  lightness: { from: 62, to: 45 },
};
const ORCHESTRATE: ServerProviderPromptKeyword = {
  word: "orchestrate",
  hue: { from: 150, to: 280 },
};
const JEVIFY: ServerProviderPromptKeyword = { word: "jevify", hue: { from: 300, to: 420 } };

const ranges = (text: string, keywords = [ORCHESTRATE]) =>
  findPromptKeywords(text, keywords).map(({ start, end, keyword }) => [start, end, keyword.word]);

const stopsOf = (gradient: string) => gradient.match(/hsl\([^)]*\)/g) ?? [];

describe("findPromptKeywords", () => {
  it("matches a standalone keyword with exact UTF-16 offsets", () => {
    expect(ranges("Please orchestrate this.")).toEqual([[7, 18, "orchestrate"]]);
    expect(ranges("🚀 orchestrate")).toEqual([[3, 14, "orchestrate"]]);
  });

  it("lets sentence punctuation, quotes, and parentheses touch the keyword", () => {
    expect(ranges(`"orchestrate", orchestrate! (orchestrate) orchestrate.`)).toEqual([
      [1, 12, "orchestrate"],
      [15, 26, "orchestrate"],
      [29, 40, "orchestrate"],
      [42, 53, "orchestrate"],
    ]);
  });

  it("skips occurrences bound into code, paths, or other casing", () => {
    for (const text of [
      "Orchestrate",
      "ORCHESTRATE",
      "orchestrated",
      "reorchestrate",
      "orchestrate.ts",
      "orchestrate()",
      "foo::orchestrate",
      "my-orchestrate",
      "orchestrate-me",
      "orchestrate_now",
      "/orchestrate",
      "orchestrate/",
      "src\\orchestrate",
      ".orchestrate",
    ]) {
      expect(ranges(text), text).toEqual([]);
    }
  });

  it("skips fenced code blocks but matches prose after the closing fence", () => {
    expect(ranges("```\norchestrate\n```")).toEqual([]);
    expect(ranges("~~~md\norchestrate\n~~~")).toEqual([]);
    expect(ranges("```\norchestrate\n```\norchestrate")).toEqual([[20, 31, "orchestrate"]]);
  });

  it("skips matched inline code spans", () => {
    expect(ranges("run `orchestrate` now")).toEqual([]);
    expect(ranges("run ``a ` orchestrate`` now")).toEqual([]);
  });

  it("treats an unmatched backtick as literal prose", () => {
    expect(ranges("a ` orchestrate")).toEqual([[4, 15, "orchestrate"]]);
  });

  it("skips HTML/XML tags, enclosed content, and comments", () => {
    expect(ranges('<tag attr="orchestrate">')).toEqual([]);
    expect(ranges("<!-- orchestrate -->")).toEqual([]);
    expect(ranges("<note>orchestrate</note> orchestrate")).toEqual([[25, 36, "orchestrate"]]);
  });

  it("treats a stray less-than as literal prose", () => {
    expect(ranges("1 < 2 orchestrate")).toEqual([[6, 17, "orchestrate"]]);
  });

  it("returns every keyword's matches sorted by start", () => {
    expect(ranges("ultrathink and orchestrate", [ORCHESTRATE, ULTRATHINK])).toEqual([
      [0, 10, "ultrathink"],
      [15, 26, "orchestrate"],
    ]);
  });

  it("returns the matching keyword declaration", () => {
    expect(findPromptKeywords("chillax", [ORCHESTRATE, CHILLAX])).toEqual([
      { start: 0, end: 7, keyword: CHILLAX },
    ]);
  });
});

describe("promptKeywordGradient", () => {
  it("draws omp's 14-stop hue sweep twice with a 50% period", () => {
    const gradient = promptKeywordGradient(ORCHESTRATE);
    const stops = stopsOf(gradient);
    const positions = Array.from(gradient.matchAll(/\) ([\d.]+)%/g), (match) => Number(match[1]));

    expect(gradient.startsWith("linear-gradient(90deg, hsl(150 90% 62%) 0%, ")).toBe(true);
    expect(gradient.endsWith(", hsl(271 90% 62%) 96.42857142857143%, hsl(150 90% 62%) 100%)")).toBe(
      true,
    );
    expect(stops).toHaveLength(29);
    expect(stops.slice(14, 28)).toEqual(stops.slice(0, 14));
    expect(stops[0]).toBe("hsl(150 90% 62%)");
    expect(stops[1]).toBe("hsl(159 90% 62%)");
    expect(stops[7]).toBe("hsl(215 90% 62%)");
    expect(stops[13]).toBe("hsl(271 90% 62%)");
    expect(stops[28]).toBe("hsl(150 90% 62%)");
    expect(positions).toHaveLength(29);
    for (let k = 0; k < 14; k++) {
      expect(positions[k]).toBeCloseTo((k * 100) / 28);
      expect(positions[k + 14]).toBeCloseTo(positions[k]! + 50);
    }
    expect(positions[28]).toBe(100);
  });

  it("sweeps lightness alongside hue", () => {
    const stops = stopsOf(promptKeywordGradient(CHILLAX));

    expect(stops.slice(0, 14)).toEqual([
      "hsl(180 90% 62%)",
      "hsl(184 90% 61%)",
      "hsl(188 90% 60%)",
      "hsl(192 90% 58%)",
      "hsl(196 90% 57%)",
      "hsl(200 90% 56%)",
      "hsl(204 90% 55%)",
      "hsl(208 90% 54%)",
      "hsl(211 90% 52%)",
      "hsl(215 90% 51%)",
      "hsl(219 90% 50%)",
      "hsl(223 90% 49%)",
      "hsl(227 90% 47%)",
      "hsl(231 90% 46%)",
    ]);
  });

  it("wraps hues past 360 through red", () => {
    const stops = stopsOf(promptKeywordGradient(JEVIFY));

    expect(stops[6]).toBe("hsl(351 90% 62%)");
    expect(stops[7]).toBe("hsl(0 90% 62%)");
    expect(stops[13]).toBe("hsl(51 90% 62%)");
  });
});
