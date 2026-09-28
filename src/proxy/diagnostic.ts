// Paso 0 de la fase 2: un servidor MCP mínimo para averiguar cómo lo arranca
// Codex. No hace nada útil: anota en un archivo con qué carpeta de trabajo,
// argumentos y variables de entorno lo lanzaron, y cada mensaje que recibe
// y envía. Con eso se decide cómo construir el proxy (dónde guardar el
// registro, cómo saber cuál es el proyecto).
//
// Protocolo: MCP por stdio = mensajes JSON-RPC, uno por línea. stdout es SOLO
// para esos mensajes; cualquier otra cosa escrita ahí rompería la conexión.
//
// Privacidad: de las variables de entorno se anotan solo los NOMBRES, nunca
// los valores (pueden contener tokens o contraseñas).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Json, initializeResult, serveStdio } from "./stdio.js";

/** Líneas que se conservan en el archivo de diagnóstico. */
const MAX_LINES = 1000;

/** Dónde se anota el diagnóstico. Se puede cambiar con AGENT_SYNC_DIAGNOSTICO. */
export function diagnosticPath(): string {
  return process.env.AGENT_SYNC_DIAGNOSTICO ?? join(homedir(), ".agent-sync", "diagnostico-mcp.jsonl");
}

function record(path: string, entry: Json): void {
  try {
    appendFileSync(path, JSON.stringify({ fecha: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    // El diagnóstico nunca debe romper la conexión con Codex.
  }
}

/** Recorta el archivo a las últimas MAX_LINES líneas. */
function trim(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_LINES) writeFileSync(path, lines.slice(-MAX_LINES).join("\n") + "\n", "utf8");
}

/** Arranca el servidor de diagnóstico y atiende mensajes hasta que se cierre stdin. */
export function runDiagnosticServer(version: string): void {
  const path = diagnosticPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    trim(path);
  } catch {
    // Sin archivo igual se atiende a Codex.
  }

  record(path, {
    evento: "inicio",
    pid: process.pid,
    cwd: process.cwd(),
    argv: process.argv,
    node: process.execPath,
    variables: Object.keys(process.env).sort(),
  });

  let clientCapabilities: Json = {};
  let roots: unknown = null;
  let clientInfo: unknown = null;

  const handle = (message: Json, send: (message: Json) => void) => {
    const { id, method } = message;
    const params = (message.params ?? {}) as Json;

    // Respuesta a una pregunta nuestra (roots/list).
    if (method === undefined) {
      if (id === "roots-1") roots = (message.result as Json | undefined)?.roots ?? message.error;
      return;
    }

    switch (method) {
      case "initialize":
        clientCapabilities = (params.capabilities ?? {}) as Json;
        clientInfo = params.clientInfo ?? null;
        send({ id, result: initializeResult(params, "agent-sync-diagnostico", version) });
        return;
      case "notifications/initialized":
        // Si Codex dice que sabe informar sus "roots" (carpetas de trabajo),
        // se las preguntamos: podrían decirnos cuál es el proyecto.
        if (clientCapabilities.roots) send({ id: "roots-1", method: "roots/list" });
        return;
      case "ping":
        send({ id, result: {} });
        return;
      case "tools/list":
        send({
          id,
          result: {
            tools: [
              {
                name: "diagnostico",
                description:
                  "Herramienta de prueba de agent-sync. Muestra con qué carpeta de trabajo y qué datos arrancó Codex este servidor MCP.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
        return;
      case "tools/call": {
        if (params.name !== "diagnostico") {
          send({ id, error: { code: -32602, message: `Herramienta desconocida: ${String(params.name)}` } });
          return;
        }
        const text = [
          `Carpeta de trabajo del servidor: ${process.cwd()}`,
          `Cliente: ${JSON.stringify(clientInfo)}`,
          `Roots informados por el cliente: ${JSON.stringify(roots)}`,
          `Diagnóstico completo en: ${path}`,
        ].join("\n");
        send({ id, result: { content: [{ type: "text", text }] } });
        return;
      }
      default:
        // Otras peticiones: "no existe". Las notificaciones (sin id) se ignoran.
        if (id !== undefined) send({ id, error: { code: -32601, message: `Método no soportado: ${String(method)}` } });
    }
  };

  serveStdio({
    onMessage(message, connection) {
      record(path, { evento: "entrada", mensaje: message });
      handle(message, (reply) => connection.send(reply));
    },
    onSend: (message) => record(path, { evento: "salida", mensaje: message }),
    onInvalidLine: (line) => record(path, { evento: "linea_invalida", linea: line.slice(0, 500) }),
    onEnd: () => record(path, { evento: "fin", motivo: "stdin cerrado" }),
  });
}

/** Resumen legible de la última sesión anotada, para `--mostrar`. */
export function describeLastSession(): string {
  const path = diagnosticPath();
  if (!existsSync(path)) return `Todavía no hay diagnóstico en ${path}.\nCodex no ha arrancado el servidor de diagnóstico.`;

  const entries = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  const start = entries.map((e) => e.evento).lastIndexOf("inicio");
  if (start === -1) return `No hay ninguna sesión completa en ${path}.`;
  const session = entries.slice(start);
  const first = session[0]!;

  const incoming = session.filter((e) => e.evento === "entrada").map((e) => e.mensaje as Json);
  const init = incoming.find((m) => m.method === "initialize");
  const initParams = (init?.params ?? {}) as Json;
  const rootsAnswer = incoming.find((m) => m.id === "roots-1" && m.method === undefined);
  const methods = incoming.map((m) => String(m.method ?? `(respuesta ${String(m.id)})`));
  const variables = (first.variables as string[]) ?? [];

  const lines = [
    `Última sesión: ${String(first.fecha)} (pid ${String(first.pid)})`,
    `Carpeta de trabajo (cwd): ${String(first.cwd)}`,
    `Node: ${String(first.node)}`,
    `Argumentos: ${JSON.stringify(first.argv)}`,
    `Cliente: ${JSON.stringify(initParams.clientInfo ?? null)}`,
    `Versión del protocolo pedida: ${String(initParams.protocolVersion ?? "(no llegó initialize)")}`,
    `Capacidades del cliente: ${JSON.stringify(initParams.capabilities ?? null)}`,
    `Roots: ${rootsAnswer ? JSON.stringify(rootsAnswer.result ?? rootsAnswer.error) : "(no se pidieron o no respondió)"}`,
    `Mensajes recibidos: ${methods.join(", ") || "(ninguno)"}`,
    `Variables de entorno (${variables.length}, solo nombres): ${variables.filter((v) => /codex|openai|pwd|path|home/i.test(v)).join(", ")}`,
    `Sesión terminada: ${session.some((e) => e.evento === "fin") ? "sí" : "no (sigue abierta o se cortó)"}`,
    "",
    `Archivo completo: ${path}`,
  ];
  return lines.join("\n");
}
