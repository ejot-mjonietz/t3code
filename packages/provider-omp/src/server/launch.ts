import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { RuntimeMode } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

import {
  OMP_T3_EXTENSION_FILENAME,
  OMP_T3_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_OMP_INSTRUCTIONS_FILE_ENV,
} from "./t3ExtensionSource.ts";

const RESERVED_OMP_LAUNCH_ARGUMENTS = new Set([
  "--alias",
  "--approval-mode",
  "--auto-approve",
  "--continue",
  "-c",
  "--cwd",
  "--export",
  "--from-claude",
  "--from-codex",
  "--goal",
  "--help",
  "-h",
  "--mode",
  "--no-session",
  "--plan-yolo",
  "--print",
  "-p",
  "--restore",
  "--resume",
  "-r",
  "--session",
  "--version",
  "-v",
]);

export const OMP_ARGUMENTS_WITH_VALUES: ReadonlySet<string> = new Set([
  "--add-dir",
  "--api-key",
  "--append-system-prompt",
  "--config",
  "--extension",
  "-e",
  "--hook",
  "--max-cost",
  "--max-time",
  "--model",
  "--models",
  "--plan",
  "--plan-yolo-into",
  "--prewalk-into",
  "--profile",
  "--provider",
  "--service-tier",
  "--session-dir",
  "--skills",
  "--slow",
  "--smol",
  "--system-prompt",
  "--system-prompt-template",
  "--thinking",
  "--tools",
  "--warn-cost",
]);

export type OmpLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedOmpArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_OMP_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

export function resolveOmpLaunchArgs(launchArgs: string): OmpLaunchArgsResolution {
  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedOmpArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `omp launch argument '${reserved}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return { ok: false, message: "omp launch arguments cannot include positional prompts." };
    }
    if (OMP_ARGUMENTS_WITH_VALUES.has(arg)) {
      if (args[index + 1] === undefined) {
        return { ok: false, message: `omp launch argument '${arg}' requires a value.` };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (arg.startsWith("-")) {
      return { ok: false, message: `omp launch argument '${arg}' is not supported by T3 Code.` };
    }
    return {
      ok: false,
      message: `omp launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  return { ok: true, args };
}

/** omp's own approval modes enforce the T3 runtime modes; `auto` has no omp equivalent. */
function ompApprovalMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "write";
    default:
      return "always-ask";
  }
}

/** Writes a file other omp launches may be reading through a same-directory rename. */
const writeFileAtomically = Effect.fn("writeOmpFileAtomically")(function* (
  directory: string,
  fileName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true });
  const dest = `${directory.replace(/\\/g, "/")}/${fileName}`;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => undefined));
  if (existing === contents) return dest;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const stagingDir = yield* fs.makeTempDirectoryScoped({ directory });
      const staging = `${stagingDir.replace(/\\/g, "/")}/${fileName}`;
      yield* fs.writeFileString(staging, contents);
      yield* fs.rename(staging, dest).pipe(Effect.retry({ times: 3 }));
    }),
  );
  return dest;
});

/** The T3 extension: T3 Code's MCP tools and the per-turn instructions the adapter writes. */
export const materializeOmpT3Extension = (cacheDir: string) =>
  writeFileAtomically(cacheDir, OMP_T3_EXTENSION_FILENAME, OMP_T3_EXTENSION_SOURCE);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** A `--config` overlay that sets model roles for one launch without touching config.yml. */
export function ompModelRolesOverlay(roles: Readonly<Record<string, string>>): string | undefined {
  const entries = Object.entries(roles);
  if (entries.length === 0) return undefined;
  return [
    "modelRoles:",
    ...entries.map(([role, model]) => `  ${yamlString(role)}: ${yamlString(model)}`),
    "",
  ].join("\n");
}

export const materializeOmpModelRolesOverlay = Effect.fn("materializeOmpModelRolesOverlay")(
  function* (cacheDir: string, instanceKey: string, roles: Readonly<Record<string, string>>) {
    const overlay = ompModelRolesOverlay(roles);
    if (overlay === undefined) return undefined;
    const safeKey = instanceKey.replace(/[^A-Za-z0-9_-]/g, "_");
    return yield* writeFileAtomically(cacheDir, `omp-model-roles-${safeKey}.yml`, overlay);
  },
);

export function buildOmpRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionPath?: string | undefined;
  readonly ephemeral?: boolean;
  readonly runtimeMode?: RuntimeMode;
  readonly extensionPath?: string | undefined;
  readonly instructionsFile?: string | undefined;
  /** The thread's T3 Code MCP endpoint, which the extension registers tools from. */
  readonly mcpSession?:
    | Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">
    | undefined;
  readonly modelRolesOverlayPath?: string | undefined;
  /** Text generation and probes: no tools, extensions, skills, rules or context files. */
  readonly bare?: boolean;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const hasExtension = input.extensionPath !== undefined && input.bare !== true;
  const args = [
    "--mode",
    "rpc-ui",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--session", input.sessionPath]
        : []),
    ...input.launchArgs,
    ...(input.modelRolesOverlayPath === undefined ? [] : ["--config", input.modelRolesOverlayPath]),
    // Restrictions follow launch args so user flags cannot loosen them.
    ...(input.runtimeMode === undefined
      ? []
      : ["--approval-mode", ompApprovalMode(input.runtimeMode)]),
    ...(input.bare === true
      ? [
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--no-context-files",
          "--no-lsp",
          "--no-title",
        ]
      : []),
    ...(hasExtension && input.extensionPath !== undefined
      ? ["--extension", input.extensionPath]
      : []),
  ];
  const environment = { ...input.environment };
  // Instructions and MCP credentials belong to this T3 session; never inherit the server's or a
  // parent agent's. The token stays in the environment, never on disk.
  delete environment[T3_OMP_INSTRUCTIONS_FILE_ENV];
  delete environment[T3_MCP_URL_ENV];
  delete environment[T3_MCP_BEARER_ENV];
  return {
    args,
    env: {
      ...environment,
      ...(hasExtension && input.instructionsFile !== undefined
        ? { [T3_OMP_INSTRUCTIONS_FILE_ENV]: input.instructionsFile }
        : {}),
      ...(hasExtension && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            // The extension adds the scheme back.
            [T3_MCP_BEARER_ENV]: input.mcpSession.authorizationHeader.replace(/^Bearer /, ""),
          }
        : {}),
    },
  };
}
