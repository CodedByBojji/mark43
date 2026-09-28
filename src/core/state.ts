// Núcleo: leer y guardar el estado de agent-sync.
//
// El estado vive dentro de la carpeta interna de git (.git/agent-sync/),
// no en tu proyecto. Así nunca aparece en `git status`, no hay que
// agregarlo a .gitignore y no puede terminar en un commit por accidente.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Baseline {
  /** Referencia oculta donde está la foto. */
  ref: string;
  /** Commit oculto de la foto. */
  commit: string;
  /** Cantidad de archivos en la foto. */
  files: number;
  /** Momento en que se tomó (ISO 8601). */
  takenAt: string;
  /**
   * Rama en la que estaba el proyecto al tomar la foto (null si HEAD estaba
   * suelto). Ausente en fotos de versiones anteriores a la 0.3.0.
   */
  branch?: string | null;
  /** Commit de HEAD al tomar la foto (null si no había commits). */
  head?: string | null;
}

export function stateDir(gitDir: string): string {
  return join(gitDir, "agent-sync");
}

function baselinePath(gitDir: string): string {
  return join(stateDir(gitDir), "baseline.json");
}

export function saveBaseline(gitDir: string, baseline: Baseline): string {
  mkdirSync(stateDir(gitDir), { recursive: true });
  const path = baselinePath(gitDir);
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  return path;
}

export function loadBaseline(gitDir: string): Baseline | null {
  const path = baselinePath(gitDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

// ---------------------------------------------------------------------------
// Bitácora de los hooks: registra cada ejecución, para verificar que Codex
// los llama y para diagnosticar errores sin escribir nada en la salida.
// ---------------------------------------------------------------------------

/** Cantidad máxima de líneas que se conservan en la bitácora. */
export const MAX_LOG_LINES = 200;

export function logPath(gitDir: string): string {
  return join(stateDir(gitDir), "hook.log");
}

/** Agrega una línea con fecha a la bitácora, conservando solo las últimas. */
export function appendLog(gitDir: string, message: string): void {
  mkdirSync(stateDir(gitDir), { recursive: true });
  const path = logPath(gitDir);
  const previous = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  const lines = [...previous, `${new Date().toISOString()} ${message}`].slice(-MAX_LOG_LINES);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/** Devuelve las últimas `count` líneas de la bitácora. */
export function readLog(gitDir: string, count: number): string[] {
  const path = logPath(gitDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-count);
}
