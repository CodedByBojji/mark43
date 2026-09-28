// Acciones completas que combinan las piezas (git + estado). Las usan tanto
// el comando manual (cli.ts) como los hooks de Codex, para que ambos hagan
// exactamente lo mismo.

import { type Baseline, saveBaseline } from "./core/state.js";
import { type BranchChange } from "./core/summary.js";
import { type HeadInfo, type Repo, SNAPSHOT_REF, currentHead, takeSnapshot } from "./sources/git.js";

export interface RecordedSnapshot extends Baseline {
  /** Ruta del archivo baseline.json que se escribió. */
  statePath: string;
}

/** Toma la foto del proyecto y guarda su referencia en el estado. */
export function recordSnapshot(repo: Repo): RecordedSnapshot {
  const shot = takeSnapshot(repo);
  const head = currentHead(repo);
  const baseline: Baseline = {
    ref: SNAPSHOT_REF,
    commit: shot.commit,
    files: shot.files,
    takenAt: shot.takenAt,
    branch: head.branch,
    head: head.commit,
  };
  const statePath = saveBaseline(repo.gitDir, baseline);
  return { ...baseline, statePath };
}

/** Nombre legible de dónde está el proyecto: la rama, o el commit si no hay rama. */
function headLabel(head: HeadInfo): string | null {
  if (head.branch) return head.branch;
  if (head.commit) return `commit ${head.commit.slice(0, 7)} (sin rama)`;
  return null;
}

/**
 * Dice si el proyecto cambió de rama (o de commit suelto) desde la foto.
 * Devuelve undefined si no cambió o si la foto es de una versión anterior
 * que no guardaba la rama.
 */
export function detectBranchChange(repo: Repo, baseline: Baseline | null): BranchChange | undefined {
  if (!baseline || baseline.branch === undefined) return undefined;
  const from = headLabel({ branch: baseline.branch, commit: baseline.head ?? null });
  const to = headLabel(currentHead(repo));
  if (from === null || to === null || from === to) return undefined;
  return { from, to };
}
