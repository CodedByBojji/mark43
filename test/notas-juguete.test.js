// Pruebas del paso 1 de la fase 2: la app de juguete (servidor MCP de notas).
// Un "Codex simulado" usa las herramientas y, entre llamadas, las pruebas
// editan el archivo de notas a mano, como haría el usuario.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, initializeParams, startServer } from "./helpers/mcp-client.js";

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Arranca la app con un archivo de notas temporal y hace el saludo MCP. */
async function startNotes(t) {
  const dir = makeTempDir(t);
  const notesPath = join(dir, "notas.json");
  const server = startServer(t, { args: ["notas-juguete"], cwd: dir, env: { AGENT_SYNC_NOTAS: notesPath } });
  const init = await server.request(1, "initialize", initializeParams());
  assert.equal(init.result.serverInfo.name, "agent-sync-notas-juguete");
  server.notify("notifications/initialized");
  return { server, notesPath };
}

const readFile = (path) => JSON.parse(readFileSync(path, "utf8"));

test("ofrece cinco herramientas y marca cuáles solo leen", async (t) => {
  const { server } = await startNotes(t);
  const list = await server.request(2, "tools/list");
  const readOnly = Object.fromEntries(list.result.tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]));
  assert.deepEqual(readOnly, {
    listar_notas: true,
    leer_nota: true,
    crear_nota: false,
    editar_nota: false,
    borrar_nota: false,
  });
  await server.close();
});

test("se puede encontrar buscando 'note' en inglés (así busca Codex)", async (t) => {
  // Verificado el 2026-09-27: Codex buscó /note/i, no encontró "nota" y
  // creó un archivo Compras.txt en el proyecto en lugar de usar la app.
  const dir = makeTempDir(t);
  const server = startServer(t, { args: ["notas-juguete"], cwd: dir, env: { AGENT_SYNC_NOTAS: join(dir, "n.json") } });
  const init = await server.request(1, "initialize", initializeParams());
  assert.match(init.result.instructions, /notes/);
  const list = await server.request(2, "tools/list");
  for (const tool of list.result.tools) assert.match(`${tool.name} ${tool.description}`, /note/i, tool.name);
  await server.close();
});

test("crear, listar, leer, editar y borrar una nota", async (t) => {
  const { server, notesPath } = await startNotes(t);

  assert.equal((await server.callTool("listar_notas")).text, "No hay notas.");
  assert.equal(existsSync(notesPath), false); // leer no crea el archivo

  assert.equal((await server.callTool("crear_nota", { titulo: "Revisión", texto: "Jueves 3pm" })).text, "Nota 1 creada.");
  const created = readFile(notesPath).notas["1"];
  assert.equal(created.texto, "Jueves 3pm");
  assert.match(created.modificada, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal((await server.callTool("listar_notas")).text, "1: Revisión");
  const read = JSON.parse((await server.callTool("leer_nota", { id: "1" })).text);
  assert.deepEqual(read, { id: "1", ...created });

  await server.callTool("editar_nota", { id: "1", texto: "Viernes 10am" });
  const edited = readFile(notesPath).notas["1"];
  assert.equal(edited.titulo, "Revisión");
  assert.equal(edited.texto, "Viernes 10am");

  assert.equal((await server.callTool("borrar_nota", { id: "1" })).text, "Nota 1 borrada.");
  assert.deepEqual(readFile(notesPath).notas, {});
  await server.close();
});

test("un cambio hecho a mano en el archivo se ve de inmediato", async (t) => {
  const { server, notesPath } = await startNotes(t);
  await server.callTool("crear_nota", { titulo: "Botón", texto: "azul" });

  // El usuario edita el archivo por su cuenta, sin pasar por el servidor.
  const file = readFile(notesPath);
  file.notas["1"].texto = "verde";
  writeFileSync(notesPath, JSON.stringify(file, null, 2));

  const read = JSON.parse((await server.callTool("leer_nota", { id: "1" })).text);
  assert.equal(read.texto, "verde");
  await server.close();
});

test("acepta el id como número, porque Codex a veces lo envía así", async (t) => {
  const { server } = await startNotes(t);
  await server.callTool("crear_nota", { titulo: "Prueba", texto: "funciona" });
  const read = await server.callTool("leer_nota", { id: 1 });
  assert.equal(read.isError, undefined);
  assert.equal(JSON.parse(read.text).texto, "funciona");
  assert.equal((await server.callTool("editar_nota", { id: 1, texto: "sí" })).text, "Nota 1 actualizada.");
  await server.close();
});

test("los ids no se repiten aunque el usuario agregue notas a mano", async (t) => {
  const { server, notesPath } = await startNotes(t);
  writeFileSync(notesPath, JSON.stringify({ notas: { "7": { titulo: "a mano", texto: "", modificada: "" } } }));
  assert.equal((await server.callTool("crear_nota", { titulo: "nueva", texto: "" })).text, "Nota 8 creada.");
  await server.close();
});

test("los errores se informan al agente sin cortar la conexión", async (t) => {
  const { server } = await startNotes(t);

  const missing = await server.callTool("leer_nota", { id: "99" });
  assert.equal(missing.isError, true);
  assert.equal(missing.text, "No existe la nota 99.");

  await server.callTool("crear_nota", { titulo: "x", texto: "y" });
  const empty = await server.callTool("editar_nota", { id: "1" });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /Indica "titulo" o "texto"/);

  const noTitle = await server.callTool("crear_nota", { texto: "sin título" });
  assert.equal(noTitle.isError, true);

  const unknown = await server.callTool("inventada");
  assert.equal(unknown.isError, true);

  assert.deepEqual((await server.request(50, "ping")).result, {}); // sigue viva
  await server.close();
});

test("si el usuario rompe el JSON, avisa y no sobrescribe su archivo", async (t) => {
  const { server, notesPath } = await startNotes(t);
  writeFileSync(notesPath, "{ esto no es json");

  const result = await server.callTool("crear_nota", { titulo: "x", texto: "y" });
  assert.equal(result.isError, true);
  assert.match(result.text, /no es JSON válido/);
  assert.equal(readFileSync(notesPath, "utf8"), "{ esto no es json");
  await server.close();
});

test("--mostrar enseña dónde está el archivo y su contenido", (t) => {
  const dir = makeTempDir(t);
  const notesPath = join(dir, "notas.json");
  const env = { ...process.env, AGENT_SYNC_NOTAS: notesPath };

  const empty = spawnSync("node", [cli, "notas-juguete", "--mostrar"], { encoding: "utf8", env });
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /Archivo de notas: .*notas\.json/);
  assert.match(empty.stdout, /sin notas todavía/);

  writeFileSync(notesPath, JSON.stringify({ notas: { "1": { titulo: "Hola", texto: "", modificada: "" } } }));
  const full = spawnSync("node", [cli, "notas-juguete", "--mostrar"], { encoding: "utf8", env });
  assert.match(full.stdout, /"titulo": "Hola"/);
});
