// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** omp model roles T3 Code can set, in the order Settings shows them. */
const OMP_EDITABLE_MODEL_ROLES = [
  { role: "default", key: "defaultModel", title: "Default model" },
  { role: "smol", key: "smolModel", title: "Fast model (smol)" },
  { role: "slow", key: "slowModel", title: "Thinking model (slow)" },
  { role: "plan", key: "planModel", title: "Architect model (plan)" },
  { role: "task", key: "taskModel", title: "Subagent model (task)" },
  { role: "commit", key: "commitModel", title: "Commit model (commit)" },
] as const;

const roleModelSetting = (role: string, description: string) =>
  TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: OMP_EDITABLE_MODEL_ROLES.find((entry) => entry.role === role)?.title ?? role,
      description: `${description} Empty keeps omp's own setting.`,
      providerSettingsForm: { placeholder: `modelRoles.${role}`, clearWhenEmpty: "omit" },
    }),
  );

export const OmpSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("omp").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the omp (oh-my-pi) binary.",
        providerSettingsForm: { placeholder: "omp", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to omp --mode rpc-ui on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    defaultModel: roleModelSetting(
      "default",
      "Model for omp's default role, as provider/model with an optional :thinking level, such as github-copilot/gpt-6-luna:low.",
    ),
    smolModel: roleModelSetting("smol", "Model for light, fast work."),
    slowModel: roleModelSetting("slow", "Model for slow, thorough reasoning."),
    planModel: roleModelSetting("plan", "Model for planning."),
    taskModel: roleModelSetting("task", "Model omp's subagents run on."),
    commitModel: roleModelSetting("commit", "Model for commit messages."),
    saveModelRolesToOmpConfig: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Save model roles to omp config",
        description:
          "On: changed roles are written to omp's config.yml, so the omp CLI uses them too. Off: they apply only to sessions T3 Code starts. Running sessions pick up changes when they restart.",
        providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "binaryPath",
      "defaultModel",
      "smolModel",
      "slowModel",
      "planModel",
      "taskModel",
      "commitModel",
      "saveModelRolesToOmpConfig",
      "launchArgs",
    ],
  },
);
export type OmpSettings = typeof OmpSettings.Type;

/** Role overrides the settings set, keyed by omp role id. Empty fields are left to omp. */
export function ompModelRoleOverrides(settings: OmpSettings): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const { role, key } of OMP_EDITABLE_MODEL_ROLES) {
    const value = settings[key].trim();
    if (value.length > 0) overrides[role] = value;
  }
  return overrides;
}
