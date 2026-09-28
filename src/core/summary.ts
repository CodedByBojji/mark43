// Núcleo: convertir los cambios detectados en un texto para el agente.
//
// Este módulo no sabe nada de git: recibe datos y devuelve texto. Así, en la
// fase 2, los cambios que vengan del proxy (Figma, calendario...) podrán usar
// el mismo resumen.

import { basename, extname } from "node:path";

export interface SummaryChange {
  kind: "added" | "modified" | "deleted" | "renamed";
  path: string;
  oldPath?: string;
  added?: number;
  deleted?: number;
  binary: boolean;
  patch: string;
  /** True si solo cambió el formato (espacios, comillas, punto y coma...). */
  formatOnly?: boolean;
}

/** El proyecto pasó de una rama (o commit suelto) a otra desde la foto. */
export interface BranchChange {
  /** Dónde estaba el proyecto al tomar la foto, p. ej. "main". */
  from: string;
  /** Dónde está ahora, p. ej. "feature/login". */
  to: string;
}

export interface SummaryOptions {
  /** Cuándo se tomó la foto (ISO 8601). */
  takenAt?: string;
  /** Si el usuario cambió de rama desde la foto. */
  branchChange?: BranchChange;
  /** Máximo de caracteres de diff a incluir. Lo que no cabe se marca "sin detalle". */
  maxPatchChars?: number;
  /** Máximo de archivos con cambios de contenido a listar. */
  maxFiles?: number;
}

export const DEFAULT_MAX_PATCH_CHARS = 8000;
export const DEFAULT_MAX_FILES = 50;
/** Cuántos nombres de archivos de "solo formato" se muestran antes de resumir. */
export const FORMAT_NAMES_SHOWN = 10;

const KIND_LABELS: Record<SummaryChange["kind"], string> = {
  added: "nuevo",
  modified: "modificado",
  deleted: "eliminado",
  renamed: "renombrado",
};

const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore"]);
const SENSITIVE_NAMES = new Set(["id_rsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc"]);

/**
 * Archivos cuyo contenido nunca se incluye en el resumen, aunque git los siga:
 * variables de entorno, llaves y credenciales. Solo se menciona que cambiaron.
 */
export function isSensitive(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SENSITIVE_NAMES.has(name)) return true;
  return SENSITIVE_EXTENSIONS.has(extname(name));
}

/** Orden natural: componente2 antes que componente10. */
function byPath(a: SummaryChange, b: SummaryChange): number {
  return a.path.localeCompare(b.path, undefined, { numeric: true });
}

function describe(change: SummaryChange, withoutDetail: boolean): string {
  const target = change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path;
  const parts: string[] = [];
  if (change.binary) {
    parts.push("binario");
  } else if (change.kind !== "deleted") {
    const lines: string[] = [];
    if (change.added) lines.push(`+${change.added}`);
    if (change.deleted) lines.push(`-${change.deleted}`);
    if (lines.length > 0) parts.push(lines.join(" "));
  }
  if (withoutDetail) parts.push("sin detalle");
  const extra = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `- ${KIND_LABELS[change.kind]}: ${target}${extra}`;
}

/**
 * Arma el resumen para el agente. Devuelve null si no hay cambios, para que
 * el hook no agregue nada al prompt en ese caso.
 *
 * Los cambios de contenido van primero y reciben el detalle línea por línea.
 * Los de solo formato se agrupan en una línea, porque no cambian el
 * comportamiento y, si fueran muchos, esconderían los cambios importantes.
 */
export function buildSummary(changes: SummaryChange[], options: SummaryOptions = {}): string | null {
  const branch = options.branchChange;
  if (changes.length === 0 && !branch) return null;

  const maxPatchChars = options.maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const since = options.takenAt ? ` (${options.takenAt})` : "";

  const sorted = [...changes].sort(byPath);
  const content = sorted.filter((change) => !change.formatOnly);
  const formatOnly = sorted.filter((change) => change.formatOnly);

  const listed = content.slice(0, maxFiles);
  const hidden = content.length - listed.length;

  const patches: string[] = [];
  const withoutDetail = new Set<string>();
  const sensitive: string[] = [];
  let budget = maxPatchChars;

  for (const change of listed) {
    if (isSensitive(change.path)) {
      sensitive.push(change.path);
      continue;
    }
    // Un archivo eliminado ya no existe: su contenido anterior no le sirve al agente.
    if (change.kind === "deleted" || change.binary || change.patch === "") continue;

    if (change.patch.length <= budget) {
      patches.push(change.patch);
      budget -= change.patch.length;
    } else {
      withoutDetail.add(change.path);
    }
  }

  const lines: string[] = ["<cambios_externos>"];
  if (branch) {
    lines.push(
      `Cambio de rama: desde que terminaste tu última tarea${since}, el usuario cambió el proyecto de \`${branch.from}\` a \`${branch.to}\`.`,
      "Al empezar tu respuesta, avísale al usuario en una frase que detectaste este cambio de rama. Lo que recuerdas del código corresponde a la rama anterior.",
    );
    lines.push(
      changes.length > 0
        ? "Los archivos de abajo son distintos a como los dejaste. La mayoría de las diferencias vienen del cambio de rama; también pueden incluir ediciones del usuario. Respétalas y no las reviertas. Si vas a editar alguno de estos archivos, vuelve a leerlo antes en lugar de confiar en lo que recuerdas."
        : "Los archivos quedaron idénticos a como los dejaste: las dos ramas tienen el mismo contenido.",
    );
  } else {
    lines.push(
      `Desde que terminaste tu última tarea${since}, el usuario hizo estos cambios por su cuenta en el proyecto.`,
      "Son intencionales: respétalos y no los reviertas. Si vas a editar alguno de estos archivos, vuelve a leerlo antes en lugar de confiar en lo que recuerdas.",
    );
  }

  if (content.length > 0) {
    lines.push("", `Cambios de contenido (${content.length}):`);
    lines.push(...listed.map((change) => describe(change, withoutDetail.has(change.path))));
    if (hidden > 0) {
      lines.push(`- ... y ${hidden} archivos más (usa \`git diff refs/agent-sync/last\` para verlos todos)`);
    }
  }

  if (formatOnly.length > 0) {
    const names = formatOnly.slice(0, FORMAT_NAMES_SHOWN).map((change) => change.path);
    const rest = formatOnly.length - names.length;
    lines.push(
      "",
      `Solo formato (${formatOnly.length}): el contenido es el mismo; solo cambiaron espacios, saltos de línea, comillas, punto y coma o comas finales. No afectan el comportamiento; revísalos solo si tu tarea los involucra.`,
      `- ${names.join(", ")}${rest > 0 ? ` y ${rest} más` : ""}`,
    );
  }

  if (patches.length > 0) {
    lines.push("", "Detalle de los cambios de contenido:", "```diff", ...patches, "```");
  }

  if (withoutDetail.size > 0) {
    lines.push(
      "",
      `Los archivos marcados "sin detalle" no cupieron por tamaño: léelos antes de editarlos o si tu tarea depende de ellos.`,
    );
  }

  if (sensitive.length > 0) {
    lines.push(
      "",
      `Sin detalle por contener posible información sensible: ${sensitive.join(", ")}`,
    );
  }

  lines.push("</cambios_externos>");
  return lines.join("\n");
}

/** Tamaño total por defecto del resumen que se inyecta en Codex. */
export const DEFAULT_MAX_TOTAL_CHARS = 6000;

/**
 * Arma el resumen garantizando que el texto completo no pase de `maxChars`.
 * Prioriza, en este orden: la instrucción y la lista de archivos, luego el
 * detalle de los cambios. Si ni la lista cabe, muestra menos archivos.
 */
export function buildSummaryWithin(
  changes: SummaryChange[],
  options: { takenAt?: string; branchChange?: BranchChange; maxChars?: number } = {},
): string | null {
  if (changes.length === 0 && !options.branchChange) return null;
  const maxChars = options.maxChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const { takenAt, branchChange } = options;

  // 1. La base: instrucción + lista, sin detalle. Si no cabe, menos archivos.
  let maxFiles = Math.min(DEFAULT_MAX_FILES, changes.length);
  let base = buildSummary(changes, { takenAt, branchChange, maxPatchChars: 0, maxFiles })!;
  while (base.length > maxChars && maxFiles > 1) {
    maxFiles = Math.max(1, Math.floor(maxFiles / 2));
    base = buildSummary(changes, { takenAt, branchChange, maxPatchChars: 0, maxFiles })!;
  }
  if (base.length > maxChars) {
    // Caso extremo (límite diminuto): se recorta, pero se cierra la etiqueta.
    const closing = "\n</cambios_externos>";
    return base.slice(0, Math.max(0, maxChars - closing.length)) + closing;
  }

  // 2. El detalle: se usa el espacio restante, ajustando hasta que quepa.
  let budget = maxChars - base.length;
  for (let attempt = 0; attempt < 20 && budget > 0; attempt++) {
    const text = buildSummary(changes, { takenAt, branchChange, maxPatchChars: budget, maxFiles })!;
    if (text.length <= maxChars) return text;
    budget -= text.length - maxChars;
  }
  return base;
}
