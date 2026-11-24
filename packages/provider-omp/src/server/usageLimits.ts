import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import {
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpSettings } from "../settings.ts";
import { ompProviderName } from "./providerNames.ts";
import { runOmpSubcommand } from "./roles.ts";

const USAGE_PROBE_TIMEOUT_MS = 20_000;
const DAY_MINS = 24 * 60;
const UNREADABLE_MESSAGE = "omp could not report usage limits.";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

type Json = Readonly<Record<string, unknown>>;

const records = (value: unknown): ReadonlyArray<Json> =>
  Array.isArray(value) ? value.filter(Predicate.isObject) : [];

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** omp's `resolveUsedFraction`: explicit fraction, used/limit, percent units, then remaining. */
function usedPercent(amount: Json): number | undefined {
  const usedFraction = finite(amount["usedFraction"]);
  if (usedFraction !== undefined) return usedFraction * 100;
  const used = finite(amount["used"]);
  const limit = finite(amount["limit"]);
  if (used !== undefined && limit !== undefined && limit > 0) return (used / limit) * 100;
  if (amount["unit"] === "percent" && used !== undefined) return used;
  const remainingFraction = finite(amount["remainingFraction"]);
  return remainingFraction === undefined ? undefined : Math.max(0, 1 - remainingFraction) * 100;
}

function windowKind(
  durationMins: number | undefined,
  windowId: string | undefined,
): ServerProviderUsageWindow["kind"] {
  // Window ids such as `5h` and `7d` name their length when omp reports no duration.
  const span = windowId?.match(/^(\d+)([hd])$/i);
  const mins =
    durationMins ??
    (span ? Number(span[1]) * (span[2]!.toLowerCase() === "d" ? DAY_MINS : 60) : undefined);
  if (mins !== undefined) {
    if (mins >= 28 * DAY_MINS) return "monthly";
    if (mins >= 7 * DAY_MINS) return "weekly";
    return "session";
  }
  if (windowId !== undefined && /month/i.test(windowId)) return "monthly";
  if (windowId !== undefined && /week/i.test(windowId)) return "weekly";
  return "other";
}

/** The identity omp's own usage view names an account by. */
function accountName(report: Json, limits: ReadonlyArray<Json>): string | undefined {
  const metadata: Json = Predicate.isObject(report["metadata"]) ? report["metadata"] : {};
  for (const key of ["email", "accountId", "projectId"]) {
    const value = text(metadata[key]);
    if (value !== undefined) return value;
  }
  for (const limit of limits) {
    const scope: Json = Predicate.isObject(limit["scope"]) ? limit["scope"] : {};
    const value = text(scope["accountId"]) ?? text(scope["projectId"]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Maps `omp usage --json` onto T3's usage windows. Every window keeps its omp provider and
 * account in its id and label, so accounts never pool into one bar. Undefined when the output is
 * not a usage report.
 */
export function parseOmpUsageLimits(
  stdout: string,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const parsed = Option.getOrUndefined(decodeJson(stdout.trim()));
  if (!Predicate.isObject(parsed) || !Array.isArray(parsed["reports"])) return undefined;
  const reports = records(parsed["reports"]).flatMap((report) => {
    const provider = text(report["provider"]);
    return provider === undefined ? [] : [{ provider, report, limits: records(report["limits"]) }];
  });
  const accountCounts = new Map<string, number>();
  for (const { provider } of reports) {
    accountCounts.set(provider, (accountCounts.get(provider) ?? 0) + 1);
  }
  const accountOrdinals = new Map<string, number>();
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const { provider, report, limits } of reports) {
    const ordinal = (accountOrdinals.get(provider) ?? 0) + 1;
    accountOrdinals.set(provider, ordinal);
    const account = accountName(report, limits);
    const accountKey = account ?? `#${ordinal}`;
    const providerName = ompProviderName(provider);
    const owner =
      (accountCounts.get(provider) ?? 0) > 1
        ? `${providerName} (${account ?? `account ${ordinal}`})`
        : providerName;
    for (const limit of limits) {
      const limitId = text(limit["id"]);
      const label = text(limit["label"]);
      const percent = Predicate.isObject(limit["amount"])
        ? usedPercent(limit["amount"])
        : undefined;
      // Unlimited and amount-only quotas have no percentage to show.
      if (limitId === undefined || label === undefined || percent === undefined) continue;
      const id = `${provider}/${accountKey}/${limitId}`;
      if (windows.has(id)) continue;
      const scope: Json = Predicate.isObject(limit["scope"]) ? limit["scope"] : {};
      const window: Json = Predicate.isObject(limit["window"]) ? limit["window"] : {};
      const durationMs = finite(window["durationMs"]);
      const windowDurationMins =
        durationMs !== undefined && durationMs > 0 ? Math.round(durationMs / 60_000) : undefined;
      const resetsAtMs = finite(window["resetsAt"]);
      const resetsAt =
        resetsAtMs !== undefined && resetsAtMs > 0
          ? Option.getOrUndefined(Option.map(DateTime.make(resetsAtMs), DateTime.formatIso))
          : undefined;
      const modelId = text(scope["modelId"]);
      windows.set(id, {
        id,
        kind: windowKind(windowDurationMins, text(window["id"]) ?? text(scope["windowId"])),
        label: `${owner} · ${label}`,
        usedPercent: clampPercent(percent),
        // T3 model slugs are omp selectors, `provider/model`.
        providerIds: [provider],
        ...(modelId === undefined ? {} : { modelIds: [`${provider}/${modelId}`] }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      });
    }
  }
  if (windows.size > 0) return makeUsageLimits({ checkedAt, windows: windows.values() });
  // Accounts whose provider meters usage but sent no report are failed reads, not missing limits.
  return records(parsed["accountsWithoutUsage"]).length > 0
    ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message: UNREADABLE_MESSAGE })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

/** Runs `omp usage --json`. A failure or timeout reads as `probeFailed`, never as earlier data. */
export const readOmpUsageLimits = Effect.fn("readOmpUsageLimits")(function* (
  settings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<ServerProviderUsageLimits, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runOmpSubcommand(
    settings,
    providerProbeEnvironment(environment),
    cwd,
    ["usage", "--json"],
    resolveProviderProbeTimeoutMs("omp", USAGE_PROBE_TIMEOUT_MS, environment),
  ).pipe(Effect.result);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const limits = Result.isSuccess(result)
    ? parseOmpUsageLimits(result.success, checkedAt)
    : undefined;
  if (limits !== undefined) return limits;
  yield* Effect.logWarning("omp usage limits read failed.", {
    errorTag: Result.isFailure(result) ? result.failure._tag : "UnreadableReport",
  });
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: UNREADABLE_MESSAGE,
  });
});

export interface OmpUsageLimitsProbe {
  /** Makes the next status check read quota again. */
  readonly invalidate: Effect.Effect<void>;
  /** A fresh reading after `invalidate`, otherwise the last one (none before the first). */
  readonly read: Effect.Effect<
    ServerProviderUsageLimits | undefined,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
}

/**
 * `omp usage` makes network requests and may revalidate credentials, so passive status checks
 * reuse the last reading and only an explicit refresh, through `invalidate`, reads again.
 */
export const makeOmpUsageLimitsProbe = Effect.fn("makeOmpUsageLimitsProbe")(function* (
  settings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const stale = yield* Ref.make(false);
  const latest = yield* Ref.make<ServerProviderUsageLimits | undefined>(undefined);
  return {
    invalidate: Ref.set(stale, true),
    read: Effect.uninterruptibleMask((restore) =>
      Ref.getAndSet(stale, false).pipe(
        Effect.flatMap((refresh) =>
          refresh
            ? restore(readOmpUsageLimits(settings, environment, cwd)).pipe(
                Effect.tap((limits) => Ref.set(latest, limits)),
                // An interrupted read leaves the refresh pending for the next check.
                Effect.onInterrupt(() => Ref.set(stale, true)),
              )
            : Ref.get(latest),
        ),
      ),
    ),
  } satisfies OmpUsageLimitsProbe;
});
