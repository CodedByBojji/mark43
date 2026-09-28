// Lectura de la información que Codex envía a cada hook.
//
// Codex ejecuta el hook como un programa aparte y le pasa un JSON por la
// entrada estándar (stdin), con campos como `cwd` (la carpeta del proyecto)
// y `hook_event_name`. Esta lectura es tolerante: si el JSON falta o viene
// mal formado, el hook sigue funcionando con la carpeta actual.

import { readFileSync } from "node:fs";

export interface HookInput {
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  /** Solo en Stop: true si Codex ya está continuando por otro hook. */
  stop_hook_active?: boolean;
  /** Solo en UserPromptSubmit: el prompt que escribió el usuario. */
  prompt?: string;
}

/** Lee todo stdin como texto. Si es una terminal interactiva, no espera. */
export function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Interpreta el JSON de Codex; devuelve un objeto vacío si no es válido. */
export function parseHookInput(raw: string): HookInput {
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as HookInput) : {};
  } catch {
    return {};
  }
}
