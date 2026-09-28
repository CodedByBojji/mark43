// Conexión MCP por stdio: mensajes JSON-RPC, uno por línea.
// La usan los servidores de la fase 2 (diagnóstico, app de juguete y, más
// adelante, el proxy). stdout es SOLO para estos mensajes.

export type Json = Record<string, unknown>;

export interface StdioConnection {
  /** Envía un mensaje; agrega `jsonrpc: "2.0"`. */
  send(message: Json): void;
}

export interface StdioHandlers {
  /** Cada mensaje JSON recibido. */
  onMessage(message: Json, connection: StdioConnection): void;
  /** Una línea que no es JSON válido. No corta la conexión. */
  onInvalidLine?(line: string): void;
  /** Cada mensaje enviado (para anotarlo, si hace falta). */
  onSend?(message: Json): void;
  /** stdin se cerró: el cliente terminó la sesión. */
  onEnd?(): void;
}

/** Atiende mensajes por stdin/stdout hasta que se cierre stdin. */
export function serveStdio(handlers: StdioHandlers): StdioConnection {
  const connection: StdioConnection = {
    send(message) {
      handlers.onSend?.(message);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    },
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        handlers.onInvalidLine?.(line);
        continue;
      }
      if (typeof message === "object" && message !== null && !Array.isArray(message)) {
        handlers.onMessage(message as Json, connection);
      } else {
        handlers.onInvalidLine?.(line);
      }
    }
  });
  process.stdin.on("end", () => handlers.onEnd?.());
  return connection;
}

/**
 * Respuesta estándar al saludo `initialize` de un servidor que solo ofrece
 * herramientas. `instructions` (opcional, parte de MCP) le explica al agente
 * para qué sirve el servidor.
 */
export function initializeResult(params: Json, name: string, version: string, instructions?: string): Json {
  return {
    protocolVersion: params.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name, version },
    ...(instructions ? { instructions } : {}),
  };
}
