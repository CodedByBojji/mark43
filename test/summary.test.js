// Pruebas del paso 3: el resumen para el agente.
// La primera parte prueba buildSummary con datos inventados (sin git).
// La segunda prueba el comando `agent-sync summary` con repositorios reales.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { buildSummary, isSensitive } = await import(
  new URL("../dist/core/summary.js", import.meta.url)
);
const { parseNumstat, splitPatch } = await import(
  new URL("../dist/sources/git.js", import.meta.url)
);

const heroPatch = [
  "diff --git a/Hero.tsx b/Hero.tsx",
  "--- a/Hero.tsx",
  "+++ b/Hero.tsx",
  "@@ -1 +1 @@",
  "-<h1>Diseña más rápido</h1>",
  "+<h1>Diseña sin límites</h1>",
].join("\n");

const modified = (path, patch = heroPatch) => ({
  kind: "modified", path, added: 1, deleted: 1, binary: false, patch,
});

// --- buildSummary: lógica pura ------------------------------------------------

test("sin cambios devuelve null (el hook no agrega nada)", () => {
  assert.equal(buildSummary([]), null);
});

test("incluye la instrucción de respetar los cambios", () => {
  const text = buildSummary([modified("Hero.tsx")], { takenAt: "2026-09-26T20:35:34Z" });
  assert.match(text, /^<cambios_externos>/);
  assert.match(text, /<\/cambios_externos>$/);
  assert.match(text, /2026-09-26T20:35:34Z/);
  assert.match(text, /no los reviertas/);
  assert.match(text, /vuelve a leerlo/);
});

test("lista cada tipo de cambio con sus líneas", () => {
  const text = buildSummary([
    modified("Hero.tsx"),
    { kind: "added", path: "Testimonios.tsx", added: 12, deleted: 0, binary: false, patch: "diff --git a/T b/T\n+x" },
    { kind: "deleted", path: "viejo.txt", added: 0, deleted: 5, binary: false, patch: "diff --git a/v b/v\n-contenido viejo" },
    { kind: "renamed", path: "precios.tsx", oldPath: "pricing.tsx", added: 0, deleted: 0, binary: false, patch: "" },
    { kind: "modified", path: "logo.png", binary: true, patch: "Binary files differ" },
  ]);
  assert.match(text, /Cambios de contenido \(5\):/);
  assert.match(text, /- modificado: Hero\.tsx \(\+1 -1\)/);
  assert.match(text, /- nuevo: Testimonios\.tsx \(\+12\)/);
  assert.match(text, /- eliminado: viejo\.txt$/m);
  assert.match(text, /- renombrado: pricing\.tsx -> precios\.tsx$/m);
  assert.match(text, /- modificado: logo\.png \(binario\)/);
});

test("incluye el diff, pero no el contenido de archivos eliminados ni binarios", () => {
  const text = buildSummary([
    modified("Hero.tsx"),
    { kind: "deleted", path: "viejo.txt", binary: false, patch: "diff --git a/v b/v\n-contenido viejo" },
    { kind: "modified", path: "logo.png", binary: true, patch: "Binary files differ" },
  ]);
  assert.match(text, /```diff\n[\s\S]*\+<h1>Diseña sin límites<\/h1>[\s\S]*```/);
  assert.doesNotMatch(text, /contenido viejo/);
  assert.doesNotMatch(text, /Binary files differ/);
});

test("nunca incluye el contenido de archivos sensibles", () => {
  const text = buildSummary([
    { kind: "modified", path: ".env", added: 1, deleted: 1, binary: false, patch: "diff --git a/.env b/.env\n+API_KEY=secreta123" },
  ]);
  assert.match(text, /- modificado: \.env/);
  assert.match(text, /posible información sensible: \.env/);
  assert.doesNotMatch(text, /secreta123/);
});

test("reconoce archivos sensibles comunes", () => {
  for (const path of [".env", "config/.env.local", "certs/server.pem", "deploy.key", "id_rsa"]) {
    assert.equal(isSensitive(path), true, path);
  }
  for (const path of ["Hero.tsx", "environment.ts", "README.md", "keyboard.js"]) {
    assert.equal(isSensitive(path), false, path);
  }
});

test("respeta el límite de caracteres de detalle", () => {
  const big = "diff --git a/big.json b/big.json\n" + "+x\n".repeat(500);
  const text = buildSummary([modified("Hero.tsx"), modified("big.json", big)], {
    maxPatchChars: heroPatch.length + 10,
  });
  assert.match(text, /Diseña sin límites/); // el pequeño sí cabe
  assert.doesNotMatch(text, /\+x\n\+x/); // el grande no
  assert.match(text, /- modificado: big\.json \(\+1 -1, sin detalle\)/);
  assert.match(text, /no cupieron por tamaño/);
});

test("con límite 0 lista los archivos sin ningún diff", () => {
  const text = buildSummary([modified("Hero.tsx")], { maxPatchChars: 0 });
  assert.match(text, /- modificado: Hero\.tsx/);
  assert.doesNotMatch(text, /```diff/);
});

test("con muchos archivos lista los primeros y dice cuántos faltan", () => {
  const many = Array.from({ length: 8 }, (_, i) => modified(`f${i}.ts`, ""));
  const text = buildSummary(many, { maxFiles: 5 });
  assert.match(text, /Cambios de contenido \(8\):/);
  assert.match(text, /- modificado: f4\.ts/);
  assert.doesNotMatch(text, /- modificado: f5\.ts/);
  assert.match(text, /y 3 archivos más/);
});

// --- Utilidades de git ----------------------------------------------------------

test("parseNumstat entiende archivos normales, renombrados y binarios", () => {
  const output = "3\t1\tHero.tsx\0" + "0\t0\t\0viejo nombre.txt\0nuevo nombre.txt\0" + "-\t-\tlogo.png\0";
  const stats = parseNumstat(output);
  assert.deepEqual(stats.get("Hero.tsx"), { binary: false, added: 3, deleted: 1 });
  assert.deepEqual(stats.get("nuevo nombre.txt"), { binary: false, added: 0, deleted: 0 });
  assert.deepEqual(stats.get("logo.png"), { binary: true });
});

test("splitPatch separa un diff en un fragmento por archivo", () => {
  const chunks = splitPatch(`${heroPatch}\ndiff --git a/B b/B\n+b\n`);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith("diff --git a/Hero.tsx"));
  assert.equal(chunks[1], "diff --git a/B b/B\n+b");
  assert.deepEqual(splitPatch(""), []);
});

// --- Integración: `agent-sync summary` con repositorios reales ------------------

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

function runCli(cwd, ...args) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Prueba");
  git(dir, "config", "user.email", "prueba@example.com");
  writeFileSync(join(dir, "Hero.tsx"), "<h1>Diseña más rápido</h1>\n");
  writeFileSync(join(dir, "pricing.tsx"), "export const Pricing = 1;\n");
  writeFileSync(join(dir, "viejo.txt"), "adiós\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "inicial");
  assert.equal(runCli(dir, "snapshot").status, 0);
  return dir;
}

test("summary sin cambios lo indica y no genera resumen", (t) => {
  const dir = setup(t);
  const result = runCli(dir, "summary");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /el agente no recibiría ningún resumen/);
  assert.doesNotMatch(result.stdout, /<cambios_externos>/);
});

test("summary describe el escenario de la diseñadora", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, "Hero.tsx"), "<h1>Diseña sin límites</h1>\n");
  writeFileSync(join(dir, "Testimonios.tsx"), "export const T = 1;\nexport const U = 2;\n");
  unlinkSync(join(dir, "viejo.txt"));
  renameSync(join(dir, "pricing.tsx"), join(dir, "precios.tsx"));

  const result = runCli(dir, "summary");
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /Cambios de contenido \(4\):/);
  assert.match(out, /- modificado: Hero\.tsx \(\+1 -1\)/);
  assert.match(out, /- nuevo: Testimonios\.tsx \(\+2\)/);
  assert.match(out, /- eliminado: viejo\.txt/);
  assert.match(out, /- renombrado: pricing\.tsx -> precios\.tsx/);
  assert.match(out, /^\+<h1>Diseña sin límites<\/h1>$/m);
  assert.doesNotMatch(out, /adiós/); // contenido del archivo eliminado
});

test("summary protege un .env que git sí sigue", (t) => {
  const dir = setup(t);
  writeFileSync(join(dir, ".env"), "API_KEY=secreta123\n");
  const out = runCli(dir, "summary").stdout;
  assert.match(out, /- nuevo: \.env/);
  assert.doesNotMatch(out, /secreta123/);
});

test("summary --max-chars valida el valor", (t) => {
  const dir = setup(t);
  const result = runCli(dir, "summary", "--max-chars", "mucho");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /número entero/);
});
