import { assert, describe, it } from "@effect/vitest";

import { ompPromptKeywords } from "./magicKeywords.ts";

const words = (settings: unknown) => ompPromptKeywords(settings).map(({ word }) => word);

describe("omp magic keywords", () => {
  it("offers every keyword with omp's gradients when the config sets none", () => {
    for (const settings of [undefined, {}, { magicKeywords: null }]) {
      assert.deepStrictEqual(words(settings), [
        "ultrathink",
        "chillax",
        "orchestrate",
        "workflowz",
        "jevify",
      ]);
    }
    assert.deepStrictEqual(
      ompPromptKeywords(undefined).map(({ word, hue, lightness }) => ({ word, hue, lightness })),
      [
        { word: "ultrathink", hue: { from: 0, to: 330 }, lightness: undefined },
        { word: "chillax", hue: { from: 180, to: 235 }, lightness: { from: 62, to: 45 } },
        { word: "orchestrate", hue: { from: 150, to: 280 }, lightness: undefined },
        { word: "workflowz", hue: { from: 30, to: 150 }, lightness: undefined },
        { word: "jevify", hue: { from: 300, to: 420 }, lightness: undefined },
      ],
    );
    for (const keyword of ompPromptKeywords(undefined)) {
      assert.isTrue((keyword.description ?? "").length > 0);
    }
  });

  it("offers none when omp disables magic keywords", () => {
    assert.deepStrictEqual(words({ magicKeywords: { enabled: false } }), []);
    assert.deepStrictEqual(words({ magicKeywords: { enabled: false, ultrathink: true } }), []);
  });

  it("drops a keyword whose own toggle is off", () => {
    assert.deepStrictEqual(words({ magicKeywords: { enabled: true, chillax: false } }), [
      "ultrathink",
      "orchestrate",
      "workflowz",
      "jevify",
    ]);
    // omp keys workflowz's toggle as `workflow`.
    assert.deepStrictEqual(words({ magicKeywords: { workflow: false, workflowz: true } }), [
      "ultrathink",
      "chillax",
      "orchestrate",
      "jevify",
    ]);
    assert.strictEqual(words({ magicKeywords: { workflowz: false } }).length, 5);
  });
});
