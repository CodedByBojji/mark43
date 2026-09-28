# agent-sync — contexto del proyecto

Este archivo resume todo el contexto del proyecto para que cualquier sesión de
un agente (Claude Code, Codex...) pueda continuar el trabajo. Léelo completo
antes de proponer o hacer cambios.

Documento completo con el diseño, las decisiones y las pruebas:
https://claude.ai/code/artifact/15fdfc8b-193e-426d-bade-965b99bc72b5

## Qué es y qué problema resuelve

Un agente de IA (Codex, Claude Code) solo recuerda lo que él mismo hizo, no el
estado actual de las cosas. Si el usuario modifica por su cuenta algo que el
agente creó, el agente no se entera y puede sobrescribir ese trabajo o actuar
con datos viejos.

`agent-sync` cierra esa brecha: toma una "foto" de los archivos cada vez que
el agente termina una tarea y, antes de cada prompt del usuario, le entrega al
agente un resumen de lo que cambió desde entonces.

## Estado actual: v0.3.0, fase 1 completa

- Fase 1 (archivos locales con git): terminada, 87 pruebas automáticas,
  verificada con Codex real.
- v0.3.0: aviso explícito de cambio de rama (caso 6), verificado con Codex
  real el 2026-09-26.
- Fase 2 (apps externas vía proxy MCP): en la rama `fase-2`. Paso 0 terminado
  y verificado con Codex. Paso 1 (app de juguete `agent-sync notas-juguete`)
  terminado y verificado con Codex. Paso 2 (proxy transparente
  `agent-sync proxy -- <comando>`) terminado y verificado con Codex. Paso 3
  (registro de escrituras, `agent-sync registro`) terminado y verificado con
  Codex (126 pruebas; las entradas traen `turno` y `sesion`); siguiente:
  paso 4. Copia de la
  configuración: `~/.codex/config.toml.respaldo` (2026-09-26).
  El usuario no tiene proyectos reales para probar la fase 1 antes; a cambio
  se definió un plan de respaldo (ver "Fase 2: plan por pasos").

## Cómo trabajar con el usuario (importante)

- **Idioma:** español. El usuario está empezando en el tema: explica los
  conceptos técnicos en lenguaje simple, con ejemplos, sin jerga innecesaria.
- **Pasos pequeños y verificables.** Cada avance termina con pruebas
  automáticas que pasan y con instrucciones para que el usuario lo verifique a
  mano. No se avanza al siguiente paso hasta que el usuario confirma.
- **Cada paso:** construir → pruebas automáticas → demostración manual →
  actualizar documentación y versión → explicar qué se hizo, qué demuestran
  las pruebas y cómo verificarlo.
- **Documentación (desde 2026-09-27):** `README.md` es para usar el proyecto
  (instalación, primeros pasos, comandos, cosas a tener en cuenta,
  arquitectura). `docs/desarrollo.md` es la bitácora: cada paso, cómo se
  verificó y qué se aprendió. Cada paso nuevo va a la bitácora; el README
  solo se toca si cambia cómo se instala o se usa.
- **Verifica, no supongas.** Antes de tocar los hooks, revisa la documentación
  actual de Codex (cambia seguido). Reproduce los problemas reportados antes
  de corregirlos. Si una prueba no ejercita lo que dice, corrígela.
- **Los commits los hace el usuario.** Nunca ejecutes `git commit`; deja los
  cambios listos y di qué archivos cambiaron.
- **No confíes en lo que el agente dice que recibió.** Para saber qué recibió
  Codex, la fuente confiable es `agent-sync hook prompt`.

## Arquitectura

```
src/
├── cli.ts              comandos manuales y punto de entrada de los hooks
├── actions.ts          acciones compartidas por el CLI y los hooks
├── hooks/
│   ├── input.ts        lee el JSON que Codex envía por stdin (tolerante)
│   ├── on-stop.ts      hook Stop: actualiza la foto
│   └── on-prompt.ts    hook UserPromptSubmit: entrega el resumen
├── core/               lógica pura, NO depende de git
│   ├── state.ts        .git/agent-sync/baseline.json y la bitácora hook.log
│   ├── summary.ts      arma el resumen para el agente
│   └── format.ts       distingue cambios de formato de cambios de contenido
├── sources/
│   └── git.ts          foto, comparación, detalle por archivo, lectura de blobs
├── proxy/              fase 2
│   ├── stdio.ts        conexión MCP por stdio (JSON-RPC, un mensaje por línea)
│   ├── proxy.ts        paso 2: reenvía entre Codex y el servidor real, sin cambios
│   ├── recorder.ts     paso 3: detecta escrituras mirando los mensajes
│   ├── registry.ts     paso 3: .git/agent-sync/registro-apps.jsonl
│   └── diagnostic.ts   paso 0: servidor MCP que anota cómo lo arranca Codex
└── toy/
    └── notes-app.ts    paso 1: app de juguete, servidor MCP de notas en un JSON
test/                   pruebas con node:test; crean repos temporales
test/helpers/mcp-client.js  "Codex simulado" para probar servidores MCP
docs/desarrollo.md      bitácora de desarrollo (el README es solo de uso)
examples/codex-hooks.json   configuración de los hooks para Codex
```

Principio: `core/` recibe datos y devuelve texto, sin git. Así, en la fase 2,
los cambios que detecte el proxy usarán el mismo resumen.

## Comandos

```bash
npm install && npm test        # compila (tsc) y corre las pruebas
agent-sync snapshot            # toma la foto a mano
agent-sync diff [--patch]      # qué cambió desde la foto
agent-sync summary             # resumen legible
agent-sync hook prompt         # exactamente lo que recibiría Codex ahora
agent-sync status              # última foto y bitácora de los hooks
agent-sync hook stop           # lo ejecuta Codex al terminar una tarea
```

## Reglas que no se deben romper

1. **Los hooks terminan SIEMPRE con código 0.** En `UserPromptSubmit`, el
   código 2 bloquea el prompt del usuario. En `Stop`, el código 2 hace que el
   agente siga trabajando.
2. **El hook `Stop` nunca escribe en stdout.** Cierta salida JSON hace que
   Codex continúe en lugar de terminar.
3. **El hook del prompt nunca responde con `"decision"`**, solo con
   `hookSpecificOutput.additionalContext`. Sin cambios o ante un error, no
   escribe nada.
4. **Nunca se modifica el historial del usuario.** La foto es un commit oculto
   en `refs/agent-sync/last`, creado con un índice temporal
   (`GIT_INDEX_FILE`). No se tocan ramas, staging ni archivos.
5. **El estado vive en `.git/agent-sync/`**, nunca en una carpeta del proyecto.
6. **Nunca se envía el contenido de archivos sensibles** (`.env`, `.env.*`,
   `.pem`, `.key`, `id_rsa`, `.npmrc`...), solo se menciona que cambiaron.
7. **El resumen no pasa de 6000 caracteres por defecto.** Codex recorta el
   contexto de un hook que supera unos 2500 tokens.
8. Los errores de los hooks se anotan en `.git/agent-sync/hook.log`
   (últimas 200 líneas); `agent-sync status` los muestra.

## Decisiones tomadas y por qué

- Se compara contra la foto, no contra el último commit: un cambio que el
  usuario ya commiteó sigue siendo desconocido para el agente.
- El hook del prompt NO modifica la foto: si la tarea se interrumpe antes de
  `Stop`, el aviso se repite en el siguiente prompt en lugar de perderse.
- La primera vez en un proyecto sin foto, el hook del prompt toma la foto
  inicial en silencio. Una referencia dañada se trata igual.
- Resumen: primero "Cambios de contenido" con su diff; después "Solo formato"
  agrupado en una línea (primeros 10 nombres), sin diff. Los archivos sin
  espacio para su diff se marcan "sin detalle" en la propia lista. Orden
  natural de rutas (`componente2` antes que `componente10`).
- "Solo formato" = el archivo queda idéntico al ignorar espacios, saltos de
  línea, tipo de comillas, punto y coma y comas finales antes de `}])`.
  Solo aplica a archivos `modified`: los renombrados siempre son contenido.
  En Python, YAML, Makefile, Sass y similares nunca se asume "solo formato"
  (la sangría cambia la lógica). Archivos > 1 MB se tratan como contenido.
- Cambio de rama: la foto guarda `branch` y `head` en `baseline.json`. Si al
  enviar el prompt la rama (o el commit suelto) es otra, el resumen empieza
  con "Cambio de rama: de `X` a `Y`", pide al agente avisarle al usuario en
  su respuesta, y dice que las diferencias vienen sobre todo de la rama (no
  "por su cuenta"). Se avisa aunque no haya diferencias de archivos. Fotos
  sin `branch` (v0.2.0) no generan aviso. Un commit en la misma rama no
  cuenta. Aún no se separan los cambios de la rama de las ediciones del
  usuario hechas encima.
- Se descartó agrupar por "huella" del diff: no agrupaba archivos distintos
  reformateados (verificado).
- `tsconfig.json` declara `"types": ["node"]`: TypeScript 6 ya no los carga
  automáticamente.
- Las pruebas usan `fileURLToPath` y `mkdirSync` (no `.pathname` ni `mkdir`)
  para funcionar en Windows.

## Lo que se aprendió probando con Codex

- Cambios simples: Codex los describe sin que se los digan.
- 60 archivos reformateados: con solo 5 diffs, Codex dedujo que todo era
  formato y lo respetó al editar.
- 70 archivos reformateados + un `console.log` escondido (v0.1.0): Codex
  dijo que todo era formato y pasó por alto el cambio real. Motivó la v0.2.0.
- Con v0.2.0 el cambio real llega primero y con detalle; el resumen bajó de
  5813 a 1321 caracteres.
- Codex afirmó que el hook "ya había destacado" el cambio escondido; la
  reproducción mostró que no. El agente reconstruye explicaciones plausibles.
- Caso 6 (v0.3.0), proyecto de práctica `Documents\Personal\prueba-ramas`
  (ramas `main` y `diseno`): `hook prompt` mostró "Cambio de rama" y Codex
  empezó su respuesta con "Detecté que cambiaste de la rama main a diseno;
  voy a leer app.js tal como está ahora." Sin errores.
- Paso 3 de la fase 2 (2026-09-27): Codex NO usó la app de notas. Busca
  herramientas por palabra clave (`ALL_TOOLS.filter(/note/i)`), no encontró
  "nota", creó `Compras.txt` en el proyecto y respondió como si hubiera
  creado la nota. El proxy funcionaba (verificado con el comando exacto de
  `config.toml`). Se agregó "notes" a las descripciones y `instructions` al
  saludo MCP. Segundo intento: Codex ni buscó herramientas; vio
  `saludo.txt` y decidió que "las notas" eran archivos. En el paso 2, con
  una instrucción casi igual, sí listó `ALL_TOOLS` y usó la app: la elección
  no es consistente. Por eso las instrucciones de prueba deben nombrar la
  app ("usando la app notas_juguete..."), como se nombraría Figma. También
  se vio que Codex envía `id` como número (`{id: 2}`); la app ahora lo
  acepta. Lección: al verificar, revisar la sesión en
  `~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl` (qué herramientas llamó de
  verdad) antes de culpar al código.
- Rendimiento del hook del prompt: ~0,6 s con 500 archivos cambiados,
  ~3,7 s con 2000 (límite del hook: 30 s).

## Instalación del usuario

- Los hooks se configuran una vez a nivel de usuario en `~/.codex/hooks.json`
  (plantilla en `examples/codex-hooks.json`), con `npm link` para que el
  comando `agent-sync` exista globalmente.
- Codex exige aprobar los hooks con `/hooks` y vuelve a pedirlo si cambian.
- Si hay hooks en `~/.codex/hooks.json` y en `.codex/hooks.json` del proyecto,
  ambos se ejecutan (resumen duplicado): usar solo uno.
- El usuario vio un hook `UserPromptSubmit` en `/hooks` que no parecía de
  agent-sync; no se confirmó su origen. Revisar antes de combinar archivos.
- El usuario usa Codex por consola (CLI), versión 0.157.1.
- Sistema operativo del usuario: Windows 11. Node se maneja con `fnm`; en Git
  Bash hay que ejecutar `eval "$(fnm env --shell bash)"` antes de `npm`/`node`.

## Pendientes

1. **Mejora opcional del caso 6:** separar los archivos que cambiaron por la
   rama de las ediciones que el usuario hizo encima. No se ha pedido.
2. **Comando `agent-sync install`** (propuesto, no pedido aún): crear o
   combinar `~/.codex/hooks.json` sin borrar hooks existentes.
3. **Fase 2, proxy MCP para apps externas** (Figma, calendario, cualquier app
   con servidor MCP): un proxy entre Codex y los servidores MCP que registra
   cada escritura del agente (qué recurso, cómo releerlo, foto del resultado)
   en un registro; antes de cada prompt relee esos recursos, compara con la
   foto y agrega los cambios al mismo resumen. Detalles en el documento.

## Fase 2: plan por pasos

Diseño: un proxy MCP entre Codex y el servidor MCP de cada app. Registra las
escrituras del agente (qué recurso, cómo releerlo); al terminar la tarea se
guarda la foto de esos recursos; antes de cada prompt se releen, se comparan
y las diferencias entran al mismo resumen que la fase 1. Apps sin forma
conocida de releer: "plan B", el resumen le pide al agente verificarlas.

Configuración de Codex (verificado en la documentación el 2026-09-26): cada
servidor va en `~/.codex/config.toml` como `[mcp_servers.<nombre>]` con
`command`, `args`, `env`, `cwd` (stdio) o `url` (HTTP); también
`enabled_tools`, `startup_timeout_sec` (10 s) y `tool_timeout_sec` (60 s).

Pasos (cada uno: construir, pruebas, prueba manual, README, esperar al
usuario):

0. **Verificar cómo Codex lanza un servidor MCP** (carpeta de trabajo,
   variables de entorno, qué llega por stdin). Con un servidor mínimo que
   anota eso en un archivo. Decide dónde vive el registro.
1. **App de juguete:** un servidor MCP de pruebas ("notas" guardadas en un
   JSON fuera del proyecto) con herramientas de leer, listar y escribir. El
   usuario puede editar el JSON a mano, igual que alguien editaría en Figma.
2. **Proxy transparente:** `agent-sync proxy -- <comando del servidor>`
   reenvía todo sin cambiar nada. Prueba: mismas herramientas y resultados
   que hablando directo con el servidor.
3. **Registro de escrituras:** el proxy distingue lecturas de escrituras
   (anotación `readOnlyHint` de MCP o tabla por app) y anota cada escritura.
4. **Tabla escritura → lectura:** para la app de juguete, `escribir_nota`
   se relee con `leer_nota`. Lo no reconocido va al plan B.
5. **Foto en `Stop`:** relee los recursos registrados y guarda su foto.
   Ignora campos que cambian solos (fechas de modificación, ids internos).
6. **Comparar en el prompt:** relee, compara y agrega "Cambios en apps
   externas" al resumen, dentro del mismo límite de 6000 caracteres.
7. **Prueba de punta a punta con Codex** y la app de juguete.
8. **Primera app real,** a elegir con el usuario. Riesgo conocido: los
   servidores con OAuth (p. ej. Figma remoto) guardan el acceso en Codex, y
   el hook quizás no pueda releer por su cuenta. Verificarlo antes de elegir.
9. **Cierre:** documentación, versión 0.4.0, unir `fase-2` a `main`.

Resultados del paso 0 (Codex CLI 0.157.1, Windows, 2026-09-27):

- `cwd` del servidor = carpeta donde se abrió Codex, pero con mayúsculas
  distintas (`documents\personal` en vez de `Documents\Personal`). Comparar
  rutas sin distinguir mayúsculas, o normalizarlas con git.
- Codex NO ofrece `roots`. Capacidades: `elicitation` y
  `experimental.codex/auth-change`. Protocolo `2025-06-18`.
- Cada `tools/call` trae `params._meta["x-codex-turn-metadata"]` con
  `session_id`, `turn_id` (el mismo que reciben los hooks) y `workspaces`
  (ruta del proyecto → último commit). Sirve para saber a qué proyecto y
  turno pertenece cada escritura. No está documentado: usarlo si existe y,
  si no, caer a `cwd`.
- Codex pasa solo 21 variables de entorno básicas (PATH, USERPROFILE,
  APPDATA, TEMP...). Los tokens de un servidor real hay que darlos con
  `env`/`env_vars` en `config.toml`. Pendiente para el paso 5: verificar si
  el hook tiene las mismas variables para poder releer por su cuenta.
- El servidor queda vivo durante toda la sesión de Codex.
- `command` con la ruta completa de `node.exe` de fnm funciona.
- Decisión: el registro del proxy vive en `.git/agent-sync/` del proyecto
  indicado por `workspaces` (o `cwd`), igual que la fase 1.

Resultados del paso 1 (2026-09-27): Codex creó y listó notas sin errores.
Tras editar la nota a mano, a la pregunta directa "¿qué dice la nota?"
Codex la releyó y respondió bien. El riesgo real está en tareas que no
piden leer: p. ej. "agrega 'con el equipo' al final de la nota" podría
reescribirla desde la memoria y borrar el cambio del usuario. Usar ese
caso en la prueba de punta a punta (paso 7).

Paso 2 (2026-09-27): el proxy reenvía líneas sin tocarlas (las pruebas
comparan byte a byte con y sin proxy); el código de salida es el del
servidor real. En Windows `spawn` no arranca `.cmd` (`npx` da ENOENT,
`npx.cmd` da EINVAL): usar `cmd.exe /c npx ...` (verificado desde
PowerShell; en Git Bash `/c` se convierte en ruta). Se corrigió que un fallo
inmediato de `spawn` terminaba con código 0.

Paso 3 (2026-09-27), decisiones: escritura = llamada exitosa a una
herramienta sin `readOnlyHint: true` (sin anotación o no vista en
`tools/list` también cuenta, por prudencia; queda en `motivo`). Las
llamadas fallidas no se anotan. El proxy reenvía primero y observa después;
un fallo al anotar va a stderr y nunca afecta la conversación. Proyecto =
primera clave de `workspaces` de Codex, o `cwd`; sin git no se anota. Los
textos de los argumentos se recortan a 200 caracteres.

Reglas de seguridad de la fase 2:

- Todo se desarrolla en la rama `fase-2`. `main` y la etiqueta `v0.3.0`
  quedan como la versión estable.
- Las pruebas de la fase 1 deben seguir pasando en cada paso.
- El proxy es opcional: sin proxy configurado, todo se comporta igual que la
  v0.3.0.
- Si falla la parte de agent-sync, el proxy igual reenvía la llamada: nunca
  bloquea una herramienta de Codex. Las reglas 1 a 3 de los hooks siguen.
- Antes de tocar `~/.codex/config.toml`, guardar una copia
  `config.toml.respaldo`.
- Ojo: `npm link` apunta a esta carpeta. Lo que esté compilado aquí es lo
  que ejecutan los hooks de Codex, también en la rama `fase-2`.

Volver a la versión estable (plan de respaldo):

```bash
git switch main          # o: git switch --detach v0.3.0
npm run build            # el comando global vuelve a ser la v0.3.0
```

Y quitar de `~/.codex/config.toml` los servidores que pasen por el proxy
(o restaurar `config.toml.respaldo`).

## Referencias

- MCP en Codex: https://developers.openai.com/codex/mcp
  (redirige a https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- Hooks de Codex: https://developers.openai.com/codex/hooks
  (redirige a https://learn.chatgpt.com/docs/hooks)
- Eventos de webhooks de Figma: https://developers.figma.com/docs/rest-api/webhooks-events
- Nango, sync incremental de APIs: https://nango.dev/platform/data-sync
