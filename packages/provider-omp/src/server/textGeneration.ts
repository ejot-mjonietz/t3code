import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { ompModelRoleOverrides, type OmpSettings } from "../settings.ts";

import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./launch.ts";
import { isOmpThinkingLevel, parseOmpModelSelector } from "./modelCapabilities.ts";
import { readOmpModelRoles } from "./roles.ts";
import {
  makeOmpRpcConnection,
  ompRecordField,
  ompRecordString,
  resolveOmpModelSlug,
} from "./rpc.ts";

const OMP_TIMEOUT_MS = 180_000;
const ROLE_MODEL_PREFIX = "role:";

const isTextGenerationError = Schema.is(TextGenerationError);

// omp's `errorMessage` is the provider's raw response text and can echo
// credentials, so only a leading HTTP status reaches the error detail.
const ompTurnErrorDetail = (errorMessage: string | undefined) => {
  const status = errorMessage?.match(/^([45]\d\d)\b/)?.[1];
  return status === undefined
    ? "omp could not generate text: the model provider reported an error."
    : `omp could not generate text: the model provider returned HTTP ${status}.`;
};

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runOmpJson: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.runOmpJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const resolvedLaunchArgs = resolveOmpLaunchArgs(settings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* new TextGenerationError({ operation, detail: resolvedLaunchArgs.message });
      }
      let model = modelSelection.model;
      let thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      if (model.startsWith(ROLE_MODEL_PREFIX)) {
        const role = model.slice(ROLE_MODEL_PREFIX.length);
        const roles = {
          ...(yield* readOmpModelRoles(settings, environment, cwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
          )),
          ...ompModelRoleOverrides(settings),
        };
        const selector = roles[role] ?? roles["smol"];
        if (selector === undefined) {
          model = "default";
        } else {
          const parsed = parseOmpModelSelector(selector);
          model = parsed.model;
          thinking ??= parsed.thinking;
        }
      }
      // Background naming/content helpers must never mutate the workspace.
      const launch = buildOmpRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment,
        ephemeral: true,
        bare: true,
      });
      const connection = yield* makeOmpRpcConnection({
        command: settings.binaryPath || "omp",
        args: launch.args,
        cwd,
        env: launch.env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (model !== "default") {
        // Reject unusable slugs; silently using omp's default would misreport the requested model.
        const inventory = yield* connection
          .request({ type: "get_available_models" })
          .pipe(Effect.orElseSucceed(() => undefined));
        const parsed = resolveOmpModelSlug(model, ompRecordField(inventory, "models"));
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `omp model '${model}' must use provider/model format.`,
          });
        }
        yield* connection
          .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "OmpRpcError" && error.operation === "set_model"
                ? new TextGenerationError({
                    operation,
                    detail: `omp rejected model '${model}': ${error.detail ?? "unknown error"}.`,
                    cause: error,
                  })
                : error,
            ),
          );
      }

      if (thinking !== undefined && isOmpThinkingLevel(thinking)) {
        // A stale saved level falls back to omp's default instead of failing the generation.
        yield* connection
          .request({ type: "set_thinking_level", level: thinking })
          .pipe(Effect.catchTags({ OmpRpcError: () => Effect.void }));
      }

      const promptId = "t3-text-generation";
      yield* connection.send({ type: "prompt", message: prompt, id: promptId });
      // Provider failures (bad key, rate limit, 5xx) arrive on the assistant
      // `message_end`. Keep only the latest, since omp can retry and still answer.
      let turnError: string | undefined;
      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === "prompt_result" && event["id"] === promptId) return;
          const message = event["message"];
          if (event["type"] === "message_end" && ompRecordString(message, "role") === "assistant") {
            turnError =
              ompRecordString(message, "stopReason") === "error"
                ? ompTurnErrorDetail(ompRecordString(message, "errorMessage"))
                : undefined;
          }
        }
      });
      const data = yield* connection.request({ type: "get_last_assistant_text" });
      const text = ompRecordString(data, "text")?.trim() ?? "";
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: turnError ?? "omp returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "omp", text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.timeoutOption(OMP_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "omp request timed out." })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "omp text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("omp", runOmpJson),
  );
});
