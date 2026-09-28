# agent-sync

Un agente de IA como Codex solo recuerda lo que él mismo hizo, no cómo están
las cosas ahora. Si cambias a mano algo que el agente creó, no se entera: puede
sobrescribir tu trabajo o trabajar con datos viejos.

agent-sync resuelve eso. Cada vez que Codex termina una tarea, guarda una
"foto" del proyecto. Antes de tu siguiente prompt, compara esa foto con cómo
están las cosas y le entrega a Codex un resumen de lo que cambiaste tú.

```
Codex termina una tarea ──► agent-sync guarda la foto
tú editas algo a mano      (nada todavía)
envías un prompt ─────────► agent-sync compara con la foto
                              ├─ sin cambios ► no agrega nada
                              └─ con cambios ► Codex recibe el resumen
```

## Estado

| Parte | Estado | Dónde |
|---|---|---|
| **Fase 1:** archivos del proyecto (con git) | Estable, v0.3.0, verificada con Codex | rama `main`, etiqueta `v0.3.0` |
| **Fase 2:** apps externas (Figma, calendario...) a través de un proxy MCP | En construcción, paso 3 de 9 terminado | rama `fase-2` |

La fase 2 es experimental. Si solo quieres usar agent-sync, instálalo desde
`main`.

## Requisitos

- Node.js 20 o superior (`node --version`)
- git
- Codex CLI (probado con la versión 0.157.1)

## Instalación

**1. Compilar y probar.** Desde la carpeta de agent-sync:

```bash
npm install
npm test
```

Deben pasar todas las pruebas (126 en la rama `fase-2`).

**2. Crear el comando global `agent-sync`:**

```bash
npm link
```

Compruébalo desde cualquier carpeta con `agent-sync --version`. Para
deshacerlo: `npm unlink -g agent-sync`.

`npm link` apunta a esta carpeta: el comando global ejecuta lo último que se
compiló aquí (con `npm test` o `npm run build`), sea de la rama que sea.

**3. Conectar los hooks de Codex.** Copia
[`examples/codex-hooks.json`](examples/codex-hooks.json) a
`~/.codex/hooks.json` (en Windows, `C:\Users\<tu-usuario>\.codex\hooks.json`).
Así funciona en todos tus proyectos. Configura dos hooks:

- `Stop`: al terminar cada tarea, ejecuta `agent-sync hook stop` y guarda la foto.
- `UserPromptSubmit`: antes de cada prompt, ejecuta `agent-sync hook prompt`
  y entrega el resumen.

**4. Aprobar los hooks.** Abre Codex, escribe `/hooks` y aprueba los de
agent-sync. Codex vuelve a pedirlo si el archivo cambia.

## Primeros pasos

En cualquier proyecto con git:

1. Abre Codex y pídele una tarea pequeña que modifique un archivo. Espera a
   que termine.
2. Comprueba que se guardó la foto:
   ```bash
   agent-sync status
   ```
   Debe mostrar una línea `stop    foto ...` con la hora reciente.
3. Edita a mano un archivo que Codex haya modificado.
4. Mira exactamente lo que recibirá Codex:
   ```bash
   agent-sync hook prompt
   ```
5. Pregúntale a Codex "¿qué cambió desde tu última tarea?". Debe describir
   tu cambio sin que se lo digas.

La primera vez en un proyecto no hay foto: el primer prompt la toma en
silencio y el aviso empieza a funcionar desde la siguiente tarea.

## Comandos

| Comando | Qué hace |
|---|---|
| `agent-sync snapshot` | Toma la foto a mano |
| `agent-sync diff [--patch]` | Lista qué cambió desde la foto (con `--patch`, línea por línea) |
| `agent-sync summary [--max-chars <n>]` | Muestra el resumen legible |
| `agent-sync hook prompt [--limit <n>]` | Muestra exactamente lo que recibiría Codex ahora |
| `agent-sync status` | Última foto, rama y últimas ejecuciones de los hooks |
| `agent-sync hook stop` | Lo ejecuta Codex al terminar una tarea |
| `agent-sync --version` / `--help` | Versión y ayuda |

Fase 2 (experimentales, solo en la rama `fase-2`):

| Comando | Qué hace |
|---|---|
| `agent-sync proxy -- <comando> [args...]` | Proxy MCP: se pone entre Codex y un servidor MCP, reenvía los mensajes y anota lo que el agente modifica |
| `agent-sync registro` | Lo que el agente modificó en apps externas, en este proyecto |
| `agent-sync notas-juguete [--mostrar]` | App de juguete: servidor MCP de notas para pruebas |
| `agent-sync diagnostico-mcp [--mostrar]` | Servidor MCP que anota cómo lo arranca Codex |

## Qué recibe Codex

El resumen va dentro de `<cambios_externos>`, e incluye:

- una instrucción: los cambios son tuyos, no debe revertirlos y debe releer
  los archivos antes de editarlos;
- **cambios de contenido** primero, con su diff;
- **cambios de solo formato** agrupados en una línea, sin diff (espacios,
  comillas, punto y coma o comas finales, lo que cambian Prettier o Black);
- **cambio de rama**, si cambiaste de rama: se dice explícitamente y se le
  pide a Codex avisártelo al empezar su respuesta.

Codex muestra ese bloque en la conversación, así que puedes ver qué recibió.

## Cosas a tener en cuenta

**Qué detecta y qué no:**

- Detecta cambios en cualquier archivo del repositorio git donde abriste
  Codex: nuevos, modificados, eliminados y renombrados.
- No detecta archivos fuera del proyecto, carpetas sin git ni archivos que
  estén en `.gitignore`.
- **Solo detecta lo que cambias cuando Codex ya terminó.** Si editas mientras
  Codex trabaja, la foto de fin de tarea incluye tu cambio como si fuera de
  Codex.
- El aviso se repite en cada prompt hasta que Codex termine una tarea. Así no
  se pierde si interrumpes una tarea.

**Seguridad:**

- Nunca modifica tu historial, tus ramas ni tu staging. La foto es un commit
  oculto en `refs/agent-sync/last`, y solo se ve con `git log --all`.
- El estado vive en `.git/agent-sync/`, nunca en las carpetas de tu proyecto.
- Nunca envía el contenido de archivos sensibles (`.env`, `.env.*`, `.pem`,
  `.key`, `id_rsa`, `.npmrc`...): solo menciona que cambiaron.
- Los hooks nunca bloquean tu prompt ni hacen que Codex siga trabajando. Si
  algo falla, se anota en `.git/agent-sync/hook.log` (`agent-sync status`).

**Tamaño:** el resumen no pasa de 6000 caracteres, porque Codex recorta el
contexto de un hook que supera unos 2500 tokens. Lo que no cabe se marca
"sin detalle". Para cambiar el límite: `agent-sync hook prompt --limit 4000`
en `hooks.json`.

**Qué recibió Codex de verdad:** no confíes en lo que Codex dice que
recibió; a veces reconstruye explicaciones creíbles. La fuente confiable es
`agent-sync hook prompt`.

**Configuración:**

- Si tienes los hooks en `~/.codex/hooks.json` **y** en `.codex/hooks.json`
  del proyecto, se ejecutan ambos y el resumen llega duplicado. Usa solo uno.
- En Windows, si Codex no encuentra `agent-sync`, agrega al hook
  `"commandWindows": "node C:\\ruta\\a\\agent-sync\\dist\\cli.js hook stop"`
  (y lo mismo con `hook prompt`).
- En Windows con fnm, Git Bash necesita `eval "$(fnm env --shell bash)"`
  antes de usar `node` o `npm`.

## Fase 2 (experimental): el proxy MCP

Las apps externas (Figma, un calendario...) no son archivos, así que git no
las ve. La idea de la fase 2 es un **proxy**: un intermediario entre Codex y
el servidor MCP de cada app, que anota qué modifica Codex en esas apps para
volver a revisarlo antes de tu siguiente prompt.

```
Codex  ◄──►  agent-sync proxy  ◄──►  servidor MCP de la app
```

Hoy el proxy reenvía los mensajes sin cambiarlos y anota lo que el agente
modifica en `.git/agent-sync/registro-apps.jsonl` del proyecto
(`agent-sync registro` para verlo). Todavía no vuelve a leer esas cosas ni
avisa a Codex: eso llega en los pasos 5 y 6. Para
probarlo sin cuentas ni internet existe una app de juguete de notas,
guardadas en `~/.agent-sync/notas-juguete.json`. Configuración en
`~/.codex/config.toml`, con rutas completas:

```toml
[mcp_servers.notas_juguete]
command = 'C:\Users\<tu-usuario>\AppData\Roaming\fnm\aliases\default\node.exe'
args = [
  'C:\ruta\a\agent-sync\dist\cli.js', 'proxy', '--',
  'C:\Users\<tu-usuario>\AppData\Roaming\fnm\aliases\default\node.exe',
  'C:\ruta\a\agent-sync\dist\cli.js', 'notas-juguete',
]
```

Antes de editar `config.toml`, guarda una copia. En Windows, el proxy no
arranca directamente comandos `.cmd` como `npx`: usa
`agent-sync proxy -- cmd.exe /c npx ...`.

El plan completo de la fase 2 está en [CLAUDE.md](CLAUDE.md), y el avance
paso a paso en [docs/desarrollo.md](docs/desarrollo.md).

## Volver a la versión estable

Si algo de la fase 2 falla, desde la carpeta de agent-sync:

```bash
git switch main
npm run build
```

`npm run build` es necesario: sin él, el comando global sigue ejecutando lo
último que se compiló. Luego quita del `config.toml` los servidores que pasan
por el proxy, o restaura tu copia.

## Arquitectura

```
src/
├── cli.ts              comandos manuales y punto de entrada de los hooks
├── actions.ts          acciones compartidas por el CLI y los hooks
├── hooks/
│   ├── input.ts        lee el JSON que Codex envía a cada hook
│   ├── on-stop.ts      hook Stop: actualiza la foto
│   └── on-prompt.ts    hook UserPromptSubmit: entrega el resumen
├── core/               lógica pura, sin git
│   ├── state.ts        .git/agent-sync/baseline.json y la bitácora hook.log
│   ├── summary.ts      arma el resumen para el agente
│   └── format.ts       distingue cambios de formato de cambios de contenido
├── sources/
│   └── git.ts          foto, comparación y detalle por archivo
├── proxy/              fase 2
│   ├── stdio.ts        conexión MCP por stdio (un mensaje JSON por línea)
│   ├── proxy.ts        el proxy: reenvía entre Codex y el servidor real
│   ├── recorder.ts     decide qué llamadas son escrituras
│   ├── registry.ts     registro de escrituras en .git/agent-sync/
│   └── diagnostic.ts   servidor que anota cómo lo arranca Codex
└── toy/
    └── notes-app.ts    app de juguete: servidor MCP de notas
test/                   pruebas con node:test (crean repos temporales)
examples/               configuración de ejemplo de los hooks
docs/desarrollo.md      bitácora de desarrollo, paso a paso
```

Principio: `core/` recibe datos y devuelve texto, sin saber de dónde vienen.
Así, los cambios que detecte el proxy en la fase 2 usarán el mismo resumen
que los archivos.

## Desarrollo

- `npm test` compila con TypeScript y corre todas las pruebas.
- Cada paso se construye con pruebas automáticas y se verifica a mano con
  Codex antes de seguir. El detalle está en
  [docs/desarrollo.md](docs/desarrollo.md).
- [CLAUDE.md](CLAUDE.md) resume el contexto completo para los agentes que
  trabajan en el proyecto: reglas, decisiones y pendientes.
