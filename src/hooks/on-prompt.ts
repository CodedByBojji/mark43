// Hook "UserPromptSubmit" de Codex: se ejecuta cada vez que envías un prompt,
// antes de que Codex lo lea. Si cambiaste archivos por tu cuenta desde la
// última foto, le entrega a Codex el resumen como contexto adicional.
//
// REGLAS DE SEGURIDAD (según la documentación de hooks de Codex):
// - Termina SIEMPRE con código 0. El código 2 BLOQUEARÍA tu prompt.
// - Nunca responde con "decision": solo con "additionalContext".
// - Sin cambios, o ante cualquier error, no escribe nada: tu prompt pasa
//   intacto, como si agent-sync no existiera.
// - No modifica la foto: eso lo hace el hook Stop al terminar la tarea.
//   Si la tarea se interrumpe, el resumen se repite en el siguiente prompt,
//   que es preferible a perderlo.

import { detectBranchChange, recordSnapshot } from "../actions.js";
import { appendLog, loadBaseline } from "../core/state.js";
import { DEFAULT_MAX_TOTAL_CHARS, buildSummaryWithin } from "../core/summary.js";
import {
  NoSnapshotError,
  type Repo,
  diffAgainstSnapshot,
  diffDetails,
  findRepo,
} from "../sources/git.js";
import { type HookInput } from "./input.js";

export interface PromptHookResult {
  exitCode: 0;
  /** Lo que se escribe en stdout; vacío si no hay nada que decirle a Codex. */
  stdout: string;
}

const SILENT: PromptHookResult = { exitCode: 0, stdout: "" };

/** La respuesta en el formato que espera Codex para UserPromptSubmit. */
export function formatHookOutput(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
}

export function runPromptHook(
  input: HookInput,
  maxChars: number = DEFAULT_MAX_TOTAL_CHARS,
): PromptHookResult {
  const dir = input.cwd ?? process.cwd();

  let repo: Repo;
  try {
    repo = findRepo(dir);
  } catch {
    return SILENT; // No es un proyecto con git: no hay nada que hacer.
  }

  const log = (message: string) => {
    try {
      appendLog(repo.gitDir, `prompt  ${message}`);
    } catch {
      // Si la bitácora falla, se ignora: nunca debe afectar al prompt.
    }
  };

  try {
    const result = diffAgainstSnapshot(repo);
    const baseline = loadBaseline(repo.gitDir);
    const branchChange = detectBranchChange(repo, baseline);
    const text = buildSummaryWithin(diffDetails(repo, result), {
      takenAt: baseline?.takenAt,
      branchChange,
      maxChars,
    });

    if (text === null) {
      log("sin cambios externos");
      return SILENT;
    }

    const branchNote = branchChange ? `, cambio de rama ${branchChange.from} -> ${branchChange.to}` : "";
    log(`${result.changes.length} cambios enviados a Codex${branchNote} (${text.length} caracteres)`);
    return { exitCode: 0, stdout: formatHookOutput(text) };
  } catch (error) {
    if (error instanceof NoSnapshotError) {
      // Primera vez en este proyecto: empieza a seguirlo desde ahora.
      try {
        const shot = recordSnapshot(repo);
        log(`sin foto previa: foto inicial ${shot.commit.slice(0, 7)}`);
      } catch (inner) {
        log(`ERROR al tomar la foto inicial: ${describeError(inner)}`);
      }
      return SILENT;
    }
    log(`ERROR ${describeError(error)}`);
    return SILENT;
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ");
}
