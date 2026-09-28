// Pruebas del paso 5: el hook "UserPromptSubmit" de Codex.
// Simulan a Codex enviando su JSON por stdin y verifican que la respuesta
// tenga el formato correcto, respete el tamaño y nunca bloquee el prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { buildSummaryWithin } = await import(new URL("../dist/core/summary.js", import.meta.url));
const REF = "refs/agent-sync/last";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

function runCli(cwd, args, input) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", input });
}

function payload(event, cwd, extra = {}) {
  return JSON.stringify({
    session_id: "sesion-prueba",
    transcript_path: null,
    cwd,
    hook_event_name: event,
    model: "modelo-prueba",
    permission_mode: "default",
    turn_id: "turno-1",
    ...(event === "UserPromptSubmit" ? { prompt: "Agrega una sección de testimonios" } : {}),
    ...(event === "Stop" ? { stop_hook_active: false, last_assistant_message: "Listo" } : {}),
    ...extra,
  });
}

const prompt = (cwd, args = []) =>
  runCli(cwd, ["hook", "prompt", ...args], payload("UserPromptSubmit", cwd));
const stop = (cwd) => runCli(cwd, ["hook", "stop"], payload("Stop", cwd));

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

/** Interpreta la respuesta del hook y valida el formato que espera Codex. */
function parseContext(result) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  return output.hookSpecificOutput.additionalContext;
}

function assertSilent(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

// --- El ciclo completo ------------------------------------------------------------

test("ciclo completo: el agente trabaja, el usuario edita, el agente se entera", (t) => {
  const repo = makeRepo(t);

  // Tarea 1: Codex trabaja y termina.
  assertSilent(prompt(repo)); // primera vez: foto inicial, nada que decir
  writeFileSync(join(repo, "Hero.tsx"), "<h1>Versión del agente</h1>\n");
  assertSilent(stop(repo));

  // El usuario edita por su cuenta.
  writeFileSync(join(repo, "Hero.tsx"), "<h1>Diseña sin límites</h1>\n");
  writeFileSync(join(repo, "Testimonios.tsx"), "export const T = 1;\n");

  // Tarea 2: al enviar el prompt, Codex recibe el resumen.
  const context = parseContext(prompt(repo));
  assert.match(context, /^<cambios_externos>/);
  assert.match(context, /- modificado: Hero\.tsx/);
  assert.match(context, /- nuevo: Testimonios\.tsx/);
  assert.match(context, /^-<h1>Versión del agente<\/h1>$/m);
  assert.match(context, /^\+<h1>Diseña sin límites<\/h1>$/m);

  // Codex termina la tarea 2: la foto absorbe todo.
  assertSilent(stop(repo));

  // Tarea 3: nada nuevo que contar.
  assertSilent(prompt(repo));
});

// --- Formato y seguridad -------------------------------------------------------------

test("sin cambios no escribe nada: el prompt pasa intacto", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  assertSilent(prompt(repo));
});

test("la primera vez en un proyecto toma la foto inicial en silencio", (t) => {
  const repo = makeRepo(t);
  assertSilent(prompt(repo));
  assert.ok(git(repo, "rev-parse", REF));
  const log = readFileSync(join(repo, ".git", "agent-sync", "hook.log"), "utf8");
  assert.match(log, /prompt {2}sin foto previa: foto inicial/);
});

test("no modifica la foto: si la tarea se interrumpe, el aviso se repite", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  const before = git(repo, "rev-parse", REF);
  writeFileSync(join(repo, "Hero.tsx"), "cambio del usuario\n");

  parseContext(prompt(repo));
  assert.equal(git(repo, "rev-parse", REF), before);
  assert.match(parseContext(prompt(repo)), /Hero\.tsx/); // sin Stop, se repite
});

test("nunca bloquea el prompt ni responde con decision", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, "Hero.tsx"), "cambio\n");
  const result = prompt(repo);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /"decision"/);
});

test("fuera de un repositorio git no escribe nada", (t) => {
  const dir = makeTempDir(t);
  assertSilent(prompt(dir));
});

test("con stdin vacío o inválido usa la carpeta actual", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, "Hero.tsx"), "cambio\n");
  assert.match(parseContext(runCli(repo, ["hook", "prompt"], "")), /Hero\.tsx/);
  assert.match(parseContext(runCli(repo, ["hook", "prompt"], "{roto")), /Hero\.tsx/);
});

test("si la referencia de la foto está dañada, se recupera con una foto nueva", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, ".git", "refs", "agent-sync", "last"), "0".repeat(40) + "\n");

  assertSilent(prompt(repo));
  const log = readFileSync(join(repo, ".git", "agent-sync", "hook.log"), "utf8");
  assert.match(log, /prompt {2}sin foto previa: foto inicial/);
  assert.notEqual(git(repo, "rev-parse", REF), "0".repeat(40));
});

test("si falla, lo anota en la bitácora y deja pasar el prompt", (t) => {
  const repo = makeRepo(t);
  writeFileSync(join(repo, "Hero.tsx"), "contenido solo de la foto\n");
  runCli(repo, ["snapshot"]);
  // Se borra el árbol de archivos de la foto dentro de git: comparar es imposible.
  const tree = git(repo, "rev-parse", `${REF}^{tree}`);
  rmSync(join(repo, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  writeFileSync(join(repo, "Hero.tsx"), "cambio del usuario\n");

  assertSilent(prompt(repo));
  const log = readFileSync(join(repo, ".git", "agent-sync", "hook.log"), "utf8");
  assert.match(log, /prompt {2}ERROR /);
});

test("registra en la bitácora cuántos cambios envió", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, "Hero.tsx"), "cambio\n");
  prompt(repo);
  const log = readFileSync(join(repo, ".git", "agent-sync", "hook.log"), "utf8");
  assert.match(log, /prompt {2}1 cambios enviados a Codex \(\d+ caracteres\)/);
});

test("nunca envía el contenido de un .env", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, ".env"), "API_KEY=secreta123\n");
  const context = parseContext(prompt(repo));
  assert.match(context, /- nuevo: \.env/);
  assert.doesNotMatch(context, /secreta123/);
});

// --- Tamaño ---------------------------------------------------------------------------

test("respeta el tamaño por defecto con cambios grandes", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, "grande.txt"), "línea de contenido\n".repeat(2000));
  writeFileSync(join(repo, "Hero.tsx"), "<h1>Diseña sin límites</h1>\n");
  const context = parseContext(prompt(repo));
  assert.ok(context.length <= 6000, `mide ${context.length}`);
  assert.match(context, /Diseña sin límites/); // el cambio pequeño sí entra
  assert.match(context, /- nuevo: grande\.txt \(\+2000, sin detalle\)/);
  assert.match(context, /no cupieron por tamaño/);
});

test("--limit ajusta el tamaño; un valor inválido usa el de por defecto", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, "Hero.tsx"), "<h1>Diseña sin límites</h1>\n");

  const small = parseContext(prompt(repo, ["--limit", "400"]));
  assert.ok(small.length <= 400, `mide ${small.length}`);
  assert.match(small, /- modificado: Hero\.tsx/);

  assert.match(parseContext(prompt(repo, ["--limit", "abc"])), /Diseña sin límites/);
});

test("buildSummaryWithin siempre respeta el límite", () => {
  const changes = Array.from({ length: 120 }, (_, i) => ({
    kind: "modified",
    path: `src/componentes/archivo-con-nombre-largo-${i}.tsx`,
    added: 3,
    deleted: 1,
    binary: false,
    patch: `diff --git a/f${i} b/f${i}\n` + "+nueva línea\n".repeat(40),
  }));
  for (const maxChars of [100, 500, 1500, 3000, 6000, 20000]) {
    const text = buildSummaryWithin(changes, { maxChars, takenAt: "2026-09-26T20:00:00Z" });
    assert.ok(text.length <= maxChars, `límite ${maxChars}, mide ${text.length}`);
    assert.match(text, /^<cambios_externos>/);
    assert.match(text, /<\/cambios_externos>$/);
  }
  assert.equal(buildSummaryWithin([], { maxChars: 1000 }), null);
});

test("la plantilla de Codex configura ambos hooks", () => {
  const config = JSON.parse(
    readFileSync(new URL("../examples/codex-hooks.json", import.meta.url), "utf8"),
  );
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].command, "agent-sync hook prompt");
  assert.equal(config.hooks.Stop[0].hooks[0].command, "agent-sync hook stop");
});
