import type { ServerProviderPromptKeyword } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

/** One of omp's magic keywords and the `magicKeywords.<settingId>` toggle in omp's config. */
interface OmpMagicKeyword {
  readonly settingId: string;
  readonly keyword: ServerProviderPromptKeyword;
}

// Mirrors omp's MAGIC_KEYWORDS table (modes/magic-keywords.ts): words, gradients and toggles.
const OMP_MAGIC_KEYWORDS: ReadonlyArray<OmpMagicKeyword> = [
  {
    settingId: "ultrathink",
    keyword: {
      word: "ultrathink",
      hue: { from: 0, to: 330 },
      description:
        "Asks omp for maximum thinking effort and careful multi-step reasoning this turn",
    },
  },
  {
    settingId: "chillax",
    keyword: {
      word: "chillax",
      hue: { from: 180, to: 235 },
      lightness: { from: 62, to: 45 },
      description: "Drops thinking to the model's lowest effort and keeps this turn light",
    },
  },
  {
    settingId: "orchestrate",
    keyword: {
      word: "orchestrate",
      hue: { from: 150, to: 280 },
      description: "Adds omp's multi-agent orchestration instructions to this turn",
    },
  },
  {
    settingId: "workflow",
    keyword: {
      word: "workflowz",
      hue: { from: 30, to: 150 },
      description: "Adds omp's scripted multi-subagent workflow instructions to this turn",
    },
  },
  {
    settingId: "jevify",
    keyword: {
      word: "jevify",
      hue: { from: 300, to: 420 },
      description: "Adds omp's bulk classification instructions to this turn",
    },
  },
];

/**
 * The keywords omp acts on under `settings`, its resolved config nested as config.yml stores it
 * (`magicKeywords: { enabled, <settingId> }`). Every toggle defaults to on, as in omp.
 */
export function ompPromptKeywords(settings: unknown): ReadonlyArray<ServerProviderPromptKeyword> {
  const toggles = Predicate.isObject(settings) ? settings["magicKeywords"] : undefined;
  if (!Predicate.isObject(toggles)) return OMP_MAGIC_KEYWORDS.map(({ keyword }) => keyword);
  if (toggles["enabled"] === false) return [];
  return OMP_MAGIC_KEYWORDS.flatMap(({ settingId, keyword }) =>
    toggles[settingId] === false ? [] : [keyword],
  );
}
