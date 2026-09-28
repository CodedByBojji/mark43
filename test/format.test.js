// Pruebas de la detección de cambios de "solo formato".
// La prueba principal reproduce el escenario real que encontramos: 70
// archivos reformateados, y uno de ellos con un cambio de lógica escondido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { isFormatOnlyChange, normalizeForFormat, canBeFormatOnly } = await import(
  new URL("../dist/core/format.js", import.meta.url)
);
const { buildSummary } = await import(new URL("../dist/core/summary.js", import.meta.url));

// --- Lógica pura -------------------------------------------------------------------

test("reconoce los cambios típicos de un formateador", () => {
  const cases = [
    ["espacios y saltos de línea", "function f( a,b ){return a+b}\n", "function f(a, b) {\n  return a + b;\n}\n"],
    ["comillas", "const s = 'hola'\n", 'const s = "hola"\n'],
    ["punto y coma", "const a = 1\n", "const a = 1;\n"],
    ["comas finales", "const o = { a: 1, b: 2, }\n", "const o = { a: 1, b: 2 }\n"],
    ["tabulaciones a espacios", "if (x) {\n\treturn 1\n}\n", "if (x) {\n  return 1\n}\n"],
    ["CSS", ".a{color:red}\n", ".a {\n  color: red;\n}\n"],
    ["JSON", '{"a":1,"b":[1,2]}\n', '{\n  "a": 1,\n  "b": [1, 2]\n}\n'],
  ];
  for (const [label, before, after] of cases) {
    assert.equal(isFormatOnlyChange("archivo.js", before, after), true, label);
  }
});

test("cualquier cambio de contenido NO es solo formato", () => {
  const cases = [
    ["número distinto", "const valor = 45\n", "const valor = 46\n"],
    ["línea agregada", "const a = 1\n", 'const a = 1\nconsole.log("xd")\n'],
    ["nombre distinto", "function mostrar() {}\n", "function ocultar() {}\n"],
    ["texto distinto", 'const t = "Hola"\n', 'const t = "Adiós"\n'],
    ["coma que no es final", "f(a, b)\n", "f(a b)\n"],
    ["operador distinto", "a + b\n", "a - b\n"],
  ];
  for (const [label, before, after] of cases) {
    assert.equal(isFormatOnlyChange("archivo.js", before, after), false, label);
  }
});

test("sin cambios no es 'cambio de formato'", () => {
  assert.equal(isFormatOnlyChange("a.js", "x\n", "x\n"), false);
});

test("en Python y YAML la sangría importa: nunca se asume solo formato", () => {
  const before = "if x:\n    a()\n    b()\n";
  const after = "if x:\n    a()\nb()\n"; // b() salió del if: cambia la lógica
  assert.equal(normalizeForFormat(before), normalizeForFormat(after)); // parecen iguales...
  assert.equal(isFormatOnlyChange("script.py", before, after), false); // ...pero no se asume
  for (const path of ["a.py", "config.yaml", "ci.yml", "Makefile", "estilos.sass"]) {
    assert.equal(canBeFormatOnly(path), false, path);
  }
  for (const path of ["a.js", "a.ts", "a.css", "a.json", "a.java", "a.go"]) {
    assert.equal(canBeFormatOnly(path), true, path);
  }
});

test("el resumen separa contenido de formato, sin repetir nombres", () => {
  const formatted = Array.from({ length: 30 }, (_, i) => ({
    kind: "modified", path: `src/f${i + 1}.js`, added: 5, deleted: 3, binary: false,
    patch: `diff --git a/src/f${i + 1}.js b/src/f${i + 1}.js\n+formato`, formatOnly: true,
  }));
  const real = {
    kind: "modified", path: "src/f15.js", added: 6, deleted: 3, binary: false,
    patch: 'diff --git a/src/f15.js b/src/f15.js\n+console.log("xd")', formatOnly: false,
  };
  const text = buildSummary([...formatted.filter((c) => c.path !== "src/f15.js"), real]);

  assert.match(text, /Cambios de contenido \(1\):\n- modificado: src\/f15\.js \(\+6 -3\)/);
  assert.match(text, /Solo formato \(29\):/);
  assert.match(text, /No afectan el comportamiento/);
  assert.match(text, /console\.log\("xd"\)/);
  assert.doesNotMatch(text, /\+formato/); // los diffs de formato no se incluyen
  // Los de formato se nombran una sola vez, y solo los primeros 10.
  assert.equal(text.match(/src\/f1\.js/g).length, 1);
  assert.match(text, /src\/f1\.js, src\/f2\.js, .* y 19 más/);
});

test("ordena los archivos en orden natural", () => {
  const change = (path) => ({ kind: "added", path, added: 1, binary: false, patch: "" });
  const text = buildSummary([change("c10.js"), change("c2.js"), change("c1.js")]);
  assert.ok(text.indexOf("c1.js") < text.indexOf("c2.js"));
  assert.ok(text.indexOf("c2.js") < text.indexOf("c10.js"));
});

test("si todo es formato, no aparece la sección de contenido", () => {
  const text = buildSummary([
    { kind: "modified", path: "a.js", added: 2, deleted: 1, binary: false, patch: "x", formatOnly: true },
  ]);
  assert.doesNotMatch(text, /Cambios de contenido/);
  assert.match(text, /Solo formato \(1\):.*\n- a\.js$/m);
});

// --- Integración con git: el escenario real ------------------------------------------

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

function hookPrompt(cwd) {
  const result = spawnSync("node", [cli, "hook", "prompt"], {
    cwd, encoding: "utf8", input: JSON.stringify({ cwd, hook_event_name: "UserPromptSubmit" }),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-sync-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Prueba");
  git(dir, "config", "user.email", "prueba@example.com");
  return dir;
}

/** Lo que generó generar.js: código sin formato. */
const messy = (i) =>
  `const   dato${i}={nombre:'Componente ${i}',valor:${i}}\n` +
  `function mostrar${i}( x ){return x.nombre+' '+x.valor}\n` +
  `module.exports={dato${i},mostrar${i}}\n`;

/** Lo que deja Prettier. */
const pretty = (i) =>
  `const dato${i} = { nombre: "Componente ${i}", valor: ${i} };\n` +
  `function mostrar${i}(x) {\n  return x.nombre + " " + x.valor;\n}\n` +
  `module.exports = { dato${i}, mostrar${i} };\n`;

function setupComponents(t, total) {
  const repo = makeRepo(t);
  mkdirSync(join(repo, "src"));
  for (let i = 1; i <= total; i++) writeFileSync(join(repo, "src", `componente${i}.js`), messy(i));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "sin formato");
  spawnSync("node", [cli, "snapshot"], { cwd: repo });
  for (let i = 1; i <= total; i++) writeFileSync(join(repo, "src", `componente${i}.js`), pretty(i));
  return repo;
}

test("ESCENARIO REAL: el cambio escondido entre 70 archivos formateados llega al agente", (t) => {
  const repo = setupComponents(t, 70);
  appendFileSync(join(repo, "src", "componente50.js"), 'console.log("xd");\n');

  const context = hookPrompt(repo);
  assert.ok(context.length <= 6000, `mide ${context.length}`);

  // El cambio real aparece primero, con su detalle completo.
  assert.match(context, /Cambios de contenido \(1\):\n- modificado: src\/componente50\.js \(\+6 -3\)\n/);
  assert.match(context, /^\+console\.log\("xd"\);$/m);
  assert.doesNotMatch(context, /sin detalle/);

  // Los otros 69 se agrupan como solo formato, sin su diff.
  assert.match(context, /Solo formato \(69\):/);
  assert.match(context, /y 59 más/);
  assert.doesNotMatch(context, /diff --git a\/src\/componente1\.js/);
});

test("un número cambiado entre archivos formateados también se detecta", (t) => {
  const repo = setupComponents(t, 20);
  writeFileSync(join(repo, "src", "componente7.js"), pretty(7).replace("valor: 7", "valor: 700"));

  const context = hookPrompt(repo);
  assert.match(context, /Cambios de contenido \(1\):\n- modificado: src\/componente7\.js/);
  assert.match(context, /^\+const dato7 = \{ nombre: "Componente 7", valor: 700 \};$/m);
  assert.match(context, /Solo formato \(19\):/);
});

test("archivos distintos reformateados se reconocen todos como formato", (t) => {
  const repo = makeRepo(t);
  writeFileSync(join(repo, "sumar.js"), "function sumar( a,b ){return a+b}\n");
  writeFileSync(join(repo, "usuario.js"), "const user={name:'Ana'}\n");
  writeFileSync(join(repo, "estilos.css"), ".boton{color:red;padding:4px}\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "inicial");
  spawnSync("node", [cli, "snapshot"], { cwd: repo });

  writeFileSync(join(repo, "sumar.js"), "function sumar(a, b) {\n  return a + b;\n}\n");
  writeFileSync(join(repo, "usuario.js"), 'const user = { name: "Ana" };\n');
  writeFileSync(join(repo, "estilos.css"), ".boton {\n  color: red;\n  padding: 4px;\n}\n");

  const context = hookPrompt(repo);
  assert.doesNotMatch(context, /Cambios de contenido/);
  assert.match(context, /Solo formato \(3\):.*\n- estilos\.css, sumar\.js, usuario\.js$/m);
});

test("un archivo renombrado y reformateado sigue apareciendo como renombre", (t) => {
  const repo = makeRepo(t);
  // Varias líneas: git reconoce un renombre si se conserva la mayor parte del contenido.
  const body = [
    "export function calcularTotalDelCarrito(items) { return items.length }",
    "export function vaciarCarrito(carrito) {",
    "  carrito.items = [];",
    "  carrito.total = 0;",
    "  return carrito;",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(repo, "carrito.js"), body);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "inicial");
  spawnSync("node", [cli, "snapshot"], { cwd: repo });

  renameSync(join(repo, "carrito.js"), join(repo, "cesta.js"));
  writeFileSync(join(repo, "cesta.js"), body.replace("{ return", "{\n  return"));

  const context = hookPrompt(repo);
  assert.match(context, /- renombrado: carrito\.js -> cesta\.js/);
  assert.doesNotMatch(context, /Solo formato/);
});
