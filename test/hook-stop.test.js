// Pruebas del paso 4: el hook "Stop" de Codex.
// Simulan a Codex: ejecutan `agent-sync hook stop` pasándole por stdin el
// mismo JSON que envía Codex, y verifican la respuesta y sus efectos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { appendLog, readLog, MAX_LOG_LINES } = await import(
  new URL("../dist/core/state.js", import.meta.url)
);
const REF = "refs/agent-sync/last";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

function runCli(cwd, args, input) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", input });
}

/** Lo que Codex envía al hook Stop (según su documentación). */
function stopPayload(cwd, extra = {}) {
  return JSON.stringify({
    session_id: "sesion-prueba",
    transcript_path: null,
    cwd,
    hook_event_name: "Stop",
    model: "modelo-prueba",
    permission_mode: "default",
    turn_id: "turno-1",
    stop_hook_active: false,
    last_assistant_message: "Listo, implementé la landing.",
    ...extra,
  });
}

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t) {
  const dir = makeTempDir(t);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Prueba");
  git(dir, "config", "user.email", "prueba@example.com");
  writeFileSync(join(dir, "Hero.tsx"), "<h1>Diseña más rápido</h1>\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "inicial");
  return dir;
}

/** Codex solo termina normalmente si la salida está vacía y el código es 0. */
function assertSilentSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "el hook Stop no debe escribir nada en stdout");
}

test("toma la foto de la carpeta que indica Codex, no de donde se ejecuta", (t) => {
  const repo = makeRepo(t);
  const elsewhere = makeTempDir(t);
  writeFileSync(join(repo, "Testimonios.tsx"), "export const T = 1;\n");

  const result = runCli(elsewhere, ["hook", "stop"], stopPayload(repo));
  assertSilentSuccess(result);

  const files = git(repo, "ls-tree", "-r", "--name-only", REF).split("\n");
  assert.deepEqual(files.sort(), ["Hero.tsx", "Testimonios.tsx"]);
  assert.ok(existsSync(join(repo, ".git", "agent-sync", "baseline.json")));
});

test("después del hook, lo que dejó el agente ya no aparece como cambio", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  // El agente trabaja...
  writeFileSync(join(repo, "Hero.tsx"), "<h1>Versión del agente</h1>\n");
  // ...y Codex termina la tarea:
  assertSilentSuccess(runCli(repo, ["hook", "stop"], stopPayload(repo)));

  assert.match(runCli(repo, ["diff"]).stdout, /Sin cambios/);

  // Ahora el usuario cambia algo por su cuenta: eso sí debe aparecer.
  writeFileSync(join(repo, "Hero.tsx"), "<h1>Versión del usuario</h1>\n");
  assert.match(runCli(repo, ["diff"]).stdout, /modificado\s+Hero\.tsx/);
});

test("registra cada ejecución en la bitácora", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["hook", "stop"], stopPayload(repo, { turn_id: "turno-42" }));

  const log = readFileSync(join(repo, ".git", "agent-sync", "hook.log"), "utf8");
  assert.match(log, /stop {4}foto [0-9a-f]{7} \(1 archivos\) turno=turno-42/);
});

test("no altera historial, staging ni archivos", (t) => {
  const repo = makeRepo(t);
  writeFileSync(join(repo, "Hero.tsx"), "<h1>Cambio sin commitear</h1>\n");
  git(repo, "add", "Hero.tsx");
  writeFileSync(join(repo, "nuevo.txt"), "hola\n");

  const state = () => ({
    head: git(repo, "rev-parse", "HEAD"),
    log: git(repo, "log", "--oneline"),
    status: git(repo, "status", "--porcelain"),
    staged: git(repo, "diff", "--cached", "--name-only"),
  });
  const before = state();
  runCli(repo, ["hook", "stop"], stopPayload(repo));
  assert.deepEqual(state(), before);
});

test("fuera de un repositorio git termina en silencio y sin error", (t) => {
  const dir = makeTempDir(t);
  assertSilentSuccess(runCli(dir, ["hook", "stop"], stopPayload(dir)));
});

test("con stdin vacío o inválido usa la carpeta actual", (t) => {
  const repo = makeRepo(t);
  assertSilentSuccess(runCli(repo, ["hook", "stop"], ""));
  assert.ok(git(repo, "rev-parse", REF));

  assertSilentSuccess(runCli(repo, ["hook", "stop"], "esto no es JSON"));
  assertSilentSuccess(runCli(repo, ["hook", "stop"], "[1, 2, 3]"));
});

test("si falla, lo anota en la bitácora pero no interrumpe a Codex", (t) => {
  const repo = makeRepo(t);
  // Un archivo donde git necesita una carpeta impide guardar la referencia.
  writeFileSync(join(repo, ".git", "refs", "agent-sync"), "bloqueo");

  assertSilentSuccess(runCli(repo, ["hook", "stop"], stopPayload(repo)));
  const log = readFileSync(join(repo, ".git", "agent-sync", "hook.log"), "utf8");
  assert.match(log, /stop {4}ERROR /);
});

test("con stop_hook_active también toma la foto y nunca pide continuar", (t) => {
  const repo = makeRepo(t);
  const result = runCli(repo, ["hook", "stop"], stopPayload(repo, { stop_hook_active: true }));
  assertSilentSuccess(result);
  assert.doesNotMatch(result.stdout + result.stderr, /decision|block/);
});

test("la bitácora conserva solo las últimas líneas", (t) => {
  const dir = makeTempDir(t);
  for (let i = 0; i < MAX_LOG_LINES + 15; i++) appendLog(dir, `línea ${i}`);
  const lines = readLog(dir, 1000);
  assert.equal(lines.length, MAX_LOG_LINES);
  assert.match(lines.at(-1), /línea 214$/);
});

test("status muestra la última foto y las ejecuciones del hook", (t) => {
  const repo = makeRepo(t);
  assert.match(runCli(repo, ["status"]).stdout, /no se ha ejecutado/);

  runCli(repo, ["hook", "stop"], stopPayload(repo));
  const out = runCli(repo, ["status"]).stdout;
  assert.match(out, /Última foto: [0-9a-f]{7} \(1 archivos, rama \S+\)/);
  assert.match(out, /stop {4}foto/);
});

test("un hook desconocido se rechaza", (t) => {
  const repo = makeRepo(t);
  const result = runCli(repo, ["hook", "inventado"], "");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hook desconocido/);
});

test("la plantilla de Codex es JSON válido y llama al hook stop", () => {
  const config = JSON.parse(
    readFileSync(new URL("../examples/codex-hooks.json", import.meta.url), "utf8"),
  );
  const command = config.hooks.Stop[0].hooks[0];
  assert.equal(command.type, "command");
  assert.equal(command.command, "agent-sync hook stop");
});
