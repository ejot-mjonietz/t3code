import type { OrchestrationV2ProviderFailure, TurnTokenUsage } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { ompRecordField, ompRecordNumber, ompRecordString } from "./rpc.ts";

// Bits of pi-ai's `error/flags.ts` Flag that omp sends as an assistant message's `errorId`.
// An id without the class bit is a bare HTTP status.
const OMP_ERROR_CLASSIFIED = 0x1000;
const OMP_ERROR_USAGE_LIMIT = 0x0008_0000;
const OMP_ERROR_AUTH_FAILED = 0x0100_0000;
const OMP_ERROR_OAUTH_EXPIRED = 0x4000_0000;

// omp appends the provider's retry headers to the error text as `retry-after-ms=<n>`.
const RETRY_AFTER_MS_HINT = /\bretry-after-ms\s*[:=]\s*(\d{1,12})\b/i;
const RETRY_AFTER_MS_HINT_DISPLAY = /\s*\bretry-after-ms\s*=\s*\d{1,12}\b/gi;
// Only stamps that carry their zone; a wall clock in an unknown zone is not a reset time.
const RESET_AT_TIMESTAMP =
  /(?:\bresets?\s+at\s+|"quotaResetTimeStamp"\s*:\s*")(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i;
// "reset after 1h2m3s", "resets in 2hr 15min", "try again in 5 minutes", "Please retry in 12.5s".
const RESET_AFTER_DURATION =
  /\b(?:reset after|resets? in|try again in|retry in)\s+~?\s*((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*)+)/i;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};
const MAX_DATE_MS = 8.64e15;

const LEADING_STATUS = /^\s*(?:(?:API Error|Error|HTTP|status(?:_code)?)\s*:?\s*)?([45]\d{2})\b/i;
const INLINE_STATUS = /\b(?:HTTP|status(?:_code)?)"?\s*[:=]?\s*([45]\d{2})\b/i;

const USAGE_LIMIT_TEXT =
  /\brate[ _-]?limit|\btoo many requests\b|\busage[ _-]?limit|\bquota\b|\bresource[ _-]?exhausted\b|\b(?:hourly|daily|weekly|monthly|5[ -]?hour)\s+(?:usage\s+)?limit\b/i;
// Spent credit or a billing cap: waiting does not lift it.
const BILLING_TEXT =
  /\binsufficient[ _-]?(?:quota|credits?|balance|funds)\b|\bcredit balance is too low\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted|used up)\b|\bexceed\w*\b[^\n]{0,40}\bcredits?\b|\b(?:spend(?:ing)?|billing)[ _-]?(?:limit|cap)\b|\bpayment[ _-]?required\b|\bprepaid balance\b/i;
const SIGN_IN_TEXT =
  /\bunauthori[sz]ed\b|\bauthentication[ _-]?(?:failed|error|required)\b|\b(?:invalid|incorrect)[ _-]?(?:x-)?api[ _-]?key\b|\b(?:invalid|expired|revoked|missing)[ _-]?(?:access|auth|oauth|refresh|bearer|session)[ _-]?token\b|\b(?:access|auth|oauth|refresh|bearer)[ _-]?token\b[^\n]{0,30}\b(?:invalid|expired|revoked)\b|\b(?:api[ _-]?key|credentials?)\b[^\n]{0,30}\b(?:invalid|expired|revoked|incorrect)\b|\binvalid[ _-]?credentials?\b|\binvalid_grant\b|\binvalid_token\b|\bno api key\b|\bnot (?:logged|signed) in\b|\bsigned out\b|\b(?:log|sign)[ -]?in again\b/i;

const SIGN_IN_GUIDANCE =
  "Run `omp` in a terminal, then `/login` to sign in again (or check the API key omp uses), and retry the turn.";
const MAX_FAILURE_DETAIL_CHARS = 1_000;

/** What omp reports about a failed model request. */
export interface OmpErrorReport {
  readonly message: string | undefined;
  /** The provider's HTTP status (`errorStatus`, or a prompt error's `httpStatus`). */
  readonly httpStatus?: number | undefined;
  /** omp's own classification of the error (`errorId`). */
  readonly errorId?: number | undefined;
  /** The model provider omp sent the request to. */
  readonly provider?: string | undefined;
  /** A prompt error's machine code, such as `cost_cap`. */
  readonly code?: string | undefined;
}

export interface OmpFailureContext {
  readonly fallbackMessage: string;
  /** When omp reported the failure; a relative reset hint counts from here. */
  readonly observedAtMs: number;
  /** omp is retrying the request itself. */
  readonly retrying?: boolean;
  /** omp's own verdict on resubmitting a failure T3 does not classify further. */
  readonly retryable?: boolean | null;
}

type OmpFailureKind = "usage_limit" | "billing" | "sign_in" | "forbidden" | "other";

function unclassifiedStatus(errorId: number | undefined): number | undefined {
  return errorId !== undefined &&
    Number.isInteger(errorId) &&
    (errorId & OMP_ERROR_CLASSIFIED) === 0 &&
    errorId >= 100 &&
    errorId <= 599
    ? errorId
    : undefined;
}

function flagged(errorId: number | undefined, flag: number): boolean {
  return (
    errorId !== undefined &&
    Number.isInteger(errorId) &&
    (errorId & OMP_ERROR_CLASSIFIED) !== 0 &&
    (errorId & flag) !== 0
  );
}

function reportStatus(report: OmpErrorReport): number | undefined {
  const reported = report.httpStatus ?? unclassifiedStatus(report.errorId);
  if (reported !== undefined) return Number.isInteger(reported) ? reported : undefined;
  const text = report.message;
  const match = text === undefined ? null : (LEADING_STATUS.exec(text) ?? INLINE_STATUS.exec(text));
  return match === null ? undefined : Number(match[1]);
}

function failureKind(report: OmpErrorReport, status: number | undefined): OmpFailureKind {
  const text = report.message ?? "";
  if (status === 401 || flagged(report.errorId, OMP_ERROR_OAUTH_EXPIRED)) return "sign_in";
  if (status === 402 || BILLING_TEXT.test(text)) return "billing";
  if (
    status === 429 ||
    flagged(report.errorId, OMP_ERROR_USAGE_LIMIT) ||
    USAGE_LIMIT_TEXT.test(text)
  )
    return "usage_limit";
  // A 403 can be a plan or model entitlement that signing in again does not grant.
  if (status === 403) return "forbidden";
  const clientError = status === undefined || (status >= 400 && status < 500);
  if (clientError && (SIGN_IN_TEXT.test(text) || flagged(report.errorId, OMP_ERROR_AUTH_FAILED)))
    return "sign_in";
  return "other";
}

function durationMs(expression: string): number | undefined {
  let total: number | undefined;
  for (const part of expression.matchAll(DURATION_PART)) {
    const unitName = part[2]!.toLowerCase();
    if (!Object.hasOwn(DURATION_UNIT_MS, unitName)) break;
    total = (total ?? 0) + Number(part[1]) * DURATION_UNIT_MS[unitName]!;
  }
  return total;
}

/**
 * The reset time a usage-limit error states: omp's retry-header hint, a zoned
 * `reset at` stamp, or a `reset after`/`try again in` duration from when omp
 * reported it. Undefined when the text names none or only a past one.
 */
export function ompUsageLimitResetAt(
  text: string | undefined,
  observedAtMs: number,
): string | undefined {
  if (text === undefined || !Number.isFinite(observedAtMs)) return undefined;
  const candidates: Array<number> = [];
  const hintMs = RETRY_AFTER_MS_HINT.exec(text)?.[1];
  if (hintMs !== undefined) candidates.push(observedAtMs + Number(hintMs));
  const stamp = RESET_AT_TIMESTAMP.exec(text)?.[1];
  if (stamp !== undefined) {
    candidates.push(Date.parse(stamp.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2")));
  }
  const duration = RESET_AFTER_DURATION.exec(text)?.[1];
  const delayMs = duration === undefined ? undefined : durationMs(duration);
  if (delayMs !== undefined) candidates.push(observedAtMs + delayMs);
  // Several signals can each describe the block; the latest is when all of them lift.
  const resetMs = candidates
    .filter((candidate) => Number.isFinite(candidate))
    .reduce<number | undefined>(
      (latest, candidate) => (latest === undefined || candidate > latest ? candidate : latest),
      undefined,
    );
  return resetMs === undefined || resetMs <= observedAtMs || resetMs >= MAX_DATE_MS
    ? undefined
    : Option.getOrUndefined(Option.map(DateTime.make(Math.round(resetMs)), DateTime.formatIso));
}

/**
 * Maps an omp model or prompt error onto T3's failure classes: usage and billing
 * limits become `usage_limit`, rejected credentials `permission_error` with
 * omp's sign-in steps, and everything else stays `provider_error`.
 */
export function ompProviderFailure(
  report: OmpErrorReport,
  context: OmpFailureContext,
): OrchestrationV2ProviderFailure {
  const detail = report.message?.replace(RETRY_AFTER_MS_HINT_DISPLAY, "").trim();
  const retrying = context.retrying === true;
  if (report.code === "cost_cap") {
    return makeProviderFailure({
      class: "usage_limit",
      message:
        "omp stopped because this session reached its cost cap (`session.maxCost`). Raise the cap in omp's settings to continue.",
      code: "cost_cap",
      retryable: false,
    });
  }
  const status = reportStatus(report);
  const kind = failureKind(report, status);
  const code = status === undefined ? null : `http_${status}`;
  const provider = report.provider?.trim();
  const providerName = provider ? `${provider} provider` : "model provider";
  // Sign-in guidance leads; the provider's own words follow for diagnosis.
  const detailSuffix = detail ? `\n\n${detail.slice(0, MAX_FAILURE_DETAIL_CHARS)}` : "";
  switch (kind) {
    case "usage_limit":
    case "billing":
      return makeProviderFailure({
        class: "usage_limit",
        message:
          detail ||
          (kind === "billing"
            ? `The ${providerName} reports that the account is out of credit.`
            : `The ${providerName} reports a usage limit.`),
        code,
        // A spent balance needs payment; other limits lift on their own.
        retryable: retrying || kind === "usage_limit",
        resetAt: ompUsageLimitResetAt(report.message, context.observedAtMs) ?? null,
      });
    case "sign_in":
      return makeProviderFailure({
        class: "permission_error",
        message: `omp could not authenticate with the ${providerName}. ${SIGN_IN_GUIDANCE}${detailSuffix}`,
        code,
        retryable: retrying,
      });
    case "forbidden":
      return makeProviderFailure({
        class: "permission_error",
        message: `The ${providerName} refused the request (HTTP 403). Check that your account can use this model, or run \`omp\` in a terminal, then \`/login\` to sign in with another account.${detailSuffix}`,
        code,
        retryable: retrying,
      });
    case "other":
      return makeProviderFailure({
        class: "provider_error",
        message: detail || context.fallbackMessage,
        code,
        retryable: retrying || (context.retryable ?? null),
      });
  }
}

/**
 * A retry frame's error. omp sends only its text (and on start its `errorId`); the
 * failed message it repeats carries the status and provider.
 */
export function ompRetryErrorReport(
  lastModelError: OmpErrorReport | null,
  message: string | undefined,
  errorId?: number,
): OmpErrorReport {
  if (lastModelError !== null && (message === undefined || message === lastModelError.message)) {
    return errorId === undefined ? lastModelError : { ...lastModelError, errorId };
  }
  return { message, errorId, provider: lastModelError?.provider };
}

/** omp answers `resume` with this when the conversation holds nothing to continue. */
const OMP_NOTHING_TO_RESUME = "Nothing to resume";

/** A rejected native resume: nothing to continue is the user's call, not a provider fault. */
export function ompResumeFailure(
  rejection: string | undefined,
  observedAtMs: number,
): OrchestrationV2ProviderFailure {
  if (rejection?.trim() === OMP_NOTHING_TO_RESUME) {
    return makeProviderFailure({
      class: "validation_error",
      message: "omp has nothing to continue in this conversation. Send a message instead.",
      code: "nothing_to_resume",
      retryable: false,
    });
  }
  return ompProviderFailure(
    { message: rejection },
    { fallbackMessage: "omp could not continue the conversation.", observedAtMs },
  );
}

/** Billed token counts of one turn's root assistant messages. */
export interface OmpTurnUsageTally {
  assistantMessages: number;
  /** Messages whose usage carried input and output counts. */
  meteredMessages: number;
  /** Uncached input plus cache reads and writes, as T3 counts input. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /** Includes reasoning. */
  outputTokens: number;
  reasoningTokens: number;
  /** Metered messages that reported `reasoningTokens`; omp leaves it unset when unknown. */
  reasoningMessages: number;
  /** `provider/model` as omp reported each message. */
  readonly models: Set<string>;
}

export const makeOmpTurnUsageTally = (): OmpTurnUsageTally => ({
  assistantMessages: 0,
  meteredMessages: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  reasoningMessages: 0,
  models: new Set(),
});

function tokenCount(usage: unknown, key: string): number | undefined {
  const value = ompRecordNumber(usage, key);
  return value === undefined || value < 0 ? undefined : Math.trunc(value);
}

/** Adds one finished assistant message; streamed updates repeat its usage, so count only `message_end`. */
export function tallyOmpAssistantMessage(tally: OmpTurnUsageTally, message: unknown): void {
  tally.assistantMessages += 1;
  const provider = ompRecordString(message, "provider");
  const model = ompRecordString(message, "model");
  if (provider && model) tally.models.add(`${provider}/${model}`);
  const usage = ompRecordField(message, "usage");
  const input = tokenCount(usage, "input");
  const output = tokenCount(usage, "output");
  if (input === undefined || output === undefined) return;
  const cacheRead = tokenCount(usage, "cacheRead") ?? 0;
  const cacheWrite = tokenCount(usage, "cacheWrite") ?? 0;
  tally.meteredMessages += 1;
  tally.inputTokens += input + cacheRead + cacheWrite;
  tally.cachedInputTokens += cacheRead;
  tally.cacheCreationTokens += cacheWrite;
  tally.outputTokens += output;
  const reasoning = tokenCount(usage, "reasoningTokens");
  if (reasoning !== undefined) {
    tally.reasoningTokens += Math.min(output, reasoning);
    tally.reasoningMessages += 1;
  }
}

/**
 * The turn's billed usage. Complete only for a turn that completed with usage
 * on every assistant message; omp reports no ledger for work beyond them.
 */
export function ompTurnTokenUsage(
  tally: OmpTurnUsageTally,
  outcome: {
    readonly completed: boolean;
    readonly hasSubagents: boolean;
    /** A slash command omp ran without the model. */
    readonly localCommand: boolean;
  },
): TurnTokenUsage {
  const common = {
    usageScope: "main_agent" as const,
    hasSubagents: outcome.hasSubagents,
    ...(tally.models.size === 0 ? {} : { models: [...tally.models] }),
    ...(outcome.localCommand ? { localCommand: true } : {}),
  };
  if (tally.meteredMessages === 0) return { ...common, usageStatus: "unavailable" };
  const counts = {
    inputTokens: tally.inputTokens,
    cachedInputTokens: tally.cachedInputTokens,
    cacheCreationTokens: tally.cacheCreationTokens,
    outputTokens: tally.outputTokens,
    // A sum over only some messages would understate it.
    ...(tally.reasoningMessages === tally.meteredMessages
      ? { reasoningTokens: tally.reasoningTokens }
      : {}),
  };
  return outcome.completed && tally.meteredMessages === tally.assistantMessages
    ? { ...common, ...counts, usageStatus: "complete" }
    : { ...common, ...counts, usageStatus: "partial" };
}
