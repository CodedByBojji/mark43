// Pruebas del paso 1: `agent-sync snapshot`.
// Cada prueba crea un repositorio temporal y desechable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REF = "refs/agent-sync/last";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

function runCli(cwd, ...args) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
}

/** Repo con un commit, un archivo modificado, uno nuevo y uno ignorado. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Prueba");
  git(dir, "config", "user.email", "prueba@example.com");
  writeFileSync(join(dir, ".gitignore"), "secreto.txt\n");
  writeFileSync(join(dir, "hero.txt"), "Diseña más rápido\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "inicial");
  writeFileSync(join(dir, "hero.txt"), "Diseña sin límites\n"); // modificado
  writeFileSync(join(dir, "nuevo.txt"), "archivo sin agregar\n"); // nuevo
  writeFileSync(join(dir, "secreto.txt"), "no debe entrar\n"); // ignorado
  return dir;
}

test("snapshot guarda la foto en la referencia oculta", (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runCli(dir, "snapshot");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Foto guardada/);

  const files = git(dir, "ls-tree", "-r", "--name-only", REF).split("\n");
  assert.deepEqual(files.sort(), [".gitignore", "hero.txt", "nuevo.txt"]);
  assert.equal(git(dir, "show", `${REF}:hero.txt`), "Diseña sin límites");
});

test("snapshot no altera historial, ramas, staging ni archivos", (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const before = {
    head: git(dir, "rev-parse", "HEAD"),
    log: git(dir, "log", "--oneline"),
    branches: git(dir, "branch", "--list"),
    status: git(dir, "status", "--porcelain"),
    staged: git(dir, "diff", "--cached", "--name-only"),
    hero: readFileSync(join(dir, "hero.txt"), "utf8"),
  };

  assert.equal(runCli(dir, "snapshot").status, 0);

  assert.deepEqual(
    {
      head: git(dir, "rev-parse", "HEAD"),
      log: git(dir, "log", "--oneline"),
      branches: git(dir, "branch", "--list"),
      status: git(dir, "status", "--porcelain"),
      staged: git(dir, "diff", "--cached", "--name-only"),
      hero: readFileSync(join(dir, "hero.txt"), "utf8"),
    },
    before,
  );
});

test("snapshot guarda el estado dentro de .git, no en el proyecto", (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(runCli(dir, "snapshot").status, 0);

  const baseline = JSON.parse(
    readFileSync(join(dir, ".git", "agent-sync", "baseline.json"), "utf8"),
  );
  assert.equal(baseline.ref, REF);
  assert.equal(baseline.commit, git(dir, "rev-parse", REF));
  assert.equal(baseline.files, 3);
  assert.equal(existsSync(join(dir, ".agent-sync")), false);
});

test("snapshot funciona desde una subcarpeta del proyecto", (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.txt"), "hola\n");

  assert.equal(runCli(join(dir, "src"), "snapshot").status, 0);
  const files = git(dir, "ls-tree", "-r", "--name-only", REF).split("\n");
  assert.ok(files.includes("src/app.txt"));
  assert.ok(files.includes("hero.txt"));
});

test("snapshot funciona en un repositorio sin commits", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");

  const result = runCli(dir, "snapshot");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 archivos/);
});

test("una segunda foto reemplaza a la anterior", (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  runCli(dir, "snapshot");
  const first = git(dir, "rev-parse", REF);
  writeFileSync(join(dir, "hero.txt"), "Otro título\n");
  runCli(dir, "snapshot");

  assert.notEqual(git(dir, "rev-parse", REF), first);
  assert.equal(git(dir, "show", `${REF}:hero.txt`), "Otro título");
});

test("snapshot fuera de un repositorio explica el error", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runCli(dir, "snapshot");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no es un repositorio git/);
});
