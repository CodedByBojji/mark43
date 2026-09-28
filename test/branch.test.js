// Pruebas del caso 6: el usuario cambia de rama entre dos tareas del agente.
// El resumen debe decir explícitamente que hubo un cambio de rama, en lugar
// de presentar las diferencias entre ramas como ediciones del usuario.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { buildSummary, buildSummaryWithin } = await import(
  new URL("../dist/core/summary.js", import.meta.url)
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

function runCli(cwd, args, input) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", input });
}

function payload(event, cwd) {
  return JSON.stringify({ session_id: "s", cwd, hook_event_name: event, turn_id: "t" });
}

const prompt = (cwd, args = []) =>
  runCli(cwd, ["hook", "prompt", ...args], payload("UserPromptSubmit", cwd));
const stop = (cwd) => runCli(cwd, ["hook", "stop"], payload("Stop", cwd));

function parseContext(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout, "", "el hook debía escribir un resumen");
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function assertSilent(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

/**
 * Repositorio con dos ramas: `main` y `feature`. En `feature`, app.ts cambia
 * y aparece extra.ts. Termina en `main`.
 */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Prueba");
  git(dir, "config", "user.email", "prueba@example.com");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "app.ts"), 'export const titulo = "Hola";\n');
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "inicial");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "app.ts"), 'export const titulo = "Hola desde feature";\n');
  writeFileSync(join(dir, "extra.ts"), "export const extra = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "feature");
  git(dir, "checkout", "-q", "main");
  return dir;
}

// --- Lógica pura del resumen ------------------------------------------------------

const change = {
  kind: "modified", path: "app.ts", added: 1, deleted: 1, binary: false,
  patch: "diff --git a/app.ts b/app.ts\n-a\n+b",
};

test("con cambio de rama, el resumen lo dice primero y pide avisarle al usuario", () => {
  const text = buildSummary([change], { branchChange: { from: "main", to: "feature" } });
  const lines = text.split("\n");
  assert.match(lines[1], /^Cambio de rama: .*`main` a `feature`/);
  assert.match(text, /avísale al usuario/);
  assert.match(text, /- modificado: app\.ts/);
  // Ya no afirma que el usuario editó todo "por su cuenta".
  assert.doesNotMatch(text, /por su cuenta/);
});

test("un cambio de rama sin diferencias en los archivos igual se avisa", () => {
  const branchChange = { from: "main", to: "copia" };
  const text = buildSummary([], { branchChange });
  assert.match(text, /`main` a `copia`/);
  assert.match(text, /quedaron idénticos/);
  assert.notEqual(buildSummaryWithin([], { branchChange }), null);
});

test("el aviso de rama sobrevive a un límite de tamaño pequeño", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ ...change, path: `archivo${i}.ts` }));
  const text = buildSummaryWithin(many, {
    branchChange: { from: "main", to: "feature" },
    maxChars: 1500,
  });
  assert.ok(text.length <= 1500);
  assert.match(text, /Cambio de rama: .*`main` a `feature`/);
});

// --- Con repositorios reales y el hook ------------------------------------------------

test("caso 6: cambiar de rama entre tareas se avisa explícitamente", (t) => {
  const repo = makeRepo(t);
  assertSilent(prompt(repo)); // foto inicial en main
  assertSilent(stop(repo));

  git(repo, "checkout", "-q", "feature");

  const context = parseContext(prompt(repo));
  assert.match(context, /Cambio de rama: .*`main` a `feature`/);
  assert.match(context, /- modificado: app\.ts/);
  assert.match(context, /- nuevo: extra\.ts/);
  assert.match(context, /^\+export const titulo = "Hola desde feature";$/m);

  const log = readFileSync(join(repo, ".git", "agent-sync", "hook.log"), "utf8");
  assert.match(log, /cambio de rama main -> feature/);
});

test("después de Stop en la rama nueva, el aviso no se repite", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  git(repo, "checkout", "-q", "feature");
  parseContext(prompt(repo));
  parseContext(prompt(repo)); // sin Stop, se repite
  assertSilent(stop(repo));
  assertSilent(prompt(repo));
});

test("una rama nueva con el mismo contenido también se avisa", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  git(repo, "checkout", "-q", "-b", "copia");
  const context = parseContext(prompt(repo));
  assert.match(context, /`main` a `copia`/);
  assert.match(context, /quedaron idénticos/);
});

test("un commit en la misma rama no es un cambio de rama", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  writeFileSync(join(repo, "app.ts"), "export const titulo = 2;\n");
  git(repo, "commit", "-q", "-am", "cambio del usuario");
  const context = parseContext(prompt(repo));
  assert.doesNotMatch(context, /Cambio de rama/);
  assert.match(context, /por su cuenta/);
});

test("un checkout a un commit suelto (sin rama) se describe con el commit", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  const commit = git(repo, "rev-parse", "feature");
  git(repo, "checkout", "-q", "--detach", commit);
  const context = parseContext(prompt(repo));
  assert.match(context, new RegExp(`\`main\` a \`commit ${commit.slice(0, 7)} \\(sin rama\\)\``));
});

test("una foto de una versión anterior (sin rama guardada) no da error ni aviso", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  const path = join(repo, ".git", "agent-sync", "baseline.json");
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  delete baseline.branch;
  delete baseline.head;
  writeFileSync(path, JSON.stringify(baseline));

  git(repo, "checkout", "-q", "feature");
  const context = parseContext(prompt(repo));
  assert.doesNotMatch(context, /Cambio de rama/);
  assert.match(context, /- modificado: app\.ts/);
});

test("la foto guarda la rama y status la muestra", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  const baseline = JSON.parse(readFileSync(join(repo, ".git", "agent-sync", "baseline.json"), "utf8"));
  assert.equal(baseline.branch, "main");
  assert.equal(baseline.head, git(repo, "rev-parse", "HEAD"));
  assert.match(runCli(repo, ["status"]).stdout, /rama main/);
});

test("summary también avisa del cambio de rama", (t) => {
  const repo = makeRepo(t);
  runCli(repo, ["snapshot"]);
  git(repo, "checkout", "-q", "feature");
  assert.match(runCli(repo, ["summary"]).stdout, /Cambio de rama: .*`main` a `feature`/);
});
