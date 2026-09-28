// Registro de escrituras del proxy (fase 2, paso 3).
//
// Cada vez que el agente modifica algo en una app externa a través del proxy,
// se agrega una línea a .git/agent-sync/registro-apps.jsonl del proyecto.
// Igual que la foto de la fase 1, vive dentro de la carpeta interna de git:
// nunca aparece en `git status` ni termina en un commit.
//
// Por ahora solo se anota QUÉ se modificó. Los pasos siguientes usarán el
// registro para volver a leer esos recursos y compararlos.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../core/state.js";

/** Líneas que se conservan en el registro. */
export const MAX_REGISTRY_LINES = 1000;

export interface RegistryEntry {
  /** Momento de la escritura (ISO 8601). */
  fecha: string;
  /** Nombre del servidor MCP (el que informa en `initialize`). */
  servidor: string;
  /** Herramienta que usó el agente. */
  herramienta: string;
  /** Argumentos de la llamada; los textos largos se recortan. */
  argumentos: unknown;
  /**
   * Por qué se consideró escritura:
   * - "anotacion": el servidor dice que la herramienta modifica (readOnlyHint: false);
   * - "sin_anotacion": el servidor no dice si modifica; por prudencia, sí;
   * - "desconocida": el proxy no vio la lista de herramientas.
   */
  motivo: "anotacion" | "sin_anotacion" | "desconocida";
  /** Turno y sesión de Codex, si los envió (sirven para relacionarlo con los hooks). */
  turno?: string;
  sesion?: string;
}

export function registryPath(gitDir: string): string {
  return join(stateDir(gitDir), "registro-apps.jsonl");
}

export function appendRegistry(gitDir: string, entry: RegistryEntry): void {
  mkdirSync(stateDir(gitDir), { recursive: true });
  const path = registryPath(gitDir);
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");

  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_REGISTRY_LINES) {
    writeFileSync(path, lines.slice(-MAX_REGISTRY_LINES).join("\n") + "\n", "utf8");
  }
}

/** Lee el registro; ignora líneas dañadas. */
export function readRegistry(gitDir: string): RegistryEntry[] {
  const path = registryPath(gitDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RegistryEntry];
      } catch {
        return [];
      }
    });
}

/** Largo máximo de cada texto guardado en los argumentos. */
export const MAX_ARGUMENT_CHARS = 200;

/**
 * Copia los argumentos recortando los textos largos. Para volver a leer un
 * recurso bastan sus identificadores; el contenido completo no hace falta y
 * haría crecer el registro sin límite.
 */
export function trimArguments(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ARGUMENT_CHARS
      ? `${value.slice(0, MAX_ARGUMENT_CHARS)}… (${value.length} caracteres)`
      : value;
  }
  if (Array.isArray(value)) return value.map(trimArguments);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimArguments(item)]));
  }
  return value;
}
