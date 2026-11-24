import {
  type ModelCapabilities,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Predicate from "effect/Predicate";

const OMP_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
// `auto` lets omp classify each prompt; it is omp's own selector, not a model effort.
const OMP_THINKING_LEVELS = ["off", ...OMP_EFFORT_LEVELS, "auto"] as const;

export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];

export function isOmpThinkingLevel(value: string): value is OmpThinkingLevel {
  return OMP_THINKING_LEVELS.some((level) => level === value);
}

const OMP_THINKING_LEVEL_LABELS: Record<OmpThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  auto: "Auto",
};

export const EMPTY_OMP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** Splits omp's `provider/model:thinking` role selector. */
export function parseOmpModelSelector(selector: string): {
  readonly model: string;
  readonly thinking: OmpThinkingLevel | undefined;
} {
  const trimmed = selector.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator > 0) {
    const suffix = trimmed.slice(separator + 1);
    if (isOmpThinkingLevel(suffix)) {
      return { model: trimmed.slice(0, separator), thinking: suffix };
    }
  }
  return { model: trimmed, thinking: undefined };
}

/**
 * Efforts the model accepts. `get_available_models` reports `thinking.efforts`;
 * `omp models --json` reports them as the `thinking` array.
 */
function supportedOmpEfforts(model: unknown): ReadonlyArray<OmpThinkingLevel> {
  if (recordField(model, "reasoning") !== true) return [];
  const thinking = recordField(model, "thinking");
  const efforts = Array.isArray(thinking) ? thinking : recordField(thinking, "efforts");
  if (!Array.isArray(efforts)) return [];
  return OMP_EFFORT_LEVELS.filter((level) => efforts.includes(level));
}

export function ompModelCapabilities(
  model: unknown,
  defaultThinkingLevel: string | undefined,
): ModelCapabilities {
  const descriptor = thinkingDescriptor(model, defaultThinkingLevel);
  return descriptor === undefined
    ? EMPTY_OMP_MODEL_CAPABILITIES
    : createModelCapabilities({ optionDescriptors: [descriptor] });
}

function thinkingDescriptor(
  model: unknown,
  defaultThinkingLevel: string | undefined,
): ProviderOptionDescriptor | undefined {
  const efforts = supportedOmpEfforts(model);
  if (efforts.length === 0) return undefined;
  const levels: ReadonlyArray<OmpThinkingLevel> = ["off", ...efforts, "auto"];
  const defaultLevel = clampOmpThinkingLevel(defaultThinkingLevel, levels);
  return {
    id: "thinking",
    label: "Thinking",
    type: "select",
    options: levels.map((level): ProviderOptionChoice => ({
      id: level,
      label: OMP_THINKING_LEVEL_LABELS[level],
      ...(level === defaultLevel ? { isDefault: true } : {}),
    })),
  };
}

function clampOmpThinkingLevel(
  input: string | undefined,
  available: ReadonlyArray<OmpThinkingLevel>,
): OmpThinkingLevel | undefined {
  if (input === undefined || !isOmpThinkingLevel(input)) return undefined;
  if (available.includes(input)) return input;
  if (input === "off" || input === "auto") return undefined;
  const requested = OMP_EFFORT_LEVELS.indexOf(input);
  const efforts = OMP_EFFORT_LEVELS.filter((level) => available.includes(level));
  return efforts.find((level) => OMP_EFFORT_LEVELS.indexOf(level) >= requested) ?? efforts.at(-1);
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}
