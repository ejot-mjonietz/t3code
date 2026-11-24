import { assert, describe, it } from "@effect/vitest";

import {
  makeOmpTurnUsageTally,
  ompProviderFailure,
  ompResumeFailure,
  ompRetryErrorReport,
  ompTurnTokenUsage,
  ompUsageLimitResetAt,
  tallyOmpAssistantMessage,
} from "./turnOutcome.ts";

const OBSERVED_AT_MS = Date.parse("2026-11-24T10:00:00.000Z");
const context = { fallbackMessage: "omp reported a model error.", observedAtMs: OBSERVED_AT_MS };

// pi-ai error/flags.ts: the class bit marks an id as kind flags rather than a bare status.
const CLASSIFIED = 0x1000;
const USAGE_LIMIT = 0x0008_0000;
const TRANSIENT = 0x0002_0000;
const AUTH_FAILED = 0x0100_0000;
const OAUTH_EXPIRED = 0x4000_0000;

describe("omp failure classification", () => {
  it("shows a 429 as a usage limit, with the reset omp's retry hint states", () => {
    const failure = ompProviderFailure(
      {
        message: "429 Too Many Requests: rate_limit_error retry-after-ms=90000",
        httpStatus: 429,
        provider: "anthropic",
      },
      context,
    );
    assert.deepStrictEqual(failure, {
      class: "usage_limit",
      message: "429 Too Many Requests: rate_limit_error",
      code: "http_429",
      retryable: true,
      resetAt: "2026-11-24T10:01:30.000Z",
    });
  });

  it("leaves the reset out when a 429 names none", () => {
    const failure = ompProviderFailure(
      { message: "429 Too Many Requests", httpStatus: 429 },
      context,
    );
    assert.strictEqual(failure.class, "usage_limit");
    assert.isFalse("resetAt" in failure);
  });

  it("reads the status from omp's error id or the text when the message has none", () => {
    assert.strictEqual(
      ompProviderFailure({ message: "Too many requests", errorId: 429 }, context).code,
      "http_429",
    );
    const fromText = ompProviderFailure({ message: 'API Error: 429 {"type":"error"}' }, context);
    assert.strictEqual(fromText.class, "usage_limit");
    assert.strictEqual(fromText.code, "http_429");
    assert.strictEqual(
      ompProviderFailure(
        { message: "The account is blocked for now", errorId: CLASSIFIED | USAGE_LIMIT },
        context,
      ).class,
      "usage_limit",
    );
  });

  it("treats quota and rate-limit wording as a usage limit and parses its reset", () => {
    const quota = ompProviderFailure(
      {
        message:
          "Quota exceeded for quota metric 'Generate Content API requests per minute'. Please retry in 33.5s.",
      },
      context,
    );
    assert.strictEqual(quota.class, "usage_limit");
    assert.strictEqual(quota.code, null);
    assert.isTrue(quota.retryable);
    assert.strictEqual(quota.resetAt, "2026-11-24T10:00:33.500Z");
    assert.strictEqual(
      ompProviderFailure(
        {
          message: "All credentials for model claude-opus-4 are cooling down (reset after 1h2m3s)",
          httpStatus: 429,
        },
        context,
      ).resetAt,
      "2026-11-24T11:02:03.000Z",
    );
  });

  it("marks a spent balance as a usage limit that waiting does not lift", () => {
    for (const report of [
      { message: "insufficient_quota: You exceeded your current quota" },
      { message: "Your credit balance is too low to access the API.", httpStatus: 400 },
      { message: "Payment Required", httpStatus: 402 },
    ]) {
      const failure = ompProviderFailure(report, context);
      assert.strictEqual(failure.class, "usage_limit", report.message);
      assert.isFalse(failure.retryable, report.message);
    }
    // omp is still retrying, so the request may yet go through.
    assert.isTrue(
      ompProviderFailure(
        { message: "Payment Required", httpStatus: 402 },
        { ...context, retrying: true },
      ).retryable,
    );
  });

  it("names the omp sign-in steps for rejected credentials", () => {
    const unauthorized = ompProviderFailure(
      {
        message:
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        httpStatus: 401,
        provider: "anthropic",
      },
      context,
    );
    assert.strictEqual(unauthorized.class, "permission_error");
    assert.strictEqual(unauthorized.code, "http_401");
    assert.isFalse(unauthorized.retryable);
    assert.isTrue(
      unauthorized.message.startsWith(
        "omp could not authenticate with the anthropic provider. Run `omp` in a terminal, then `/login`",
      ),
    );
    assert.include(unauthorized.message, "invalid x-api-key");
    for (const report of [
      { message: "Token refresh failed: invalid_grant", errorId: CLASSIFIED | OAUTH_EXPIRED },
      { message: "No API key for provider: openai" },
      { message: "OAuth token has expired. Please log in again." },
    ]) {
      const failure = ompProviderFailure(report, context);
      assert.strictEqual(failure.class, "permission_error", report.message);
      assert.include(failure.message, "`/login`", report.message);
    }
  });

  it("keeps a 403's own reason, since signing in again may not grant access", () => {
    const failure = ompProviderFailure(
      {
        message: "403 Forbidden: this model is not available on your plan",
        httpStatus: 403,
        provider: "openai-codex",
      },
      context,
    );
    assert.strictEqual(failure.class, "permission_error");
    assert.isTrue(
      failure.message.startsWith("The openai-codex provider refused the request (HTTP 403)."),
    );
    assert.include(failure.message, "`/login`");
    assert.include(failure.message, "this model is not available on your plan");
  });

  it("leaves other failures as provider errors with omp's own retry verdict", () => {
    assert.deepStrictEqual(
      ompProviderFailure({ message: "500 Internal Server Error", httpStatus: 500 }, context),
      {
        class: "provider_error",
        message: "500 Internal Server Error",
        code: "http_500",
        retryable: null,
      },
    );
    assert.isTrue(
      ompProviderFailure({ message: "overloaded" }, { ...context, retryable: true }).retryable,
    );
    assert.isTrue(
      ompProviderFailure({ message: "overloaded" }, { ...context, retrying: true }).retryable,
    );
    // omp flags an auth-sounding outage, but a server error is no credential problem.
    assert.strictEqual(
      ompProviderFailure(
        {
          message: "503 authentication backend unavailable",
          httpStatus: 503,
          errorId: CLASSIFIED | AUTH_FAILED | TRANSIENT,
        },
        context,
      ).class,
      "provider_error",
    );
    assert.strictEqual(
      ompProviderFailure({ message: undefined }, context).message,
      "omp reported a model error.",
    );
  });

  it("reports omp's session cost cap as a usage limit with no reset", () => {
    const failure = ompProviderFailure(
      { message: "Session cost cap reached", code: "cost_cap" },
      context,
    );
    assert.strictEqual(failure.class, "usage_limit");
    assert.strictEqual(failure.code, "cost_cap");
    assert.isFalse(failure.retryable);
    assert.isFalse("resetAt" in failure);
  });
});

describe("omp usage-limit reset times", () => {
  it("reads zoned stamps and takes the latest signal", () => {
    assert.strictEqual(
      ompUsageLimitResetAt("Your limit will reset at 2026-11-24T15:30:00Z", OBSERVED_AT_MS),
      "2026-11-24T15:30:00.000Z",
    );
    assert.strictEqual(
      ompUsageLimitResetAt("limit reached, reset at 2026-11-24 20:00:00+0800", OBSERVED_AT_MS),
      "2026-11-24T12:00:00.000Z",
    );
    assert.strictEqual(
      ompUsageLimitResetAt(
        "rate limited, try again in 5 minutes retry-after-ms=60000",
        OBSERVED_AT_MS,
      ),
      "2026-11-24T10:05:00.000Z",
    );
    assert.strictEqual(
      ompUsageLimitResetAt("Resets in 2hr 15min", OBSERVED_AT_MS),
      "2026-11-24T12:15:00.000Z",
    );
  });

  it("ignores wall clocks without a zone, past resets and vague wording", () => {
    for (const text of [
      "Your limit will reset at 2026-11-24 15:30:00",
      "usage limit, reset at 2026-11-24T09:00:00Z",
      "try again in a few minutes",
      "retry in 5 constructor",
      undefined,
    ]) {
      assert.isUndefined(ompUsageLimitResetAt(text, OBSERVED_AT_MS), String(text));
    }
  });
});

describe("omp retries and resumes", () => {
  it("keeps the failed message's status when a retry frame repeats its text", () => {
    const lastModelError = { message: "429 rate limited", httpStatus: 429, provider: "anthropic" };
    assert.deepStrictEqual(ompRetryErrorReport(lastModelError, "429 rate limited", 7), {
      ...lastModelError,
      errorId: 7,
    });
    assert.strictEqual(ompRetryErrorReport(lastModelError, undefined), lastModelError);
    assert.deepStrictEqual(ompRetryErrorReport(lastModelError, "Recovery gave up"), {
      message: "Recovery gave up",
      errorId: undefined,
      provider: "anthropic",
    });
    assert.deepStrictEqual(ompRetryErrorReport(null, "boom"), {
      message: "boom",
      errorId: undefined,
      provider: undefined,
    });
  });

  it("fails a resume with nothing to continue as the user's input, not a provider fault", () => {
    assert.deepStrictEqual(ompResumeFailure("Nothing to resume", OBSERVED_AT_MS), {
      class: "validation_error",
      message: "omp has nothing to continue in this conversation. Send a message instead.",
      code: "nothing_to_resume",
      retryable: false,
    });
    assert.strictEqual(ompResumeFailure("socket closed", OBSERVED_AT_MS).class, "provider_error");
    assert.strictEqual(
      ompResumeFailure(undefined, OBSERVED_AT_MS).message,
      "omp could not continue the conversation.",
    );
  });
});

const assistant = (usage: unknown, model = "gpt-5") => ({
  role: "assistant",
  provider: "openai",
  model,
  usage,
});

describe("omp turn token usage", () => {
  it("sums every assistant message, counting cache reads and writes as input", () => {
    const tally = makeOmpTurnUsageTally();
    tallyOmpAssistantMessage(
      tally,
      assistant({ input: 100, output: 20, cacheRead: 1_000, cacheWrite: 50, reasoningTokens: 5 }),
    );
    tallyOmpAssistantMessage(
      tally,
      assistant({ input: 10, output: 30, cacheRead: 1_200, cacheWrite: 0, reasoningTokens: 10 }),
    );
    assert.deepStrictEqual(
      ompTurnTokenUsage(tally, { completed: true, hasSubagents: true, localCommand: false }),
      {
        usageScope: "main_agent",
        hasSubagents: true,
        models: ["openai/gpt-5"],
        inputTokens: 2_360,
        cachedInputTokens: 2_200,
        cacheCreationTokens: 50,
        outputTokens: 50,
        reasoningTokens: 15,
        usageStatus: "complete",
      },
    );
  });

  it("is partial when a message lacked usage or the turn did not complete", () => {
    const tally = makeOmpTurnUsageTally();
    tallyOmpAssistantMessage(
      tally,
      assistant({ input: 5, output: 7, cacheRead: 0, cacheWrite: 0 }),
    );
    tallyOmpAssistantMessage(tally, assistant(undefined, "gpt-5-mini"));
    tallyOmpAssistantMessage(tally, assistant({ input: -1, output: 3 }));
    assert.deepStrictEqual(
      ompTurnTokenUsage(tally, { completed: true, hasSubagents: false, localCommand: false }),
      {
        usageScope: "main_agent",
        hasSubagents: false,
        models: ["openai/gpt-5", "openai/gpt-5-mini"],
        inputTokens: 5,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 7,
        usageStatus: "partial",
      },
    );

    const interrupted = makeOmpTurnUsageTally();
    tallyOmpAssistantMessage(
      interrupted,
      assistant({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    );
    assert.strictEqual(
      ompTurnTokenUsage(interrupted, { completed: false, hasSubagents: false, localCommand: false })
        .usageStatus,
      "partial",
    );
  });

  it("reports reasoning only when every message did", () => {
    const tally = makeOmpTurnUsageTally();
    tallyOmpAssistantMessage(
      tally,
      assistant({ input: 1, output: 40, cacheRead: 0, cacheWrite: 0, reasoningTokens: 60 }),
    );
    assert.strictEqual(
      ompTurnTokenUsage(tally, { completed: true, hasSubagents: false, localCommand: false })
        .reasoningTokens,
      40,
    );
    tallyOmpAssistantMessage(
      tally,
      assistant({ input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }),
    );
    assert.isFalse(
      "reasoningTokens" in
        ompTurnTokenUsage(tally, { completed: true, hasSubagents: false, localCommand: false }),
    );
  });

  it("is unavailable without metered messages, marking a local command", () => {
    assert.deepStrictEqual(
      ompTurnTokenUsage(makeOmpTurnUsageTally(), {
        completed: true,
        hasSubagents: false,
        localCommand: true,
      }),
      {
        usageScope: "main_agent",
        hasSubagents: false,
        localCommand: true,
        usageStatus: "unavailable",
      },
    );
  });
});
