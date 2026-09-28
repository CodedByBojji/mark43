// Observa los mensajes que pasan por el proxy y detecta las escrituras
// (fase 2, paso 3). Nunca modifica ni retiene mensajes: solo los lee.
//
// Cómo decide qué es una escritura:
// 1. Cuando el servidor responde `tools/list`, guarda las anotaciones de cada
//    herramienta. MCP define `readOnlyHint: true` para las que solo leen.
// 2. Cuando el agente llama una herramienta (`tools/call`), espera la
//    respuesta. Si la llamada salió bien y la herramienta no es de solo
//    lectura, la anota como escritura.
//
// Una herramienta sin anotación se considera escritura por prudencia: es
// mejor revisar de más que dejar pasar un cambio. Las llamadas que fallaron
// no se anotan, porque no modificaron nada.

import { type RegistryEntry, trimArguments } from "./registry.js";
import { type Json } from "./stdio.js";

export interface RecorderOptions {
  /** Carpeta donde arrancó el proxy; se usa si Codex no dice el proyecto. */
  cwd: string;
  /** Anota una escritura en el registro del proyecto indicado. */
  record(projectDir: string, entry: RegistryEntry): void;
  now?: () => string;
}

interface Pending {
  method: string;
  params: Json;
}

/** Los datos que Codex agrega a cada llamada (verificado en el paso 0; no documentado). */
interface CodexTurnMetadata {
  session_id?: string;
  turn_id?: string;
  workspaces?: Record<string, unknown>;
}

function parse(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

export class WriteRecorder {
  private readonly pending = new Map<string, Pending>();
  /** Nombre de herramienta → readOnlyHint (undefined si no lo informa). */
  private readonly tools = new Map<string, boolean | undefined>();
  private serverName = "desconocido";

  constructor(private readonly options: RecorderOptions) {}

  /** Una línea que va de Codex al servidor. */
  onClientLine(line: string): void {
    const message = parse(line);
    if (!message || typeof message.method !== "string" || message.id === undefined) return;
    this.pending.set(JSON.stringify(message.id), {
      method: message.method,
      params: (message.params ?? {}) as Json,
    });
  }

  /** Una línea que va del servidor a Codex. */
  onServerLine(line: string): void {
    const message = parse(line);
    if (!message || message.method !== undefined || message.id === undefined) return;
    const key = JSON.stringify(message.id);
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);

    const result = (message.result ?? {}) as Json;
    switch (request.method) {
      case "initialize": {
        const info = result.serverInfo as Json | undefined;
        if (typeof info?.name === "string") this.serverName = info.name;
        return;
      }
      case "tools/list":
        for (const tool of (result.tools ?? []) as Json[]) {
          if (typeof tool.name !== "string") continue;
          const hint = (tool.annotations as Json | undefined)?.readOnlyHint;
          this.tools.set(tool.name, typeof hint === "boolean" ? hint : undefined);
        }
        return;
      case "tools/call":
        this.onToolResult(request.params, message, result);
        return;
    }
  }

  private onToolResult(params: Json, response: Json, result: Json): void {
    if (response.error !== undefined || result.isError === true) return; // no modificó nada
    const name = String(params.name);

    let motivo: RegistryEntry["motivo"];
    if (!this.tools.has(name)) motivo = "desconocida";
    else if (this.tools.get(name) === true) return; // solo lectura
    else motivo = this.tools.get(name) === false ? "anotacion" : "sin_anotacion";

    const meta = ((params._meta as Json | undefined)?.["x-codex-turn-metadata"] ?? {}) as CodexTurnMetadata;
    const workspace = Object.keys(meta.workspaces ?? {})[0];
    const entry: RegistryEntry = {
      fecha: this.options.now?.() ?? new Date().toISOString(),
      servidor: this.serverName,
      herramienta: name,
      argumentos: trimArguments(params.arguments ?? {}),
      motivo,
      ...(meta.turn_id ? { turno: meta.turn_id } : {}),
      ...(meta.session_id ? { sesion: meta.session_id } : {}),
    };
    this.options.record(workspace ?? this.options.cwd, entry);
  }
}
