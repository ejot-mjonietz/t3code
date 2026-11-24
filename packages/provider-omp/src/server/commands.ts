import { type ServerProviderSkill, type ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export interface OmpCompactCommand {
  readonly customInstructions?: string;
}

/** `/compact` runs omp's RPC compaction so T3 can follow it; omp's own modes stay omp commands. */
export function parseOmpCompactCommand(text: string): OmpCompactCommand | null {
  const trimmed = text.trim();
  if (trimmed === "/compact") return {};
  if (!trimmed.startsWith("/compact")) return null;
  const rest = trimmed.slice("/compact".length);
  if (!/^\s/.test(rest)) return null;
  const customInstructions = rest.trim();
  if (/^(soft|remote|snapcompact)(\s|$)/.test(customInstructions)) return null;
  return customInstructions.length === 0 ? {} : { customInstructions };
}

// Builtins that would move omp off the session, model, title or workspace T3 Code tracks.
const OMP_HIDDEN_BUILTIN_COMMANDS = new Set([
  "add-dir",
  "dirs",
  "effort",
  "fresh",
  "handoff",
  "model",
  "modelpreset",
  "move",
  "pin",
  "remove-dir",
  "rename",
  "session",
  "switch",
  "wt",
]);

export interface OmpDiscoveredCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export function parseOmpAvailableCommands(data: unknown): OmpDiscoveredCommands {
  const commands = recordField(data, "commands");
  if (!Array.isArray(commands)) return { slashCommands: [], skills: [] };
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const name = recordString(command, "name");
    if (name === undefined) continue;
    const source = recordString(command, "source");
    const description = recordString(command, "description");
    const hint = recordString(recordField(command, "input"), "hint");
    if (source === "skill" || name.startsWith("skill:")) {
      const skillName = name.startsWith("skill:") ? name.slice("skill:".length) : name;
      if (skillName.length === 0) continue;
      skills.push({
        name: skillName,
        path: `omp:skill:${skillName}`,
        enabled: true,
        ...(description === undefined ? {} : { description }),
      });
      continue;
    }
    if (source === "builtin" && OMP_HIDDEN_BUILTIN_COMMANDS.has(name)) continue;
    slashCommands.push({
      name,
      ...(description === undefined ? {} : { description }),
      ...(hint === undefined || hint === "arguments" ? {} : { input: { hint } }),
    });
  }
  return { slashCommands, skills };
}

function recordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
