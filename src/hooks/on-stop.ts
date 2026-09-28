// Hook "Stop" de Codex: se ejecuta cada vez que Codex termina una tarea
// y actualiza la foto, para que la referencia sea siempre "lo último que
// dejó el agente". Todo lo que cambie después se atribuye al usuario.
//
// REGLAS DE SEGURIDAD (según la documentación de hooks de Codex):
// - No escribe NADA en stdout. En el hook Stop, cierta salida JSON hace que
//   Codex siga trabajando en lugar de terminar, y el texto plano es inválido.
// - Termina SIEMPRE con código 0. El código 2 también le pediría a Codex
//   continuar. Un fallo de agent-sync nunca debe alterar el trabajo de Codex.
// - Los errores y cada ejecución quedan en .git/agent-sync/hook.log.

import { recordSnapshot } from "../actions.js";
import { appendLog } from "../core/state.js";
import { type Repo, findRepo } from "../sources/git.js";
import { type HookInput } from "./input.js";

export function runStopHook(input: HookInput): 0 {
  const dir = input.cwd ?? process.cwd();

  let repo: Repo;
  try {
    repo = findRepo(dir);
  } catch {
    // Codex no está trabajando en un proyecto con git: no hay nada que hacer.
    return 0;
  }

  try {
    const shot = recordSnapshot(repo);
    appendLog(
      repo.gitDir,
      `stop    foto ${shot.commit.slice(0, 7)} (${shot.files} archivos) turno=${input.turn_id ?? "?"}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendLog(repo.gitDir, `stop    ERROR ${message.replace(/\s+/g, " ")}`);
    } catch {
      // Si ni siquiera se puede escribir la bitácora, se ignora en silencio.
    }
  }

  return 0;
}
