#!/usr/bin/env node
// Punto de entrada manual: permite probar cada pieza desde la terminal, sin Codex.

import { readFileSync } from "node:fs";
import { detectBranchChange, recordSnapshot } from "./actions.js";
import { loadBaseline, logPath, readLog } from "./core/state.js";
import { DEFAULT_MAX_PATCH_CHARS, buildSummary } from "./core/summary.js";
import {
  type FileChange,
  NoSnapshotError,
  NotAGitRepoError,
  SNAPSHOT_REF,
  diffAgainstSnapshot,
  diffDetails,
  diffPatch,
  findRepo,
} from "./sources/git.js";
import { parseHookInput, readStdin } from "./hooks/input.js";
import { runStopHook } from "./hooks/on-stop.js";
import { runPromptHook } from "./hooks/on-prompt.js";
import { describeLastSession, runDiagnosticServer } from "./proxy/diagnostic.js";
import { describeNotes, runNotesServer } from "./toy/notes-app.js";
import { parseProxyArgs, runProxy } from "./proxy/proxy.js";
import { readRegistry, registryPath } from "./proxy/registry.js";
import { DEFAULT_MAX_TOTAL_CHARS } from "./core/summary.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const HELP = `agent-sync ${pkg.version}

Uso:
  agent-sync snapshot        Toma la foto del estado actual de tus archivos
  agent-sync diff            Lista los archivos que cambiaron desde la foto
  agent-sync diff --patch    Muestra además el detalle línea por línea
  agent-sync summary         Muestra el resumen que recibiría el agente
      --max-chars <n>        Límite de caracteres de detalle (por defecto ${DEFAULT_MAX_PATCH_CHARS})
  agent-sync status          Muestra la última foto y las últimas ejecuciones del hook
  agent-sync hook stop       Hook "Stop" de Codex (lo ejecuta Codex, no tú)
  agent-sync hook prompt     Hook "UserPromptSubmit" de Codex; ejecutado a mano,
                             muestra exactamente lo que recibiría Codex
      --limit <n>            Tamaño máximo del resumen (por defecto ${DEFAULT_MAX_TOTAL_CHARS} caracteres)
  agent-sync diagnostico-mcp Servidor MCP de prueba (fase 2, paso 0): lo arranca
                             Codex y anota cómo lo lanzó
      --mostrar              Muestra lo que anotó la última vez
  agent-sync notas-juguete   App de juguete (fase 2, paso 1): servidor MCP de notas
                             guardadas en ~/.agent-sync/notas-juguete.json
      --mostrar              Muestra el archivo de notas y su contenido
  agent-sync proxy -- <comando> [args...]
                             Proxy MCP (fase 2, paso 2): arranca el servidor MCP real
                             y reenvía los mensajes entre Codex y él, sin cambiarlos;
                             anota lo que el agente modifica en la app
  agent-sync registro        Muestra lo que el agente modificó en apps externas
                             a través del proxy, en este proyecto
  agent-sync --version    Muestra la versión
  agent-sync --help          Muestra esta ayuda
`;

function snapshot(): number {
  const repo = findRepo(process.cwd());
  const shot = recordSnapshot(repo);

  console.log(`Foto guardada: ${shot.commit.slice(0, 7)} (${shot.files} archivos)`);
  console.log(`Referencia:    ${SNAPSHOT_REF}`);
  console.log(`Estado:        ${shot.statePath}`);
  return 0;
}

function status(): number {
  const repo = findRepo(process.cwd());
  const baseline = loadBaseline(repo.gitDir);

  if (baseline === null) {
    console.log("Todavía no hay una foto en este proyecto.");
  } else {
    const when = new Date(baseline.takenAt).toLocaleString();
    const branch = baseline.branch ? `, rama ${baseline.branch}` : "";
    console.log(`Última foto: ${baseline.commit.slice(0, 7)} (${baseline.files} archivos${branch}), ${when}`);
  }

  const log = readLog(repo.gitDir, 10);
  if (log.length === 0) {
    console.log("\nEl hook todavía no se ha ejecutado en este proyecto.");
  } else {
    console.log(`\nÚltimas ejecuciones del hook (${logPath(repo.gitDir)}):`);
    for (const line of log) console.log(`  ${line}`);
  }
  return 0;
}

/**
 * Hooks que ejecuta Codex. Nunca lanzan errores ni escriben en stdout por
 * su cuenta: cada hook decide exactamente qué devolver a Codex.
 */
function hook(options: string[]): number {
  const name = options[0];
  if (name !== "stop" && name !== "prompt") {
    console.error(`Hook desconocido: ${name ?? "(ninguno)"}. Disponibles: stop, prompt`);
    return 1;
  }

  // Red de seguridad: pase lo que pase, un hook nunca interrumpe a Codex.
  try {
    const input = parseHookInput(readStdin());
    if (name === "stop") return runStopHook(input);

    // Un --limit inválido no debe romper el prompt: se usa el valor por defecto.
    const flag = options.indexOf("--limit");
    const parsed = flag === -1 ? NaN : Number(options[flag + 1]);
    const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOTAL_CHARS;
    const result = runPromptHook(input, limit);
    if (result.stdout !== "") process.stdout.write(result.stdout + "\n");
    return result.exitCode;
  } catch {
    return 0;
  }
}

const LABELS: Record<FileChange["kind"], string> = {
  added: "nuevo     ",
  modified: "modificado",
  deleted: "eliminado ",
  renamed: "renombrado",
};

function describe(change: FileChange): string {
  const target = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
  return `  ${LABELS[change.kind]}  ${target}`;
}

function diff(options: string[]): number {
  const repo = findRepo(process.cwd());
  const result = diffAgainstSnapshot(repo);
  const baseline = loadBaseline(repo.gitDir);
  const when = baseline ? ` del ${new Date(baseline.takenAt).toLocaleString()}` : "";

  if (result.changes.length === 0) {
    console.log(`Sin cambios desde la foto${when} (${result.snapshotCommit.slice(0, 7)}).`);
    return 0;
  }

  console.log(`Cambios desde la foto${when} (${result.snapshotCommit.slice(0, 7)}):\n`);
  for (const change of result.changes) console.log(describe(change));
  const total = result.changes.length;
  console.log(`\n${total} ${total === 1 ? "archivo cambió" : "archivos cambiaron"}.`);

  if (options.includes("--patch")) {
    console.log(`\n${diffPatch(repo, result)}`);
  }
  return 0;
}

function summary(options: string[]): number {
  const repo = findRepo(process.cwd());
  const result = diffAgainstSnapshot(repo);
  const baseline = loadBaseline(repo.gitDir);

  let maxPatchChars: number | undefined;
  const flag = options.indexOf("--max-chars");
  if (flag !== -1) {
    maxPatchChars = Number(options[flag + 1]);
    if (!Number.isInteger(maxPatchChars) || maxPatchChars < 0) {
      console.error("--max-chars necesita un número entero mayor o igual a 0.");
      return 1;
    }
  }

  const text = buildSummary(diffDetails(repo, result), {
    takenAt: baseline?.takenAt,
    branchChange: detectBranchChange(repo, baseline),
    maxPatchChars,
  });

  if (text === null) {
    console.log("Sin cambios desde la foto: el agente no recibiría ningún resumen.");
    return 0;
  }
  console.log(text);
  return 0;
}

/** Cuántas escrituras muestra `agent-sync registro`. */
const REGISTRY_SHOWN = 20;

function registry(): number {
  const repo = findRepo(process.cwd());
  const entries = readRegistry(repo.gitDir);
  if (entries.length === 0) {
    console.log("El agente todavía no ha modificado nada en apps externas a través del proxy.");
    return 0;
  }

  const shown = entries.slice(-REGISTRY_SHOWN);
  const reasons: Record<string, string> = {
    anotacion: "",
    sin_anotacion: " (sin anotación: se asume que modifica)",
    desconocida: " (herramienta desconocida)",
  };
  console.log(`Escrituras del agente en apps externas (${registryPath(repo.gitDir)}):\n`);
  for (const entry of shown) {
    const when = new Date(entry.fecha).toLocaleString();
    console.log(`  ${when}  ${entry.servidor}  ${entry.herramienta} ${JSON.stringify(entry.argumentos)}${reasons[entry.motivo] ?? ""}`);
  }
  if (entries.length > shown.length) console.log(`\n(se muestran las últimas ${shown.length} de ${entries.length})`);
  return 0;
}

function main(args: string[]): number {
  const [command, ...options] = args;

  try {
    switch (command) {
      case "snapshot":
        return snapshot();
      case "diff":
        return diff(options);
      case "summary":
        return summary(options);
      case "status":
        return status();
      case "hook":
        return hook(options);
      case "diagnostico-mcp":
        if (options.includes("--mostrar")) {
          console.log(describeLastSession());
          return 0;
        }
        runDiagnosticServer(pkg.version); // sigue atendiendo hasta que Codex cierre stdin
        return 0;
      case "notas-juguete":
        if (options.includes("--mostrar")) {
          console.log(describeNotes());
          return 0;
        }
        runNotesServer(pkg.version);
        return 0;
      case "proxy": {
        const target = parseProxyArgs(options);
        if (target === null) {
          console.error("Falta el comando del servidor MCP real.");
          console.error("Uso: agent-sync proxy -- <comando> [args...]");
          return 1;
        }
        // Si arranca, el código de salida lo fija el servidor real al terminar.
        return runProxy(target) ? 0 : 1;
      }
      case "registro":
        return registry();
      case "--version":
      case "-v":
        console.log(pkg.version);
        return 0;
      case undefined:
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      default:
        console.error(`Comando desconocido: ${command}\n`);
        console.error(HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof NotAGitRepoError) {
      console.error(error.message);
      console.error("Ejecuta agent-sync dentro de un proyecto con git (o usa `git init`).");
      return 1;
    }
    if (error instanceof NoSnapshotError) {
      console.error(error.message);
      console.error("Ejecuta primero `agent-sync snapshot`.");
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
