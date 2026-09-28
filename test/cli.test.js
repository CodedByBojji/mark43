// Pruebas automáticas del comando. Se ejecutan con: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("--version muestra la versión del package.json", () => {
  const out = execFileSync("node", [cli, "--version"], { encoding: "utf8" });
  assert.equal(out.trim(), pkg.version);
});

test("--help muestra la ayuda", () => {
  const out = execFileSync("node", [cli, "--help"], { encoding: "utf8" });
  assert.match(out, /Uso:/);
});

test("un comando desconocido termina con error", () => {
  const result = spawnSync("node", [cli, "inventado"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Comando desconocido/);
});
