// Fuente de cambios: archivos locales, usando git.
//
// La "foto" se guarda como un commit que NO pertenece a ninguna rama:
// vive en una referencia oculta (refs/agent-sync/last). Para crearla se usa
// un índice temporal, así que tu historial, tus ramas, tu área de staging
// y tus archivos quedan exactamente igual.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canBeFormatOnly, isFormatOnlyChange } from "../core/format.js";

/** Referencia oculta donde se guarda la última foto. */
export const SNAPSHOT_REF = "refs/agent-sync/last";

/** Identidad fija para las fotos, para no depender de tu configuración de git. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "agent-sync",
  GIT_AUTHOR_EMAIL: "agent-sync@localhost",
  GIT_COMMITTER_NAME: "agent-sync",
  GIT_COMMITTER_EMAIL: "agent-sync@localhost",
};

export class NotAGitRepoError extends Error {
  constructor(dir: string) {
    super(`La carpeta no es un repositorio git: ${dir}`);
    this.name = "NotAGitRepoError";
  }
}

/** Ejecuta un comando git y devuelve su salida sin espacios al final. */
export function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export interface Repo {
  /** Carpeta raíz del proyecto. */
  root: string;
  /** Carpeta interna .git (ruta absoluta). */
  gitDir: string;
}

/** Encuentra el repositorio que contiene `dir`. */
export function findRepo(dir: string): Repo {
  try {
    const root = git(dir, ["rev-parse", "--show-toplevel"]);
    const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]);
    return { root, gitDir };
  } catch {
    throw new NotAGitRepoError(dir);
  }
}

export interface HeadInfo {
  /** Rama actual; null si HEAD está suelto (detached) en un commit. */
  branch: string | null;
  /** Commit actual; null si el repositorio todavía no tiene commits. */
  commit: string | null;
}

/** Dice en qué rama y commit está el proyecto. No modifica nada. */
export function currentHead(repo: Repo): HeadInfo {
  const tryGit = (args: string[]): string | null => {
    try {
      return git(repo.root, args) || null;
    } catch {
      return null;
    }
  };
  return {
    branch: tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    commit: tryGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
  };
}

export interface Snapshot {
  /** Commit oculto que guarda la foto. */
  commit: string;
  /** Árbol de archivos de la foto. */
  tree: string;
  /** Cantidad de archivos incluidos. */
  files: number;
  /** Momento en que se tomó (ISO 8601). */
  takenAt: string;
}

/**
 * Captura el estado actual de los archivos como un árbol de git: los que git
 * ya sigue, los nuevos que aún no agregaste y los modificados, respetando
 * .gitignore. Usa un índice temporal, así que tu área de staging no cambia.
 */
export function captureTree(repo: Repo): string {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-sync-"));
  const tempIndex = { GIT_INDEX_FILE: join(tempDir, "index") };

  try {
    git(repo.root, ["add", "--all", "--", "."], tempIndex);
    return git(repo.root, ["write-tree"], tempIndex);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Toma la foto del estado actual y la guarda en la referencia oculta. */
export function takeSnapshot(repo: Repo): Snapshot {
  const tree = captureTree(repo);

  const takenAt = new Date().toISOString();
  const commit = git(
    repo.root,
    ["commit-tree", tree, "-m", `agent-sync snapshot ${takenAt}`],
    SNAPSHOT_IDENTITY,
  );
  git(repo.root, ["update-ref", SNAPSHOT_REF, commit]);

  const listing = git(repo.root, ["ls-tree", "-r", "--name-only", tree]);
  const files = listing === "" ? 0 : listing.split("\n").length;

  return { commit, tree, files, takenAt };
}

// ---------------------------------------------------------------------------
// Paso 2: detectar cambios contra la foto
// ---------------------------------------------------------------------------

export class NoSnapshotError extends Error {
  constructor() {
    super("Todavía no hay una foto en este proyecto.");
    this.name = "NoSnapshotError";
  }
}

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  kind: ChangeKind;
  /** Ruta actual del archivo (o la que tenía, si fue eliminado). */
  path: string;
  /** Ruta anterior, solo en archivos renombrados. */
  oldPath?: string;
}

export interface DiffResult {
  /** Commit de la foto contra la que se comparó. */
  snapshotCommit: string;
  /** Árbol con el estado actual de los archivos. */
  currentTree: string;
  /** Lista de archivos que cambiaron. */
  changes: FileChange[];
}

/** Opciones comunes para que la configuración personal de git no altere la salida. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "-M"];

/** Devuelve el commit de la foto, o lanza NoSnapshotError si no existe. */
export function snapshotCommit(repo: Repo): string {
  try {
    return git(repo.root, ["rev-parse", "--verify", "--quiet", `${SNAPSHOT_REF}^{commit}`]);
  } catch {
    throw new NoSnapshotError();
  }
}

/** Traduce la salida de `git diff --name-status -z` a una lista de cambios. */
export function parseNameStatus(output: string): FileChange[] {
  const tokens = output.split("\0").filter((token) => token !== "");
  const changes: FileChange[] = [];

  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i]!.charAt(0);

    if (code === "R" || code === "C") {
      const oldPath = tokens[i + 1]!;
      const path = tokens[i + 2]!;
      changes.push(
        code === "R" ? { kind: "renamed", path, oldPath } : { kind: "added", path },
      );
      i += 3;
      continue;
    }

    const path = tokens[i + 1]!;
    const kind: ChangeKind =
      code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    changes.push({ kind, path });
    i += 2;
  }

  return changes;
}

/** Compara el estado actual de los archivos con la foto. No modifica nada. */
export function diffAgainstSnapshot(repo: Repo): DiffResult {
  const commit = snapshotCommit(repo);
  const currentTree = captureTree(repo);
  const output = git(repo.root, [
    "diff",
    ...DIFF_FLAGS,
    "--name-status",
    "-z",
    commit,
    currentTree,
  ]);
  return { snapshotCommit: commit, currentTree, changes: parseNameStatus(output) };
}

/** Devuelve el detalle línea por línea de los cambios (formato diff estándar). */
export function diffPatch(repo: Repo, result: DiffResult): string {
  return git(repo.root, ["diff", ...DIFF_FLAGS, result.snapshotCommit, result.currentTree]);
}

// ---------------------------------------------------------------------------
// Paso 3: detalle por archivo para el resumen
// ---------------------------------------------------------------------------

export interface ChangeDetail extends FileChange {
  /** Líneas agregadas (ausente en archivos binarios). */
  added?: number;
  /** Líneas eliminadas (ausente en archivos binarios). */
  deleted?: number;
  /** True si git lo considera binario (imagen, PDF, etc.). */
  binary: boolean;
  /** Fragmento de diff de este archivo; vacío si no se pudo separar. */
  patch: string;
  /** True si solo cambió el formato (espacios, comillas, punto y coma...). */
  formatOnly: boolean;
}

interface LineStats {
  added?: number;
  deleted?: number;
  binary: boolean;
}

/** Traduce la salida de `git diff --numstat -z` a estadísticas por ruta. */
export function parseNumstat(output: string): Map<string, LineStats> {
  const tokens = output.split("\0").filter((token) => token !== "");
  const stats = new Map<string, LineStats>();

  for (let i = 0; i < tokens.length; ) {
    const [addedRaw = "", deletedRaw = "", inlinePath = ""] = tokens[i]!.split("\t");
    let path = inlinePath;
    i += 1;

    // En renombres la ruta viene vacía y le siguen la ruta vieja y la nueva.
    if (path === "") {
      path = tokens[i + 1] ?? "";
      i += 2;
    }

    const binary = addedRaw === "-";
    stats.set(
      path,
      binary ? { binary } : { binary, added: Number(addedRaw), deleted: Number(deletedRaw) },
    );
  }

  return stats;
}

/** Separa un diff completo en un fragmento por archivo, en el mismo orden. */
export function splitPatch(patch: string): string[] {
  if (patch.trim() === "") return [];
  return patch.split(/^(?=diff --git )/m).map((chunk) => chunk.trimEnd());
}

/** Reúne, para cada archivo cambiado, sus estadísticas y su fragmento de diff. */
export function diffDetails(repo: Repo, result: DiffResult): ChangeDetail[] {
  const range = [result.snapshotCommit, result.currentTree];
  const stats = parseNumstat(git(repo.root, ["diff", ...DIFF_FLAGS, "--numstat", "-z", ...range]));
  const chunks = splitPatch(diffPatch(repo, result));
  // Git lista los archivos en el mismo orden en ambas salidas. Si por algún
  // motivo no coinciden, se omite el detalle en lugar de mezclar archivos.
  const aligned = chunks.length === result.changes.length;

  const details: ChangeDetail[] = result.changes.map((change, index) => ({
    ...change,
    ...(stats.get(change.path) ?? { binary: false }),
    patch: aligned ? chunks[index]! : "",
    formatOnly: false,
  }));

  markFormatOnly(repo, result, details);
  return details;
}

// ---------------------------------------------------------------------------
// Detección de cambios de solo formato
// ---------------------------------------------------------------------------

/** Archivos más grandes que esto no se comparan (se tratan como contenido). */
export const MAX_COMPARE_BYTES = 1024 * 1024;

/**
 * Lee varios archivos de git en un solo proceso (`git cat-file --batch`).
 * Cada `spec` es "<commit o árbol>:<ruta>". Devuelve el texto de cada uno,
 * o null si no existe o supera MAX_COMPARE_BYTES.
 */
export function readBlobs(repo: Repo, specs: string[]): Map<string, string | null> {
  const blobs = new Map<string, string | null>();
  // Una ruta con salto de línea rompería el protocolo: esas no se leen.
  const valid = specs.filter((spec) => !spec.includes("\n"));
  for (const spec of specs) blobs.set(spec, null);
  if (valid.length === 0) return blobs;

  const run = (mode: string, list: string[]): Buffer =>
    execFileSync("git", ["cat-file", mode], {
      cwd: repo.root,
      input: list.join("\n") + "\n",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });

  // 1. Consultar tamaños, para no cargar archivos enormes.
  const sizes = run("--batch-check", valid).toString("utf8").trimEnd().split("\n");
  const small = valid.filter((_, i) => {
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(sizes[i] ?? "");
    return match !== null && Number(match[1]) <= MAX_COMPARE_BYTES;
  });
  if (small.length === 0) return blobs;

  // 2. Leer los contenidos. Formato: "<sha> blob <tamaño>\n<contenido>\n".
  const output = run("--batch", small);
  let offset = 0;
  for (const spec of small) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) break; // salida inesperada: se deja el resto sin leer
    const size = Number(match[1]);
    const start = headerEnd + 1;
    blobs.set(spec, output.subarray(start, start + size).toString("utf8"));
    offset = start + size + 1;
  }
  return blobs;
}

/** Marca como formatOnly los archivos cuyo cambio es solo de formato. */
function markFormatOnly(repo: Repo, result: DiffResult, details: ChangeDetail[]): void {
  // Solo archivos modificados: un renombre es información estructural que el
  // agente necesita ver aunque el contenido solo haya cambiado de formato.
  const candidates = details.filter(
    (d) => d.kind === "modified" && !d.binary && canBeFormatOnly(d.path),
  );
  if (candidates.length === 0) return;

  const before = (d: ChangeDetail) => `${result.snapshotCommit}:${d.path}`;
  const after = (d: ChangeDetail) => `${result.currentTree}:${d.path}`;
  const blobs = readBlobs(repo, candidates.flatMap((d) => [before(d), after(d)]));

  for (const detail of candidates) {
    const old = blobs.get(before(detail));
    const now = blobs.get(after(detail));
    if (typeof old === "string" && typeof now === "string") {
      detail.formatOnly = isFormatOnlyChange(detail.path, old, now);
    }
  }
}
