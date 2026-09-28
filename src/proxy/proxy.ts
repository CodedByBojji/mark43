// Paso 2 de la fase 2: el proxy transparente.
//
// Codex arranca `agent-sync proxy -- <comando del servidor real>` como si
// fuera el servidor MCP. El proxy arranca el servidor real y reenvía los
// mensajes en ambos sentidos, línea por línea y SIN modificarlos:
//
//   Codex  --stdin-->  proxy  --stdin-->  servidor real
//   Codex  <--stdout-- proxy  <--stdout-- servidor real
//
// Desde el paso 3, además mira los mensajes que pasan (sin cambiarlos) y
// anota las escrituras del agente en .git/agent-sync/registro-apps.jsonl del
// proyecto (ver recorder.ts y registry.ts).
//
// Reglas:
// - Los mensajes se reenvían exactamente como llegan, aunque no sean JSON.
// - stderr del servidor real pasa tal cual a stderr (Codex lo usa para logs).
// - Si el servidor real termina, el proxy termina con el mismo código.
// - Si Codex cierra la conexión, el proxy cierra la del servidor real.

import { type ChildProcess, spawn } from "node:child_process";
import { type Readable, type Writable } from "node:stream";
import { type Repo, findRepo } from "../sources/git.js";
import { WriteRecorder } from "./recorder.js";
import { type RegistryEntry, appendRegistry } from "./registry.js";

export interface ProxyTarget {
  command: string;
  args: string[];
}

/**
 * Lee los argumentos de `agent-sync proxy -- <comando> [args...]`.
 * Devuelve null si falta el comando.
 */
export function parseProxyArgs(options: string[]): ProxyTarget | null {
  const separator = options.indexOf("--");
  const rest = separator === -1 ? options : options.slice(separator + 1);
  const [command, ...args] = rest;
  if (!command) return null;
  return { command, args };
}

/**
 * Reenvía un flujo línea por línea. Después de reenviar cada línea, se la
 * muestra a `observe` (sin el salto). Un error al observar se ignora: nunca
 * debe frenar ni alterar el reenvío.
 */
function forwardLines(from: Readable, to: Writable, observe?: (line: string) => void): void {
  const look = (line: string) => {
    try {
      observe?.(line.replace(/\r?\n$/, ""));
    } catch {
      // El registro es secundario: la conversación sigue igual.
    }
  };
  let buffer = "";
  from.setEncoding("utf8");
  from.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline + 1); // incluye el salto: se reenvía idéntica
      buffer = buffer.slice(newline + 1);
      to.write(line);
      look(line);
    }
  });
  from.on("end", () => {
    // Un último mensaje sin salto de línea también se reenvía.
    if (buffer !== "") {
      to.write(buffer);
      look(buffer);
      buffer = "";
    }
  });
}

/** Anota una escritura en el registro del proyecto (con caché de repositorios). */
function registryWriter(): (projectDir: string, entry: RegistryEntry) => void {
  const repos = new Map<string, Repo | null>();
  return (projectDir, entry) => {
    if (!repos.has(projectDir)) {
      try {
        repos.set(projectDir, findRepo(projectDir));
      } catch {
        repos.set(projectDir, null); // sin git no hay dónde guardar el registro
      }
    }
    const repo = repos.get(projectDir);
    if (!repo) return;
    try {
      appendRegistry(repo.gitDir, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agent-sync proxy: no se pudo anotar la escritura: ${message}\n`);
    }
  };
}

/**
 * Arranca el servidor real y reenvía todo hasta que alguno de los dos termine.
 * Devuelve false si ni siquiera se pudo arrancar (p. ej. un `.cmd` en Windows).
 */
export function runProxy(target: ProxyTarget): boolean {
  let child: ChildProcess;
  try {
    child = spawn(target.command, target.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    fail(target, error);
    return false;
  }

  child.on("error", (error) => fail(target, error));

  const recorder = new WriteRecorder({ cwd: process.cwd(), record: registryWriter() });
  forwardLines(process.stdin, child.stdin!, (line) => recorder.onClientLine(line));
  forwardLines(child.stdout!, process.stdout, (line) => recorder.onServerLine(line));
  child.stderr!.pipe(process.stderr);

  // Codex cerró la conexión: se la cerramos al servidor real.
  process.stdin.on("end", () => child.stdin?.end());
  // Si el servidor real deja de aceptar datos, no se cae el proxy.
  child.stdin!.on("error", () => undefined);

  // "close" (no "exit"): espera a que se reenvíe la última salida del servidor.
  child.on("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
    process.stdin.destroy(); // deja de escuchar a Codex para que el proxy termine
  });

  // Si al proxy lo terminan, no deja al servidor real huérfano.
  process.on("exit", () => {
    if (child.exitCode === null) child.kill();
  });
  return true;
}

function fail(target: ProxyTarget, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-sync proxy: no se pudo arrancar "${target.command}": ${message}\n`);
  process.exitCode = 1;
  process.stdin.destroy();
}
