// Pruebas del paso 3 de la fase 2: el proxy anota lo que el agente modifica.
// La primera parte prueba la lógica de decisión con mensajes inventados.
// La segunda usa el proxy de verdad con la app de juguete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, initializeParams, startServer } from "./helpers/mcp-client.js";

const { WriteRecorder } = await import(new URL("../dist/proxy/recorder.js", import.meta.url));
const { trimArguments } = await import(new URL("../dist/proxy/registry.js", import.meta.url));

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t) {
  const dir = makeTempDir(t);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

// --- Lógica de decisión (sin procesos) ---------------------------------------------

const line = (message) => JSON.stringify({ jsonrpc: "2.0", ...message });

/** Un recorder que guarda en memoria lo que anotaría. */
function makeRecorder() {
  const recorded = [];
  const recorder = new WriteRecorder({
    cwd: "/carpeta/de/arranque",
    now: () => "2026-09-27T12:00:00.000Z",
    record: (projectDir, entry) => recorded.push({ projectDir, entry }),
  });
  return { recorder, recorded };
}

const TOOLS = [
  { name: "leer", annotations: { readOnlyHint: true } },
  { name: "escribir", annotations: { readOnlyHint: false } },
  { name: "sin_anotar" },
];

/** Saludo + lista de herramientas, como al empezar una sesión de Codex. */
function handshake(recorder) {
  recorder.onClientLine(line({ id: 0, method: "initialize", params: initializeParams() }));
  recorder.onServerLine(line({ id: 0, result: { serverInfo: { name: "app-x" } } }));
  recorder.onClientLine(line({ id: 1, method: "tools/list" }));
  recorder.onServerLine(line({ id: 1, result: { tools: TOOLS } }));
}

/** Llamada + respuesta de una herramienta. */
function call(recorder, id, name, args, result = { content: [] }, meta) {
  const params = { name, arguments: args, ...(meta ? { _meta: meta } : {}) };
  recorder.onClientLine(line({ id, method: "tools/call", params }));
  recorder.onServerLine(line({ id, result }));
}

test("anota una escritura con servidor, herramienta, argumentos, turno y proyecto", () => {
  const { recorder, recorded } = makeRecorder();
  handshake(recorder);
  const meta = {
    "x-codex-turn-metadata": {
      session_id: "sesion-1",
      turn_id: "turno-7",
      workspaces: { "C:\\proyectos\\mi-app": { has_changes: true } },
    },
  };
  call(recorder, 2, "escribir", { id: "3", texto: "hola" }, undefined, meta);

  assert.deepEqual(recorded, [
    {
      projectDir: "C:\\proyectos\\mi-app",
      entry: {
        fecha: "2026-09-27T12:00:00.000Z",
        servidor: "app-x",
        herramienta: "escribir",
        argumentos: { id: "3", texto: "hola" },
        motivo: "anotacion",
        turno: "turno-7",
        sesion: "sesion-1",
      },
    },
  ]);
});

test("no anota las herramientas de solo lectura", () => {
  const { recorder, recorded } = makeRecorder();
  handshake(recorder);
  call(recorder, 2, "leer", { id: "1" });
  assert.deepEqual(recorded, []);
});

test("no anota las llamadas que fallaron", () => {
  const { recorder, recorded } = makeRecorder();
  handshake(recorder);
  call(recorder, 2, "escribir", {}, { content: [], isError: true }); // error de la herramienta
  recorder.onClientLine(line({ id: 3, method: "tools/call", params: { name: "escribir", arguments: {} } }));
  recorder.onServerLine(line({ id: 3, error: { code: -32602, message: "mal" } })); // error del protocolo
  assert.deepEqual(recorded, []);
});

test("una herramienta sin anotación se anota por prudencia", () => {
  const { recorder, recorded } = makeRecorder();
  handshake(recorder);
  call(recorder, 2, "sin_anotar", {});
  assert.equal(recorded[0].entry.motivo, "sin_anotacion");
});

test("si no vio la lista de herramientas, anota la llamada como desconocida", () => {
  const { recorder, recorded } = makeRecorder();
  call(recorder, 2, "lo_que_sea", {});
  assert.equal(recorded[0].entry.motivo, "desconocida");
  assert.equal(recorded[0].entry.servidor, "desconocido");
});

test("sin datos de Codex, usa la carpeta donde arrancó el proxy", () => {
  const { recorder, recorded } = makeRecorder();
  handshake(recorder);
  call(recorder, 2, "escribir", {});
  assert.equal(recorded[0].projectDir, "/carpeta/de/arranque");
  assert.equal(recorded[0].entry.turno, undefined);
});

test("no confunde respuestas: ids distintos, líneas rotas y respuestas sin pedido", () => {
  const { recorder, recorded } = makeRecorder();
  handshake(recorder);
  recorder.onClientLine(line({ id: "5", method: "tools/call", params: { name: "leer", arguments: {} } }));
  recorder.onClientLine(line({ id: 5, method: "tools/call", params: { name: "escribir", arguments: {} } }));
  recorder.onServerLine(line({ id: "5", result: {} })); // responde a "leer" (id texto)
  assert.deepEqual(recorded, []);
  recorder.onServerLine("esto no es json");
  recorder.onServerLine(line({ id: 99, result: {} })); // nadie la pidió
  recorder.onServerLine(line({ id: 5, result: {} })); // responde a "escribir" (id número)
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].entry.herramienta, "escribir");
});

test("recorta los textos largos de los argumentos", () => {
  const trimmed = trimArguments({ id: "1", texto: "x".repeat(5000), lista: ["y".repeat(300)] });
  assert.equal(trimmed.id, "1");
  assert.match(trimmed.texto, /^x{200}… \(5000 caracteres\)$/);
  assert.match(trimmed.lista[0], /… \(300 caracteres\)$/);
});

// --- Con el proxy y la app de juguete ---------------------------------------------

const viaProxy = ["proxy", "--", "node", cli, "notas-juguete"];

function registryOf(repo) {
  const path = join(repo, ".git", "agent-sync", "registro-apps.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function startProxy(t, cwd, notesPath) {
  const server = startServer(t, { args: viaProxy, cwd, env: { AGENT_SYNC_NOTAS: notesPath } });
  await server.request(1, "initialize", initializeParams());
  server.notify("notifications/initialized");
  await server.request(2, "tools/list");
  return server;
}

test("con la app de juguete: anota crear, editar y borrar, pero no las lecturas ni los errores", async (t) => {
  const repo = makeRepo(t);
  const notesPath = join(makeTempDir(t), "notas.json");
  const server = await startProxy(t, repo, notesPath);

  await server.callTool("listar_notas");
  await server.callTool("crear_nota", { titulo: "Revisión", texto: "Jueves 3pm" });
  await server.callTool("leer_nota", { id: "1" });
  await server.callTool("editar_nota", { id: "1", texto: "Viernes 10am" });
  await server.callTool("editar_nota", { id: "99", texto: "no existe" }); // falla
  await server.callTool("borrar_nota", { id: "1" });
  await server.close();

  const entries = registryOf(repo);
  assert.deepEqual(
    entries.map((e) => [e.servidor, e.herramienta, e.argumentos, e.motivo]),
    [
      ["agent-sync-notas-juguete", "crear_nota", { titulo: "Revisión", texto: "Jueves 3pm" }, "anotacion"],
      ["agent-sync-notas-juguete", "editar_nota", { id: "1", texto: "Viernes 10am" }, "anotacion"],
      ["agent-sync-notas-juguete", "borrar_nota", { id: "1" }, "anotacion"],
    ],
  );

  const shown = spawnSync("node", [cli, "registro"], { cwd: repo, encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /agent-sync-notas-juguete {2}crear_nota \{"titulo":"Revisión","texto":"Jueves 3pm"\}/);
  assert.match(shown.stdout, /borrar_nota \{"id":"1"\}/);
});

test("usa el proyecto que informa Codex, aunque el proxy arranque en otra carpeta", async (t) => {
  const startedIn = makeRepo(t);
  const project = makeRepo(t);
  const server = await startProxy(t, startedIn, join(makeTempDir(t), "notas.json"));
  await server.request(10, "tools/call", {
    name: "crear_nota",
    arguments: { titulo: "a", texto: "b" },
    _meta: { "x-codex-turn-metadata": { turn_id: "turno-1", workspaces: { [project]: {} } } },
  });
  await server.close();

  assert.equal(registryOf(startedIn).length, 0);
  assert.equal(registryOf(project).length, 1);
  assert.equal(registryOf(project)[0].turno, "turno-1");
});

test("fuera de un repositorio git el proxy funciona igual y no anota nada", async (t) => {
  const dir = makeTempDir(t);
  const notesPath = join(makeTempDir(t), "notas.json");
  const server = await startProxy(t, dir, notesPath);
  assert.equal((await server.callTool("crear_nota", { titulo: "a", texto: "b" })).text, "Nota 1 creada.");
  assert.equal(await server.close(), 0);
  assert.equal(existsSync(join(dir, ".git")), false);
});

test("si no se puede escribir el registro, Codex recibe su respuesta igual", async (t) => {
  const repo = makeRepo(t);
  // .git/agent-sync es un archivo, así que no se puede crear el registro dentro.
  writeFileSync(join(repo, ".git", "agent-sync"), "estorbo");
  const server = await startProxy(t, repo, join(makeTempDir(t), "notas.json"));
  assert.equal((await server.callTool("crear_nota", { titulo: "a", texto: "b" })).text, "Nota 1 creada.");
  assert.equal((await server.callTool("listar_notas")).text, "1: a");
  await server.close();
  assert.match(server.stderr(), /no se pudo anotar la escritura/);
});

test("registro sin escrituras lo dice", (t) => {
  const repo = makeRepo(t);
  mkdirSync(join(repo, "sub"));
  const shown = spawnSync("node", [cli, "registro"], { cwd: join(repo, "sub"), encoding: "utf8" });
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /todavía no ha modificado nada/);
});
