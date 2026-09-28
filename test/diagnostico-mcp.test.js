// Pruebas del paso 0 de la fase 2: el servidor MCP de diagnóstico.
// Simulan a Codex: arrancan el servidor, le envían mensajes JSON-RPC por
// stdin (uno por línea) y revisan las respuestas y lo que quedó anotado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, initializeParams as initialize, startServer as start } from "./helpers/mcp-client.js";

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Arranca el servidor de diagnóstico con una variable "secreta" de prueba. */
const startServer = (t, { cwd, logPath, answer }) =>
  start(t, {
    args: ["diagnostico-mcp"],
    cwd,
    env: { AGENT_SYNC_DIAGNOSTICO: logPath, SECRETO_DE_PRUEBA: "valor-muy-secreto" },
    answer,
  });

const readLog = (path) =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("responde al saludo MCP y ofrece la herramienta de diagnóstico", async (t) => {
  const dir = makeTempDir(t);
  const server = startServer(t, { cwd: dir, logPath: join(dir, "diag.jsonl") });

  const init = await server.request(1, "initialize", initialize());
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "agent-sync-diagnostico");
  server.notify("notifications/initialized");

  const list = await server.request(2, "tools/list");
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["diagnostico"]);
  assert.equal(list.result.tools[0].annotations.readOnlyHint, true);

  const call = await server.request(3, "tools/call", { name: "diagnostico", arguments: {} });
  assert.match(call.result.content[0].text, /Carpeta de trabajo del servidor: /);
  assert.match(call.result.content[0].text, /codex-simulado/);

  const unknown = await server.request(4, "recurso/inventado");
  assert.equal(unknown.error.code, -32601);
  await server.close();
});

test("anota la carpeta de trabajo, los mensajes y solo los NOMBRES de las variables", async (t) => {
  const dir = makeTempDir(t);
  const logPath = join(dir, "diag.jsonl");
  const server = startServer(t, { cwd: dir, logPath });
  await server.request(1, "initialize", initialize());
  await server.close();

  const log = readLog(logPath);
  const start = log.find((e) => e.evento === "inicio");
  assert.equal(realpathSync(start.cwd), realpathSync(dir));
  assert.ok(start.variables.includes("SECRETO_DE_PRUEBA"));
  assert.doesNotMatch(readFileSync(logPath, "utf8"), /valor-muy-secreto/);
  assert.ok(log.some((e) => e.evento === "entrada" && e.mensaje.method === "initialize"));
  assert.ok(log.some((e) => e.evento === "salida" && e.mensaje.id === 1));
  assert.equal(log.at(-1).evento, "fin");
});

test("si el cliente sabe informar roots, se los pregunta y los anota", async (t) => {
  const dir = makeTempDir(t);
  const logPath = join(dir, "diag.jsonl");
  const roots = [{ uri: "file:///C:/proyectos/mi-app", name: "mi-app" }];
  const server = startServer(t, {
    cwd: dir,
    logPath,
    answer: (m) => (m.method === "roots/list" ? { jsonrpc: "2.0", id: m.id, result: { roots } } : undefined),
  });

  await server.request(1, "initialize", initialize({ roots: { listChanged: true } }));
  server.notify("notifications/initialized");
  await server.waitFor((m) => m.method === "roots/list");
  const call = await server.request(2, "tools/call", { name: "diagnostico", arguments: {} });
  assert.match(call.result.content[0].text, /mi-app/);
  await server.close();

  const shown = spawnSync("node", [cli, "diagnostico-mcp", "--mostrar"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_SYNC_DIAGNOSTICO: logPath },
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Cliente: \{"name":"codex-simulado"/);
  assert.match(shown.stdout, /Roots: \{"roots":\[\{"uri":"file:\/\/\/C:\/proyectos\/mi-app"/);
  assert.match(shown.stdout, /Sesión terminada: sí/);
});

test("sin roots en el cliente no pregunta nada", async (t) => {
  const dir = makeTempDir(t);
  const logPath = join(dir, "diag.jsonl");
  const server = startServer(t, { cwd: dir, logPath });
  await server.request(1, "initialize", initialize());
  server.notify("notifications/initialized");
  await server.request(2, "ping");
  await server.close();
  assert.ok(!readLog(logPath).some((e) => e.evento === "salida" && e.mensaje.method === "roots/list"));
});

test("una línea que no es JSON no rompe el servidor", async (t) => {
  const dir = makeTempDir(t);
  const logPath = join(dir, "diag.jsonl");
  const server = startServer(t, { cwd: dir, logPath });
  await server.request(1, "initialize", initialize());
  server.writeRaw("esto no es json\n");
  const pong = await server.request(2, "ping"); // sigue respondiendo
  assert.deepEqual(pong.result, {});
  await server.close();
  assert.ok(readLog(logPath).some((e) => e.evento === "linea_invalida" && e.linea === "esto no es json"));
});

test("--mostrar sin diagnóstico previo lo explica", (t) => {
  const dir = makeTempDir(t);
  const shown = spawnSync("node", [cli, "diagnostico-mcp", "--mostrar"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_SYNC_DIAGNOSTICO: join(dir, "no-existe.jsonl") },
  });
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /Todavía no hay diagnóstico/);
});
