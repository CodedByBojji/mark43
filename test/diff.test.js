// Pruebas del paso 2: `agent-sync diff`.
// Cada prueba crea un repositorio temporal, toma la foto y luego hace
// cambios "a mano", como lo haría el usuario fuera del agente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { parseNameStatus } = await import(new URL("../dist/sources/git.js", import.meta.url));
const REF = "refs/agent-sync/last";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

function runCli(cwd, ...args) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
}

/** Repo con commit inicial y una foto ya tomada. */
function makeRepoWithSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Prueba");
  git(dir, "config", "user.email", "prueba@example.com");
  writeFileSync(join(dir, ".gitignore"), "secreto.txt\n");
  writeFileSync(join(dir, "hero.txt"), "Diseña más rápido\n");
  writeFileSync(join(dir, "pricing.txt"), "Plan básico\nPlan pro\nPlan empresa\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "inicial");
  const shot = runCli(dir, "snapshot");
  assert.equal(shot.status, 0, shot.stderr);
  return dir;
}

function setup(t) {
  const dir = makeRepoWithSnapshot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("sin cambios, lo dice claramente", (t) => {
  const dir = setup(t);
  const result = runCli(dir, "diff");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Sin cambios desde la foto/);
});

test("detecta un archivo modificado", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "hero.txt"), "Diseña sin límites\n");
  const result = runCli(dir, "diff");
  assert.match(result.stdout, /modificado\s+hero\.txt/);
  assert.match(result.stdout, /1 archivo cambió/);
});

test("detecta un archivo nuevo aunque no lo hayas agregado con git add", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "testimonios.txt"), "Excelente\n");
  assert.match(runCli(dir, "diff").stdout, /nuevo\s+testimonios\.txt/);
});

test("detecta un archivo eliminado", (t) => {
  const dir = setup(t);
  unlinkSync(join(dir, "pricing.txt"));
  assert.match(runCli(dir, "diff").stdout, /eliminado\s+pricing\.txt/);
});

test("detecta un archivo renombrado", (t) => {
  const dir = setup(t);
  renameSync(join(dir, "pricing.txt"), join(dir, "precios.txt"));
  assert.match(runCli(dir, "diff").stdout, /renombrado\s+pricing\.txt → precios\.txt/);
});

test("ignora los archivos de .gitignore", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "secreto.txt"), "no debe aparecer\n");
  const result = runCli(dir, "diff");
  assert.match(result.stdout, /Sin cambios/);
  assert.doesNotMatch(result.stdout, /secreto/);
});

test("detecta varios cambios a la vez", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "hero.txt"), "Otro título\n");
  writeFileSync(join(dir, "nuevo.txt"), "hola\n");
  unlinkSync(join(dir, "pricing.txt"));
  assert.match(runCli(dir, "diff").stdout, /3 archivos cambiaron/);
});

test("detecta cambios aunque ya los hayas commiteado", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "hero.txt"), "Cambio commiteado\n");
  git(dir, "commit", "-q", "-am", "cambio del usuario");
  assert.match(runCli(dir, "diff").stdout, /modificado\s+hero\.txt/);
});

test("--patch muestra el detalle línea por línea", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "hero.txt"), "Diseña sin límites\n");
  const out = runCli(dir, "diff", "--patch").stdout;
  assert.match(out, /^-Diseña más rápido$/m);
  assert.match(out, /^\+Diseña sin límites$/m);
});

test("después de una nueva foto, ya no hay cambios", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "hero.txt"), "Diseña sin límites\n");
  runCli(dir, "snapshot");
  assert.match(runCli(dir, "diff").stdout, /Sin cambios/);
});

test("diff no altera historial, staging, archivos ni la foto", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "hero.txt"), "Diseña sin límites\n");
  writeFileSync(join(dir, "nuevo.txt"), "hola\n");

  const snapshotState = () => ({
    head: git(dir, "rev-parse", "HEAD"),
    log: git(dir, "log", "--oneline"),
    status: git(dir, "status", "--porcelain"),
    staged: git(dir, "diff", "--cached", "--name-only"),
    hero: readFileSync(join(dir, "hero.txt"), "utf8"),
    snapshot: git(dir, "rev-parse", REF),
  });

  const before = snapshotState();
  runCli(dir, "diff", "--patch");
  assert.deepEqual(snapshotState(), before);
});

test("sin foto previa, explica qué hacer", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");

  const result = runCli(dir, "diff");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent-sync snapshot/);
});

test("parseNameStatus soporta nombres con espacios y acentos", () => {
  const output = "M\0mi archivo.txt\0R100\0viejo nombre.txt\0nuevo nombre.txt\0A\0canción.txt\0";
  assert.deepEqual(parseNameStatus(output), [
    { kind: "modified", path: "mi archivo.txt" },
    { kind: "renamed", path: "nuevo nombre.txt", oldPath: "viejo nombre.txt" },
    { kind: "added", path: "canción.txt" },
  ]);
});
