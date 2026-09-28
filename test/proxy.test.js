// Pruebas del paso 2 de la fase 2: el proxy transparente.
// Comparan hablar con un servidor MCP directamente y a través del proxy:
// Codex no debe notar ninguna diferencia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, initializeParams, startServer } from "./helpers/mcp-client.js";

const { parseProxyArgs } = await import(new URL("../dist/proxy/proxy.js", import.meta.url));

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Argumentos para arrancar un comando de agent-sync detrás del proxy. */
const viaProxy = (...args) => ["proxy", "--", "node", cli, ...args];

const seedNotes = (path) =>
  writeFileSync(
    path,
    JSON.stringify({
      notas: { "1": { titulo: "Revisión", texto: "Jueves 3pm", modificada: "2026-09-27T10:00:00.000Z" } },
      siguienteId: 2,
    }),
  );

/** La misma conversación de solo lectura, para comparar con y sin proxy. */
async function readOnlyConversation(t, args, notesPath, cwd) {
  const server = startServer(t, { args, cwd, env: { AGENT_SYNC_NOTAS: notesPath } });
  await server.request(1, "initialize", initializeParams());
  server.notify("notifications/initialized");
  await server.request(2, "tools/list");
  await server.request(3, "tools/call", { name: "listar_notas", arguments: {} });
  await server.request(4, "tools/call", { name: "leer_nota", arguments: { id: "1" } });
  await server.request(5, "tools/call", { name: "leer_nota", arguments: { id: "99" } });
  await server.request(6, "metodo/inventado");
  assert.equal(await server.close(), 0);
  return server.rawStdout();
}

test("con proxy, Codex recibe exactamente lo mismo, byte a byte", async (t) => {
  const dir = makeTempDir(t);
  const notesPath = join(dir, "notas.json");
  seedNotes(notesPath);

  const direct = await readOnlyConversation(t, ["notas-juguete"], notesPath, dir);
  const proxied = await readOnlyConversation(t, viaProxy("notas-juguete"), notesPath, dir);
  assert.ok(direct.length > 500, "la conversación debía tener contenido");
  assert.equal(proxied, direct);
});

test("las escrituras llegan a la app a través del proxy", async (t) => {
  const dir = makeTempDir(t);
  const notesPath = join(dir, "notas.json");
  const server = startServer(t, { args: viaProxy("notas-juguete"), cwd: dir, env: { AGENT_SYNC_NOTAS: notesPath } });
  await server.request(1, "initialize", initializeParams());
  assert.equal((await server.callTool("crear_nota", { titulo: "Botón", texto: "azul" })).text, "Nota 1 creada.");
  assert.equal(JSON.parse(readFileSync(notesPath, "utf8")).notas["1"].texto, "azul");
  await server.close();
});

test("las preguntas del servidor a Codex también pasan (en ambos sentidos)", async (t) => {
  const dir = makeTempDir(t);
  const logPath = join(dir, "diag.jsonl");
  const server = startServer(t, {
    args: viaProxy("diagnostico-mcp"),
    cwd: dir,
    env: { AGENT_SYNC_DIAGNOSTICO: logPath },
    answer: (m) =>
      m.method === "roots/list" ? { jsonrpc: "2.0", id: m.id, result: { roots: [{ uri: "file:///mi-app" }] } } : undefined,
  });
  await server.request(1, "initialize", initializeParams({ roots: {} }));
  server.notify("notifications/initialized");
  await server.waitFor((m) => m.method === "roots/list"); // servidor -> Codex
  const call = await server.callTool("diagnostico");
  assert.match(call.text, /mi-app/); // la respuesta de Codex llegó al servidor
  await server.close();
});

test("una línea que no es JSON pasa sin cambios", async (t) => {
  const dir = makeTempDir(t);
  const logPath = join(dir, "diag.jsonl");
  const server = startServer(t, { args: viaProxy("diagnostico-mcp"), cwd: dir, env: { AGENT_SYNC_DIAGNOSTICO: logPath } });
  await server.request(1, "initialize", initializeParams());
  server.writeRaw("esto no es json\n");
  await server.request(2, "ping");
  await server.close();
  const log = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.evento === "linea_invalida" && e.linea === "esto no es json"));
});

test("un mensaje grande (300 KB) llega completo", async (t) => {
  const dir = makeTempDir(t);
  const notesPath = join(dir, "notas.json");
  const server = startServer(t, { args: viaProxy("notas-juguete"), cwd: dir, env: { AGENT_SYNC_NOTAS: notesPath } });
  await server.request(1, "initialize", initializeParams());
  const big = "ñ".repeat(150_000) + "fin";
  await server.callTool("crear_nota", { titulo: "grande", texto: big });
  const read = JSON.parse((await server.callTool("leer_nota", { id: "1" })).text);
  assert.equal(read.texto, big);
  await server.close();
});

test("cuando Codex cierra la conexión, el proxy y el servidor terminan", async (t) => {
  const dir = makeTempDir(t);
  const logPath = join(dir, "diag.jsonl");
  const server = startServer(t, { args: viaProxy("diagnostico-mcp"), cwd: dir, env: { AGENT_SYNC_DIAGNOSTICO: logPath } });
  await server.request(1, "initialize", initializeParams());
  assert.equal(await server.close(), 0);
  const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.at(-1).evento, "fin"); // el servidor real vio el cierre
});

test("si el servidor real termina, el proxy termina con su mismo código y su stderr", async (t) => {
  const dir = makeTempDir(t);
  const server = startServer(t, {
    args: ["proxy", "--", "node", "-e", "console.error('fallo del servidor'); process.exit(3)"],
    cwd: dir,
  });
  assert.equal(await server.exited, 3);
  assert.match(server.stderr(), /fallo del servidor/);
  assert.equal(server.rawStdout(), "");
});

test("sin comando explica el uso y no escribe nada en stdout", () => {
  const result = spawnSync("node", [cli, "proxy"], { encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Uso: agent-sync proxy -- <comando>/);
});

test("un comando que no existe se informa por stderr", () => {
  const result = spawnSync("node", [cli, "proxy", "--", "comando-que-no-existe-12345"], {
    encoding: "utf8",
    input: "",
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no se pudo arrancar "comando-que-no-existe-12345"/);
});

test("en Windows, un .cmd que no se puede arrancar termina con código 1 (no 0)", { skip: process.platform !== "win32" }, () => {
  // spawn falla al instante con un .cmd; antes el CLI pisaba el error con 0.
  const result = spawnSync("node", [cli, "proxy", "--", "npx.cmd", "--version"], { encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no se pudo arrancar "npx\.cmd"/);
});

test("parseProxyArgs separa el comando de sus argumentos", () => {
  assert.deepEqual(parseProxyArgs(["--", "node", "app.js", "--flag"]), { command: "node", args: ["app.js", "--flag"] });
  assert.deepEqual(parseProxyArgs(["node", "app.js"]), { command: "node", args: ["app.js"] });
  assert.equal(parseProxyArgs(["--"]), null);
  assert.equal(parseProxyArgs([]), null);
});
