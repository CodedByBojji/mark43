# proxy/

Fase 2: el intermediario entre Codex y los servidores MCP de las apps
externas, que registra lo que el agente modifica y puede volver a leerlo.

- `diagnostic.ts` (paso 0): servidor MCP mínimo que anota cómo lo arranca
  Codex (carpeta, argumentos, nombres de variables, mensajes).
- `stdio.ts`: conexión MCP por stdio compartida por los servidores de la fase 2.
- `proxy.ts` (paso 2): arranca el servidor real y reenvía los mensajes entre Codex y él, sin cambiarlos.
- `recorder.ts` (paso 3): mira los mensajes que pasan y detecta las escrituras del agente.
- `registry.ts` (paso 3): guarda esas escrituras en `.git/agent-sync/registro-apps.jsonl`.
