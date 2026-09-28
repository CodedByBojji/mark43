// Cliente MCP simulado para las pruebas: hace el papel de Codex.
// Arranca un comando de agent-sync, le envía mensajes JSON-RPC por stdin
// (uno por línea) y recoge sus respuestas.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/**
 * Arranca `node dist/cli.js <args>` como lo haría Codex.
 * `answer(message)` permite responder preguntas del servidor al cliente.
 */
export function startServer(t, { args, cwd, env = {}, answer = () => undefined }) {
  const child = spawn("node", [cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());

  /** Se resuelve con el código de salida cuando el proceso termina. */
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  /** Todo lo que se recibió por stdout, tal cual (para comparar byte a byte). */
  let rawStdout = "";

  const received = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rawStdout += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline)); // stdout solo lleva JSON
      buffer = buffer.slice(newline + 1);
      const reply = answer(message);
      if (reply) child.stdin.write(JSON.stringify(reply) + "\n");
      received.push(message);
      for (const waiter of [...waiters]) waiter();
    }
  });

  const waitFor = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("el servidor no respondió")), 5000);
      const check = () => {
        const found = received.find(predicate);
        if (found) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found);
        }
      };
      waiters.push(check);
      check();
    });

  let nextId = 1000;
  const request = (id, method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return waitFor((m) => m.id === id && m.method === undefined);
  };
  /** Llama una herramienta y devuelve `result` (con `text` = primer texto). */
  const callTool = async (name, args = {}) => {
    const reply = await request(nextId++, "tools/call", { name, arguments: args });
    return { ...reply.result, text: reply.result?.content?.[0]?.text };
  };
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const writeRaw = (text) => child.stdin.write(text);
  /** Cierra la conexión (como Codex al salir) y espera a que el proceso termine. */
  const close = () => {
    child.stdin.end();
    return exited;
  };

  return {
    request,
    callTool,
    notify,
    close,
    waitFor,
    writeRaw,
    exited,
    stderr: () => stderr,
    rawStdout: () => rawStdout,
  };
}

export const initializeParams = (capabilities = {}) => ({
  protocolVersion: "2025-06-18",
  capabilities,
  clientInfo: { name: "codex-simulado", version: "1.0" },
});
