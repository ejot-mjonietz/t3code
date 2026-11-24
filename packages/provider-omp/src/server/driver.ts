// omp keeps user-wide state in ~/.omp/agent, so continuation identity uses default instance grouping.
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeOmpTextGeneration } from "./textGeneration.ts";
import { OmpAdapterV2Driver, type OmpAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  discoverOmpCommandsForCwd,
  enrichOmpSnapshot,
} from "./status.ts";
import { syncOmpModelRolesToConfig } from "./roles.ts";
import { ompUsageReader, type OmpUsageReaderEnv } from "./usage.ts";
import { makeOmpUsageLimitsProbe } from "./usageLimits.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

const DRIVER_KIND = ProviderDriverKind.make("omp");
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@oh-my-pi/pi-coding-agent",
  nativeUpdate: { args: ["update"] },
});

export type OmpDriverEnv =
  | OmpAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, OmpUsageReaderEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Oh My Pi",
    supportsMultipleInstances: true,
  },
  usage: ompUsageReader,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: Effect.fn("OmpDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    // omp runs extensions in its cwd; the server's cwd is $HOME on packaged desktop.
    const probeCwd = pathService.join(host.paths.providerStatusCacheDir, "omp-status-probe");
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    // Settings edits reach omp's own config.yml once, so the omp CLI picks them up too.
    if (effectiveConfig.enabled && effectiveConfig.saveModelRolesToOmpConfig) {
      yield* fileSystem.makeDirectory(probeCwd, { recursive: true }).pipe(
        Effect.ignore,
        Effect.andThen(
          syncOmpModelRolesToConfig(
            effectiveConfig,
            processEnv,
            pathService.join(
              host.paths.providerStatusCacheDir,
              `omp-model-roles-${String(instanceId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
            ),
            probeCwd,
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not save omp model roles to its config.", {
            cause: String(cause).slice(0, 200),
          }),
        ),
        Effect.forkDetach,
      );
    }

    const orchestrationAdapter = yield* OmpAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build omp orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeOmpTextGeneration(effectiveConfig, processEnv);
    // `omp usage` makes network requests, so only explicit refreshes read quota; passive checks
    // republish the last reading.
    const usageLimits = yield* makeOmpUsageLimitsProbe(effectiveConfig, processEnv, probeCwd);

    const checkProvider = fileSystem
      .makeDirectory(probeCwd, { recursive: true })
      .pipe(
        Effect.ignore,
        Effect.andThen(
          checkOmpProviderStatus(
            effectiveConfig,
            processEnv,
            probeCwd,
            host.compatibility,
            usageLimits.read,
          ),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      invalidateUsageCache: usageLimits.invalidate,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichOmpSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build omp snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      // User refreshes, such as opening the Limits view, read omp's quota first.
      snapshot: {
        ...snapshot,
        refresh: usageLimits.invalidate.pipe(Effect.andThen(snapshot.refresh)),
      },
      snapshotForCwd: (workspaceCwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverOmpCommandsForCwd(effectiveConfig, processEnv, workspaceCwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: "Failed to discover omp workspace commands.",
                      cause,
                    }),
                ),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, commands]) => ({
                ...machineSnapshot,
                ...commands,
                slashCommandsPending: false,
              })),
            ),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
