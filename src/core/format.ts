// Núcleo: distinguir cambios de formato de cambios de contenido.
//
// Un cambio es "solo formato" si el archivo, antes y después, queda idéntico
// al ignorar: espacios y saltos de línea, el tipo de comillas (' " `), los
// punto y coma, y las comas finales antes de } ] ). Es lo que suelen cambiar
// herramientas como Prettier o Black, en cualquier lenguaje.
//
// No depende de git: recibe dos textos y responde sí o no.

import { basename, extname } from "node:path";

/**
 * Formatos donde la sangría o los saltos de línea cambian el significado.
 * En ellos nunca se afirma "solo formato": todo cambio se trata como contenido.
 */
const INDENTATION_SENSITIVE_EXTENSIONS = new Set([
  ".py", ".pyi", ".yaml", ".yml", ".coffee", ".pug", ".jade", ".sass", ".haml", ".slim", ".nim",
]);
const INDENTATION_SENSITIVE_NAMES = new Set(["makefile", "gnumakefile"]);

export function canBeFormatOnly(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (INDENTATION_SENSITIVE_NAMES.has(name)) return false;
  return !INDENTATION_SENSITIVE_EXTENSIONS.has(extname(name));
}

/** Reduce un texto a lo que no cambia al reformatearlo. */
export function normalizeForFormat(text: string): string {
  return text
    .replace(/\s+/g, "") // espacios, tabulaciones y saltos de línea
    .replace(/['`]/g, '"') // tipo de comillas
    .replace(/;/g, "") // punto y coma
    .replace(/,(?=[}\])])/g, ""); // comas finales: {a,} [a,] f(a,)
}

/** True si el cambio entre `before` y `after` es solo de formato. */
export function isFormatOnlyChange(path: string, before: string, after: string): boolean {
  if (before === after) return false; // sin cambio no es "cambio de formato"
  if (!canBeFormatOnly(path)) return false;
  return normalizeForFormat(before) === normalizeForFormat(after);
}
