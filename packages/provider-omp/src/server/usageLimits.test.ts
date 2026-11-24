import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeOmpUsageLimitsProbe, parseOmpUsageLimits, readOmpUsageLimits } from "./usageLimits.ts";

const CHECKED_AT = "2026-11-24T04:00:00.000Z";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const percent = (usedFraction: number) => ({
  used: usedFraction * 100,
  limit: 100,
  remaining: Math.max(0, 100 - usedFraction * 100),
  usedFraction,
  remainingFraction: Math.max(0, 1 - usedFraction),
  unit: "percent",
});

// `omp usage --json` as omp 19.1 prints it: two Claude accounts, Codex with a model-scoped meter,
// and two Copilot accounts, one unlimited (taken from a real run) and one metered.
const OMP_USAGE_REPORT = JSON.stringify({
  generatedAt: 1795479959080,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: 1795479959075,
      limits: [
        {
          id: "anthropic:5h",
          label: "Claude 5 Hour",
          scope: { provider: "anthropic", windowId: "5h", shared: true },
          window: { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS, resetsAt: 1795496400000 },
          amount: percent(0.42),
          status: "ok",
        },
        {
          id: "anthropic:7d",
          label: "Claude 7 Day",
          scope: { provider: "anthropic", windowId: "7d", shared: true },
          window: { id: "7d", label: "7 Day", durationMs: WEEK_MS, resetsAt: 1795996800000 },
          amount: percent(0.9),
          status: "warning",
        },
        {
          id: "anthropic:7d:fable",
          label: "Claude 7 Day (Fable)",
          scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
          window: { id: "7d", label: "7 Day", durationMs: WEEK_MS, resetsAt: 1795996800000 },
          amount: { usedFraction: 1.08, unit: "percent" },
          status: "exhausted",
        },
      ],
      resetCredits: { availableCount: 1, nextCreditId: "credit-1" },
      metadata: {
        email: "first@example.com",
        accountId: "acct-claude-1",
        subscriptionPlan: "Max 20x",
      },
    },
    {
      provider: "anthropic",
      fetchedAt: 1795479959075,
      limits: [
        {
          id: "anthropic:5h",
          label: "Claude 5 Hour",
          scope: { provider: "anthropic", windowId: "5h", shared: true },
          window: { id: "5h", label: "5 Hour", durationMs: FIVE_HOURS_MS },
          amount: percent(0.05),
          status: "ok",
        },
      ],
      metadata: { email: "second@example.com" },
    },
    {
      provider: "openai-codex",
      fetchedAt: 1795479959075,
      limits: [
        {
          id: "openai-codex:primary",
          label: "5 hours",
          scope: { provider: "openai-codex", windowId: "5h", shared: true },
          window: {
            id: "5h",
            label: "5 hours",
            durationMs: FIVE_HOURS_MS,
            resetsAt: 1795496400000,
          },
          amount: percent(0.125),
          status: "ok",
        },
        {
          id: "openai-codex:spark:primary",
          label: "5 hours (Spark)",
          scope: {
            provider: "openai-codex",
            accountId: "acct-codex",
            tier: "spark",
            modelId: "gpt-5.3-codex-spark",
            windowId: "5h",
            shared: true,
          },
          window: { id: "5h", label: "5 hours", durationMs: FIVE_HOURS_MS },
          amount: { used: 30, unit: "percent" },
          status: "ok",
        },
      ],
      metadata: {
        planType: "pro",
        email: "codex@example.com",
        accountId: "acct-codex",
      },
    },
    {
      provider: "github-copilot",
      fetchedAt: 1795479959075,
      limits: [
        {
          id: "copilot:premium",
          label: "Premium Requests",
          scope: {
            provider: "github-copilot",
            accountId: "user-1",
            tier: "business",
            windowId: "monthly",
          },
          window: { id: "monthly", label: "Monthly", resetsAt: 1796083200000 },
          amount: { unit: "requests" },
          status: "ok",
          notes: ["Unlimited"],
        },
      ],
      metadata: {
        accountId: "user-1",
        plan: "business",
        quotaResetDate: "2026-12-01",
        credentialId: 2,
        credentialIds: [2, 3, 4],
      },
    },
    {
      provider: "github-copilot",
      fetchedAt: 1795479959075,
      limits: [
        {
          id: "copilot:premium",
          label: "Premium Requests",
          scope: { provider: "github-copilot", accountId: "user-2", windowId: "monthly" },
          window: { id: "monthly", label: "Monthly", resetsAt: 1796083200000 },
          amount: { remaining: 75, limit: 300, remainingFraction: 0.25, unit: "requests" },
          status: "ok",
        },
      ],
      metadata: { accountId: "user-2" },
    },
  ],
  accountsWithoutUsage: [],
  disabledCredentials: [],
  capacity: {},
});

const fakeOmp = (stdout: string, exitCode = 0) => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (ChildProcess.isStandardCommand(command)) calls.push(command.args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { calls, spawner };
};

describe("parseOmpUsageLimits", () => {
  it("keeps every omp provider and account in its own window", () => {
    assert.deepStrictEqual(parseOmpUsageLimits(OMP_USAGE_REPORT, CHECKED_AT), {
      checkedAt: CHECKED_AT,
      windows: [
        {
          id: "anthropic/first@example.com/anthropic:5h",
          kind: "session",
          label: "Anthropic (first@example.com) · Claude 5 Hour",
          usedPercent: 42,
          providerIds: ["anthropic"],
          resetsAt: "2026-11-24T05:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "anthropic/second@example.com/anthropic:5h",
          kind: "session",
          label: "Anthropic (second@example.com) · Claude 5 Hour",
          usedPercent: 5,
          providerIds: ["anthropic"],
          windowDurationMins: 300,
        },
        {
          id: "openai-codex/codex@example.com/openai-codex:primary",
          kind: "session",
          label: "OpenAI Codex · 5 hours",
          usedPercent: 12.5,
          providerIds: ["openai-codex"],
          resetsAt: "2026-11-24T05:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "openai-codex/codex@example.com/openai-codex:spark:primary",
          kind: "session",
          label: "OpenAI Codex · 5 hours (Spark)",
          usedPercent: 30,
          providerIds: ["openai-codex"],
          modelIds: ["openai-codex/gpt-5.3-codex-spark"],
          windowDurationMins: 300,
        },
        {
          id: "anthropic/first@example.com/anthropic:7d",
          kind: "weekly",
          label: "Anthropic (first@example.com) · Claude 7 Day",
          usedPercent: 90,
          providerIds: ["anthropic"],
          resetsAt: "2026-11-30T00:00:00.000Z",
          windowDurationMins: 10080,
        },
        {
          id: "anthropic/first@example.com/anthropic:7d:fable",
          kind: "weekly",
          label: "Anthropic (first@example.com) · Claude 7 Day (Fable)",
          usedPercent: 100,
          providerIds: ["anthropic"],
          resetsAt: "2026-11-30T00:00:00.000Z",
          windowDurationMins: 10080,
        },
        {
          id: "github-copilot/user-2/copilot:premium",
          kind: "monthly",
          label: "GitHub Copilot (user-2) · Premium Requests",
          usedPercent: 75,
          providerIds: ["github-copilot"],
          resetsAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("reports no limits when no account meters usage, and a failure when reads were missing", () => {
    const empty = { reports: [], accountsWithoutUsage: [], disabledCredentials: [], capacity: {} };
    assert.deepStrictEqual(parseOmpUsageLimits(JSON.stringify(empty), CHECKED_AT)?.unavailable, {
      reason: "unsupported",
    });
    const missing = {
      ...empty,
      accountsWithoutUsage: [{ provider: "anthropic", type: "oauth", email: "a@example.com" }],
    };
    assert.strictEqual(
      parseOmpUsageLimits(JSON.stringify(missing), CHECKED_AT)?.unavailable?.reason,
      "probeFailed",
    );
    assert.isUndefined(parseOmpUsageLimits("No credentials found.", CHECKED_AT));
  });
});

describe("readOmpUsageLimits", () => {
  it.effect("reads `omp usage --json`", () =>
    Effect.gen(function* () {
      const omp = fakeOmp(OMP_USAGE_REPORT);
      const limits = yield* readOmpUsageLimits({ binaryPath: "omp" }, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      assert.deepStrictEqual(omp.calls, [["usage", "--json"]]);
      assert.strictEqual(limits.windows.length, 7);
      assert.isUndefined(limits.unavailable);
    }),
  );

  it.effect("reports a failed read instead of earlier data", () =>
    Effect.gen(function* () {
      for (const omp of [fakeOmp("", 1), fakeOmp("not json")]) {
        const limits = yield* readOmpUsageLimits({ binaryPath: "omp" }, {}).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
        );
        assert.deepStrictEqual(limits.windows, []);
        assert.strictEqual(limits.unavailable?.reason, "probeFailed");
      }
    }),
  );
});

describe("makeOmpUsageLimitsProbe", () => {
  it.effect("reads quota only after an explicit refresh", () =>
    Effect.gen(function* () {
      const omp = fakeOmp(OMP_USAGE_REPORT);
      const probe = yield* makeOmpUsageLimitsProbe({ binaryPath: "omp" }, {});
      const read = probe.read.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      assert.isUndefined(yield* read);
      assert.strictEqual(omp.calls.length, 0);
      yield* probe.invalidate;
      const fresh = yield* read;
      assert.strictEqual(fresh?.windows.length, 7);
      // Background checks reuse that reading without asking omp again.
      assert.strictEqual(yield* read, fresh);
      assert.strictEqual(omp.calls.length, 1);
    }),
  );
});
