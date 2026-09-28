// App de juguete para la fase 2: un servidor MCP de "notas".
//
// Hace el papel de una app externa como Figma o un calendario, pero sin
// cuentas ni internet. Las notas se guardan en un archivo JSON FUERA del
// proyecto (por defecto ~/.agent-sync/notas-juguete.json):
// - Codex las lee y modifica con las herramientas de este servidor.
// - Tú las puedes cambiar a mano editando el archivo, igual que alguien que
//   edita en Figma por su cuenta.
//
// Cada nota guarda `modificada` (fecha de la última edición), que cambia sola
// en cada escritura: sirve para probar, más adelante, que el proxy ignora los
// campos que cambian solos.
//
// Cada herramienta vuelve a leer el archivo, así que los cambios hechos a
// mano se ven de inmediato.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Json, initializeResult, serveStdio } from "../proxy/stdio.js";

export interface Note {
  titulo: string;
  texto: string;
  /** Fecha de la última edición hecha con las herramientas (ISO 8601). */
  modificada: string;
}

export interface NotesFile {
  notas: Record<string, Note>;
  /** Id que recibirá la próxima nota nueva. */
  siguienteId: number;
}

/** Dónde se guardan las notas. Se puede cambiar con AGENT_SYNC_NOTAS. */
export function notesPath(): string {
  return process.env.AGENT_SYNC_NOTAS ?? join(homedir(), ".agent-sync", "notas-juguete.json");
}

class NotesError extends Error {}

export function loadNotes(path: string): NotesFile {
  if (!existsSync(path)) return { notas: {}, siguienteId: 1 };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new NotesError(`El archivo de notas no es JSON válido: ${path}. Corrígelo a mano.`);
  }
  const file = data as Partial<NotesFile>;
  if (typeof file !== "object" || file === null || typeof file.notas !== "object" || file.notas === null) {
    throw new NotesError(`El archivo de notas no tiene la forma esperada ({"notas": {...}}): ${path}`);
  }
  const ids = Object.keys(file.notas).map(Number).filter(Number.isInteger);
  const next = Math.max(file.siguienteId ?? 1, ...ids.map((id) => id + 1), 1);
  return { notas: file.notas, siguienteId: next };
}

function saveNotes(path: string, file: NotesFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", "utf8");
}

const idParam = { type: "string", description: 'Id de la nota, por ejemplo "1".' };

/**
 * Presentación del servidor para el agente. Codex busca herramientas por
 * palabra clave (a veces en inglés): sin "notes", buscó "note", no encontró
 * "nota" e improvisó un archivo en el proyecto (verificado el 2026-09-27).
 */
export const INSTRUCTIONS =
  "App de notas (notes app). Cuando el usuario hable de notas o notes, usa estas herramientas: " +
  "las notas viven en esta app, no en archivos del proyecto.";

export const TOOLS = [
  {
    name: "listar_notas",
    description: "Lista todas las notas (notes) de la app de notas: id y título.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "leer_nota",
    description: "Lee una nota (note) de la app de notas: título, texto y fecha de modificación.",
    inputSchema: { type: "object", properties: { id: idParam }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "crear_nota",
    description: "Crea una nota (note) nueva en la app de notas y devuelve su id.",
    inputSchema: {
      type: "object",
      properties: { titulo: { type: "string" }, texto: { type: "string" } },
      required: ["titulo", "texto"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "editar_nota",
    description: "Edita una nota (note) existente de la app de notas: título y/o texto.",
    inputSchema: {
      type: "object",
      properties: { id: idParam, titulo: { type: "string" }, texto: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "borrar_nota",
    description: "Borra una nota (note) de la app de notas.",
    inputSchema: { type: "object", properties: { id: idParam }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

function requireString(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new NotesError(`Falta el parámetro "${key}".`);
  return value;
}

/**
 * El id se declara como texto, pero Codex a veces lo envía como número
 * (`{id: 2}`, verificado el 2026-09-27). Se aceptan ambos.
 */
function requireId(args: Json): string {
  if (typeof args.id === "number" && Number.isInteger(args.id)) return String(args.id);
  return requireString(args, "id");
}

/** Ejecuta una herramienta sobre el archivo de notas y devuelve el resultado MCP. */
export function callTool(path: string, name: string, args: Json, now = () => new Date().toISOString()): Json {
  const file = loadNotes(path);
  const find = (id: string): Note => {
    const note = file.notas[id];
    if (!note) throw new NotesError(`No existe la nota ${id}.`);
    return note;
  };

  switch (name) {
    case "listar_notas": {
      const ids = Object.keys(file.notas).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (ids.length === 0) return text("No hay notas.");
      return text(ids.map((id) => `${id}: ${file.notas[id]!.titulo}`).join("\n"));
    }
    case "leer_nota": {
      const id = requireId(args);
      return text(JSON.stringify({ id, ...find(id) }, null, 2));
    }
    case "crear_nota": {
      const id = String(file.siguienteId);
      file.notas[id] = { titulo: requireString(args, "titulo"), texto: String(args.texto ?? ""), modificada: now() };
      file.siguienteId += 1;
      saveNotes(path, file);
      return text(`Nota ${id} creada.`);
    }
    case "editar_nota": {
      const id = requireId(args);
      const note = find(id);
      if (typeof args.titulo !== "string" && typeof args.texto !== "string") {
        throw new NotesError('Indica "titulo" o "texto" para editar.');
      }
      if (typeof args.titulo === "string") note.titulo = args.titulo;
      if (typeof args.texto === "string") note.texto = args.texto;
      note.modificada = now();
      saveNotes(path, file);
      return text(`Nota ${id} actualizada.`);
    }
    case "borrar_nota": {
      const id = requireId(args);
      find(id);
      delete file.notas[id];
      saveNotes(path, file);
      return text(`Nota ${id} borrada.`);
    }
    default:
      throw new NotesError(`Herramienta desconocida: ${name}`);
  }
}

/** Arranca el servidor MCP de notas y atiende hasta que se cierre stdin. */
export function runNotesServer(version: string): void {
  const path = notesPath();
  serveStdio({
    onMessage(message, connection) {
      const { id, method } = message;
      const params = (message.params ?? {}) as Json;
      switch (method) {
        case "initialize":
          connection.send({ id, result: initializeResult(params, "agent-sync-notas-juguete", version, INSTRUCTIONS) });
          return;
        case "ping":
          connection.send({ id, result: {} });
          return;
        case "tools/list":
          connection.send({ id, result: { tools: TOOLS } });
          return;
        case "tools/call":
          try {
            const result = callTool(path, String(params.name), (params.arguments ?? {}) as Json);
            connection.send({ id, result });
          } catch (error) {
            // Error de la herramienta: se informa al agente sin cortar la conexión.
            const message = error instanceof NotesError ? error.message : `Error inesperado: ${String(error)}`;
            connection.send({ id, result: { ...text(message), isError: true } });
          }
          return;
        default:
          if (id !== undefined && method !== undefined) {
            connection.send({ id, error: { code: -32601, message: `Método no soportado: ${String(method)}` } });
          }
      }
    },
  });
}

/** Texto para `--mostrar`: dónde está el archivo y qué notas tiene. */
export function describeNotes(): string {
  const path = notesPath();
  try {
    const file = loadNotes(path);
    const ids = Object.keys(file.notas);
    const body = ids.length === 0 ? "(sin notas todavía)" : JSON.stringify(file.notas, null, 2);
    return `Archivo de notas: ${path}\n\n${body}`;
  } catch (error) {
    return `Archivo de notas: ${path}\n\n${error instanceof Error ? error.message : String(error)}`;
  }
}
