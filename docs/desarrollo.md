# agent-sync: bitácora de desarrollo

Este archivo guarda, paso a paso, cómo se construyó agent-sync: qué hace cada
pieza, por qué, y cómo se verificó a mano cada paso. Para instalar y usar el
proyecto, lee el [README](../README.md).

Hasta la v0.3.0 este texto era el README. Las secciones de la fase 1 se
conservan tal como estaban; la cantidad de pruebas que mencionan es la de
ese momento.

A mano: `snapshot` toma la foto, `diff` muestra lo que cambió, `summary`
genera el resumen, `status` muestra la foto y la bitácora de los hooks.

## Requisitos

- Node.js 20 o superior (`node --version` para comprobarlo)
- git

## Instalar

Desde la carpeta `agent-sync`:

```bash
npm install          # descarga TypeScript y los tipos de Node
npm test             # compila y corre las pruebas automáticas
```

Deben pasar 100 pruebas. Para usar el comando `agent-sync` desde cualquier
carpeta, ejecuta `npm link` una vez (para deshacerlo: `npm unlink -g agent-sync`).
Sin `npm link`, usa `node <ruta-a-agent-sync>/dist/cli.js` en lugar de `agent-sync`.

## Cómo funciona la foto

`agent-sync snapshot` guarda una copia del estado actual de tus archivos:
los que git ya sigue, los modificados y los nuevos que aún no agregaste,
respetando `.gitignore`.

La foto es un commit oculto guardado en la referencia `refs/agent-sync/last`.
No pertenece a ninguna rama, así que:

- tu historial (`git log`) no cambia,
- tu área de staging (`git add`) no cambia,
- tus archivos no cambian.

El único lugar donde podrías verla es con `git log --all`, que muestra todas
las referencias, incluidas las ocultas. Cada foto nueva reemplaza a la anterior.

El estado de agent-sync vive en `.git/agent-sync/baseline.json`, dentro de la
carpeta interna de git. Nunca aparece en `git status` ni puede terminar en un
commit.

## Verificar el paso 1 a mano

En cualquier proyecto con git (mejor uno de prueba):

```bash
git status --short && git log --oneline -3    # 1. anota cómo está todo
agent-sync snapshot                            # 2. toma la foto
git status --short && git log --oneline -3    # 3. debe verse idéntico
git show --stat refs/agent-sync/last           # 4. aquí está la foto
```

## Cómo funciona la comparación

`agent-sync diff` captura el estado actual de tus archivos de la misma forma
que la foto (con un índice temporal) y lo compara con ella. Lista cada archivo
como `nuevo`, `modificado`, `eliminado` o `renombrado`. Con `--patch` muestra
además el detalle línea por línea.

Compara contra la foto, no contra tu último commit: si haces un commit después
de la foto, esos cambios siguen apareciendo, porque también los hiciste tú.
No modifica nada: ni tus archivos, ni tu staging, ni la foto.

## Verificar el paso 2 a mano

```bash
agent-sync snapshot                  # 1. toma la foto
# 2. edita un archivo, crea uno nuevo y borra otro, a mano
agent-sync diff                      # 3. deben aparecer los tres cambios
agent-sync diff --patch              # 4. el detalle línea por línea
agent-sync snapshot && agent-sync diff   # 5. debe decir "Sin cambios"
```

## El resumen para el agente

`agent-sync summary` muestra exactamente el texto que el agente recibirá antes
de tu próximo prompt. Incluye:

- una instrucción clara: los cambios son tuyos e intencionales, no deben
  revertirse, y el agente debe releer los archivos antes de editarlos;
- **cambios de contenido**, primero, con su tipo, líneas agregadas/quitadas y
  el detalle línea por línea;
- **cambios de solo formato**, agrupados en una línea, sin detalle.

### Contenido frente a formato

Un archivo modificado es de "solo formato" si, antes y después, queda idéntico
al ignorar espacios, saltos de línea, tipo de comillas, punto y coma y comas
finales: lo que suelen cambiar Prettier, Black y otros formateadores. Cualquier
otra diferencia, aunque sea un número, es un cambio de contenido.

Esto evita que un cambio real quede escondido entre muchos cambios de formato.
Por ejemplo, con 70 archivos reformateados y un `console.log` agregado en uno,
el resumen pone ese archivo primero con su detalle completo y agrupa los otros
69 en una línea.

Límites conocidos:

- En Python, YAML, Makefile y otros formatos donde la sangría tiene significado,
  nunca se asume "solo formato": todo cambio se trata como contenido.
- Un cambio que solo toque espacios dentro de un texto (por ejemplo
  `"Hola mundo"` a `"Holamundo"`) se clasificaría como formato.
- Los archivos renombrados o mayores de 1 MB siempre se tratan como contenido.

### Protecciones

- el detalle se limita por tamaño; lo que no cabe se marca "sin detalle" en la
  propia lista;
- no se incluye el contenido de archivos eliminados ni binarios;
- nunca se incluye el contenido de archivos sensibles (`.env`, `.env.*`, llaves
  `.pem`/`.key`, `id_rsa`, `.npmrc`...), solo se menciona que cambiaron;
- si hay más de 50 archivos con cambios de contenido, se listan los primeros y
  se indica cuántos faltan; de los de solo formato se nombran los primeros 10.

Si no hay cambios, no genera ningún resumen.

### Cambio de rama

La foto también guarda en qué rama estaba el proyecto. Si cambias de rama
entre dos tareas del agente (`git checkout otra-rama`), el resumen empieza con
una línea explícita, por ejemplo:

```
Cambio de rama: desde que terminaste tu última tarea (...), el usuario cambió el proyecto de `main` a `feature`.
Al empezar tu respuesta, avísale al usuario en una frase que detectaste este cambio de rama.
```

Además, ya no dice que los archivos distintos son "cambios por tu cuenta": aclara
que la mayoría vienen del cambio de rama. El aviso sale aunque las dos ramas
tengan los mismos archivos, y se repite en cada prompt hasta que el agente
termine una tarea (igual que los demás cambios). Si el proyecto queda en un
commit sin rama, se nombra el commit. Un commit nuevo en la misma rama no
cuenta como cambio de rama.

La instrucción de avisarte sirve para que veas que el agente sí recibió el
aviso. Aun así, la prueba confiable es `agent-sync hook prompt`: el agente
puede reconstruir explicaciones plausibles aunque no las haya recibido.

`src/core/summary.ts` no depende de git: recibe datos y devuelve texto. Así,
en la fase 2, los cambios del proxy (Figma, calendario...) usarán el mismo resumen.

## Verificar el paso 3 a mano

```bash
agent-sync snapshot
# edita un archivo y crea otro, a mano
agent-sync summary                   # el resumen completo
agent-sync summary --max-chars 0     # solo la lista, sin detalle
echo "API_KEY=123" > .env            # (si .env no está en tu .gitignore)
agent-sync summary                   # .env aparece listado, sin su contenido
```

## Cómo funciona con Codex

```
tú envías un prompt ──► hook prompt: ¿cambió algo desde la foto?
                          ├─ no  ► no agrega nada
                          └─ sí  ► agrega el resumen al contexto de Codex
Codex trabaja
Codex termina ─────────► hook stop: nueva foto (incluye lo de Codex y lo tuyo)
tú editas a mano ──────► (nada todavía; se detecta en el próximo prompt)
```

## Conectar con Codex: hook `Stop` (paso 4)

Cada vez que Codex termina una tarea, ejecuta `agent-sync hook stop`, que
actualiza la foto. Así la foto siempre es "lo último que dejó el agente", y
todo lo que cambie después se atribuye a ti.

El hook es deliberadamente silencioso: no escribe nada en la salida y termina
siempre con código 0, incluso si falla. En Codex, cierta salida del hook
`Stop` le pide al agente seguir trabajando; agent-sync nunca debe provocar eso.
Cada ejecución (y cada error) queda en `.git/agent-sync/hook.log`.

### Instalación (sirve para los pasos 4 y 5)

1. Dentro de la carpeta `agent-sync`, ejecuta `npm link` una vez. Comprueba
   que funciona desde cualquier carpeta con `agent-sync --version`.
2. En un proyecto de prueba con git, crea la carpeta `.codex` (con punto) y
   copia dentro `examples/codex-hooks.json` con el nombre `hooks.json`.
   Configura ambos hooks, `UserPromptSubmit` y `Stop`.
3. Abre Codex en ese proyecto. Los hooks de un proyecto solo se ejecutan
   después de revisarlos y aprobarlos: escribe `/hooks` en Codex y aprueba
   el hook de agent-sync. Codex vuelve a pedir aprobación si el archivo cambia.

Para activarlo en todos tus proyectos, usa `~/.codex/hooks.json` en lugar
del archivo del proyecto. En carpetas sin git, el hook no hace nada.

Si en Windows Codex no encuentra el comando `agent-sync`, agrega al hook
`"commandWindows": "node C:\\ruta\\a\\agent-sync\\dist\\cli.js hook stop"`.

### Verificar el paso 4

```bash
# 1. Pídele a Codex cualquier tarea pequeña que modifique un archivo.
agent-sync status    # 2. debe mostrar "stop    foto ..." con la hora reciente
agent-sync diff      # 3. debe decir "Sin cambios": lo del agente ya está en la foto
# 4. Edita un archivo a mano.
agent-sync diff      # 5. ahora sí aparece tu cambio
```

Si `status` dice que el hook no se ha ejecutado, revisa en Codex con `/hooks`
que esté aprobado.

## Conectar con Codex: hook `UserPromptSubmit` (paso 5)

Cada vez que envías un prompt, Codex ejecuta `agent-sync hook prompt` antes
de leerlo. Si cambiaste archivos desde la última foto, el hook le entrega el
resumen como contexto adicional. Si no, no agrega nada.

Reglas de seguridad del hook:

- Termina siempre con código 0: en este hook, el código 2 bloquearía tu prompt.
- Sin cambios o ante cualquier error, no escribe nada y tu prompt pasa intacto.
- No modifica la foto. Si la tarea se interrumpe antes del hook `Stop`, el
  resumen se repite en el siguiente prompt: es preferible a perderlo.
- La primera vez en un proyecto sin foto, toma la foto inicial en silencio.

**Tamaño.** Codex recorta el contexto de un hook que supera unos 2500 tokens
(le muestra al modelo solo el inicio y el final). Por eso el resumen se limita
a 6000 caracteres, priorizando la instrucción y la lista de archivos sobre el
detalle. Para cambiarlo: `"command": "agent-sync hook prompt --limit 4000"`.

Nota: Codex muestra en la conversación el contexto que agrega un hook, así que
verás el bloque `<cambios_externos>` antes de la respuesta del agente. Es
normal y te permite confirmar qué recibió.

### Verificar el paso 5

```bash
agent-sync hook prompt   # vista previa: exactamente lo que recibiría Codex ahora
```

Con Codex:

1. Si tu `hooks.json` solo tenía el hook `Stop`, reemplázalo por la versión
   nueva de `examples/codex-hooks.json` y vuelve a aprobarlo con `/hooks`.
2. Pídele a Codex una tarea pequeña y espera a que termine.
3. Edita a mano un archivo que Codex haya modificado.
4. Pídele a Codex: "¿Qué cambió en el proyecto desde tu última tarea?"
5. Debe describir tu cambio sin que se lo hayas dicho. `agent-sync status`
   mostrará una línea `prompt  1 cambios enviados a Codex`.

Cambio de rama (v0.3.0):

1. Con Codex en `main`, pídele una tarea pequeña y espera a que termine.
2. Cambia de rama a mano: `git checkout -b prueba-rama` o una rama existente.
3. Ejecuta `agent-sync hook prompt`: debe empezar con `Cambio de rama: ...`.
4. Pídele a Codex cualquier cosa. Su respuesta debe empezar mencionando el
   cambio de rama. `agent-sync status` mostrará `cambio de rama main -> ...`.

## Fase 2, paso 0: cómo arranca Codex un servidor MCP

Antes de construir el proxy hay que saber cómo lanza Codex un servidor MCP:
en qué carpeta, con qué variables y qué mensajes le envía.
`agent-sync diagnostico-mcp` es un servidor MCP mínimo que solo anota eso en
`~/.agent-sync/diagnostico-mcp.jsonl`. De las variables de entorno anota
solo los nombres, nunca los valores.

Para probarlo, agrega esto a `~/.codex/config.toml` (antes guarda una copia
del archivo). Usa la ruta completa de `node.exe` y de `dist/cli.js`:

```toml
[mcp_servers.agent_sync_diagnostico]
command = 'C:\Users\<tu-usuario>\AppData\Roaming\fnm\aliases\default\node.exe'
args = ['C:\ruta\a\agent-sync\dist\cli.js', 'diagnostico-mcp']
```

Luego, en Codex, abre un proyecto y pídele "usa la herramienta diagnostico".
Para ver lo que se anotó:

```bash
agent-sync diagnostico-mcp --mostrar
```

Al terminar el paso, quita esa sección de `config.toml`.

## Fase 2, paso 1: la app de juguete

`agent-sync notas-juguete` es un servidor MCP de "notas" que hace el papel de
una app externa como Figma, pero sin cuentas ni internet. Las notas viven en
`~/.agent-sync/notas-juguete.json`, fuera del proyecto:

- Codex las usa con cinco herramientas: `listar_notas`, `leer_nota`
  (solo leen), `crear_nota`, `editar_nota` y `borrar_nota` (modifican).
- Tú las cambias a mano editando ese archivo, como alguien que edita en Figma
  por su cuenta. La app vuelve a leer el archivo en cada llamada.
- Cada nota guarda `modificada`, una fecha que cambia sola en cada edición.
  Servirá para comprobar que el proxy ignora los campos que cambian solos.

Configuración en `~/.codex/config.toml`:

```toml
[mcp_servers.notas_juguete]
command = 'C:\Users\<tu-usuario>\AppData\Roaming\fnm\aliases\default\node.exe'
args = ['C:\ruta\a\agent-sync\dist\cli.js', 'notas-juguete']
```

Para ver el archivo y su contenido:

```bash
agent-sync notas-juguete --mostrar
```

Verificado con Codex (2026-09-27): creó y listó notas sin errores. Tras
cambiar una nota a mano, a la pregunta "¿qué dice la nota?" Codex la releyó
y respondió bien. El caso de riesgo es una tarea que modifica sin leer
antes (por ejemplo, "agrega ' con el equipo' al final de la nota 1").

## Fase 2, paso 2: el proxy transparente

`agent-sync proxy -- <comando> [args...]` se pone entre Codex y un servidor
MCP. Codex arranca el proxy como si fuera el servidor; el proxy arranca el
servidor real y reenvía los mensajes en ambos sentidos, línea por línea y sin
modificarlos. En este paso no anota nada: solo se comprueba que Codex no nota
la diferencia.

```
Codex  ◄──►  agent-sync proxy  ◄──►  servidor real (p. ej. notas-juguete)
```

Reglas:

- los mensajes pasan idénticos, aunque no sean JSON;
- el stderr del servidor real pasa tal cual (Codex lo usa para sus registros);
- si el servidor real termina, el proxy termina con el mismo código;
- si Codex cierra la conexión, el proxy cierra la del servidor real.

Las pruebas repiten la misma conversación con y sin proxy y comparan la
salida byte a byte. También cubren escrituras, mensajes del servidor hacia
Codex, líneas que no son JSON, mensajes de 300 KB y los cierres.

Configuración en `~/.codex/config.toml` para usar la app de juguete a través
del proxy (reemplaza la sección `notas_juguete` del paso 1):

```toml
[mcp_servers.notas_juguete]
command = 'C:\Users\<tu-usuario>\AppData\Roaming\fnm\aliases\default\node.exe'
args = [
  'C:\ruta\a\agent-sync\dist\cli.js', 'proxy', '--',
  'C:\Users\<tu-usuario>\AppData\Roaming\fnm\aliases\default\node.exe',
  'C:\ruta\a\agent-sync\dist\cli.js', 'notas-juguete',
]
```

**Limitación en Windows:** el proxy no puede arrancar directamente comandos
que en realidad son archivos `.cmd`, como `npx`. Solución: pasarlos por
`cmd.exe`, por ejemplo `agent-sync proxy -- cmd.exe /c npx -y <paquete>`
(verificado con `npx --version`). Encontrarlo destapó un error ya corregido:
cuando el comando fallaba al instante, el proxy terminaba con código 0.

Verificado con Codex (2026-09-27): con la app de juguete detrás del proxy,
Codex listó, creó y leyó notas exactamente igual que sin proxy.

## Fase 2, paso 3: el registro de escrituras

El proxy ahora mira los mensajes que pasan (sin cambiarlos) y anota cada vez
que el agente **modifica** algo en la app. El registro vive en
`.git/agent-sync/registro-apps.jsonl` del proyecto, igual que la foto de la
fase 1, y se consulta con:

```bash
agent-sync registro
```

**Cómo decide qué es una escritura.** Al empezar, Codex le pide al servidor su
lista de herramientas, y cada una puede traer la anotación MCP
`readOnlyHint: true` ("solo leo"). El proxy la guarda. Cuando el agente llama
una herramienta y la llamada sale bien:

| La herramienta... | Se anota | `motivo` |
|---|---|---|
| dice que solo lee (`readOnlyHint: true`) | no | — |
| dice que modifica (`readOnlyHint: false`) | sí | `anotacion` |
| no dice nada | sí, por prudencia | `sin_anotacion` |
| no estaba en la lista (el proxy no la vio) | sí, por prudencia | `desconocida` |

Las llamadas que fallan no se anotan: no modificaron nada. Por prudencia se
prefiere anotar de más, porque revisar algo sin cambios cuesta poco y dejar
pasar un cambio es justo lo que se quiere evitar.

**Qué guarda cada entrada:** fecha, servidor (el nombre que informa en el
saludo MCP), herramienta, argumentos (los textos de más de 200 caracteres se
recortan: para volver a leer un recurso basta su id), motivo, y el turno y la
sesión de Codex.

**A qué proyecto pertenece.** Codex manda en cada llamada la carpeta del
proyecto (el dato `workspaces` que se descubrió en el paso 0). Si no la manda,
se usa la carpeta donde arrancó el proxy. Fuera de un repositorio git no se
anota nada.

**Nunca frena a Codex.** El proxy primero reenvía cada mensaje y después lo
mira. Si anotar falla, la conversación sigue igual y el error se escribe en
stderr.

**Primera prueba con Codex: el registro quedó vacío.** La causa no fue el
proxy. La sesión de Codex (`~/.codex/sessions/.../rollout-*.jsonl`) mostró que
Codex buscó sus herramientas con la palabra `note` en inglés, no encontró
`listar_notas` ni `crear_nota`, y creó un archivo `Compras.txt` en el
proyecto, respondiendo como si hubiera creado la nota. Corrección: las
descripciones de la app de juguete incluyen "notes" y el saludo MCP trae
`instructions` explicando qué es la app. Lección: antes de culpar al código,
revisar en la sesión qué herramientas llamó Codex de verdad.

En el segundo intento Codex ni siquiera buscó herramientas: vio `saludo.txt`
en el proyecto y decidió que "las notas" eran archivos de texto. En el paso 2,
con una instrucción casi igual, sí usó la app. Con una instrucción ambigua,
Codex no elige siempre lo mismo. Por eso las instrucciones de prueba nombran
la app, igual que en la vida real se diría "en Figma" o "en mi calendario".
Revisando el paso 2 apareció además que Codex a veces envía el `id` como
número (`{id: 2}`); la app ahora lo acepta.

Tercer intento, nombrando la app ("usando la app notas_juguete..."): `/mcp`
mostró la app conectada y el registro anotó `crear_nota` y `editar_nota`
(no las lecturas), con el turno y la sesión de Codex. Verificado el
2026-09-27.

## Estructura

```
src/
├── cli.ts              comandos manuales y punto de entrada de los hooks
├── actions.ts          acciones compartidas por el CLI y los hooks
├── hooks/
│   ├── input.ts        lee el JSON que Codex envía a cada hook
│   ├── on-stop.ts      hook Stop: actualiza la foto (paso 4)
│   └── on-prompt.ts    hook UserPromptSubmit: entrega el resumen (paso 5)
├── core/
│   ├── state.ts        baseline.json y la bitácora hook.log, dentro de .git
│   ├── format.ts       distingue cambios de formato de cambios de contenido
│   └── summary.ts      arma el resumen para el agente (no depende de git)
├── sources/
│   └── git.ts          toma la foto y la compara con el estado actual
└── proxy/              proxy MCP (fase 2)
test/                   pruebas automáticas
examples/               configuración de ejemplo para Codex
```

## Avance de la fase 1

- [x] Paso 0: estructura y `agent-sync --version`
- [x] Paso 1: `agent-sync snapshot` toma la foto sin alterar tu repositorio
- [x] Paso 2: `agent-sync diff` muestra lo que cambiaste a mano
- [x] Paso 3: el resumen legible para el agente
- [x] Paso 4: hook `Stop` conectado a Codex
- [x] Paso 5: hook `UserPromptSubmit` conectado a Codex
- [x] Caso 6: el resumen avisa explícitamente de un cambio de rama (v0.3.0)

## Avance de la fase 2 (rama `fase-2`)

- [x] Paso 0: cómo arranca Codex un servidor MCP (`diagnostico-mcp`)
- [x] Paso 1: app de juguete (`notas-juguete`)
- [x] Paso 2: proxy transparente (`proxy`), verificado con Codex
- [x] Paso 3: registro de escrituras (`registro`), verificado con Codex
- [ ] Paso 4: tabla escritura → lectura
- [ ] Paso 5: foto de los recursos en `Stop`
- [ ] Paso 6: comparar en el prompt
- [ ] Paso 7: prueba de punta a punta con Codex
- [ ] Paso 8: primera app real
- [ ] Paso 9: cierre (v0.4.0)
