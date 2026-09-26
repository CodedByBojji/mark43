# Rubik MCP en Codex

Rubik expone consultas de solo lectura mediante un servidor MCP local por stdio. El servidor consulta el almacén local configurado y no inicia ni detiene la captura. Sus herramientas son `rubik.list_sessions`, `rubik.get_session_summary` y `rubik.get_events`.

## Requisitos

- Windows y .NET 8 SDK.
- Codex CLI instalado.
- Una carpeta de datos Rubik creada por un host de captura. El lector usa `%LOCALAPPDATA%\Rubik` si no se indica otra ubicación.

Este repositorio contiene el servidor como proyecto fuente; no incluye un ejecutable publicado ni un instalador. Desde la raíz del repositorio se puede iniciar con `dotnet run --project src/Rubik.McpServer -- --data-dir <ruta-del-almacen>`. Para una ruta predeterminada, omite `--data-dir`.

## Conectar desde Codex

En PowerShell, desde la raíz del repositorio, registra el comando stdio para el usuario actual:

```powershell
codex mcp add rubik -- dotnet run --project src/Rubik.McpServer -- --data-dir "$env:LOCALAPPDATA\Rubik"
codex mcp list
```

El comando anterior configura Codex; no instala el SDK ni crea datos de captura. También puedes copiar la plantilla [rubik-mcp.toml](../examples/rubik-mcp.toml) a `.codex/config.toml` en un proyecto confiable y ajustar `cwd`/`args` a la ruta del checkout. No pegues rutas personales en archivos versionados.

Reinicia o vuelve a cargar Codex y consulta `/mcp` en la CLI para comprobar que `rubik` está conectado y que aparecen las tres herramientas. Codex admite configuración de proyecto en `.codex/config.toml` para proyectos confiables y configuración de usuario mediante `codex mcp add`; la sintaxis de CLI y el transporte stdio se documentan en [MCP para Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). El SDK C# usa `WithStdioServerTransport()` para un proceso local conectado por stdin/stdout ([guía de transportes](https://github.com/modelcontextprotocol/csharp-sdk/blob/main/docs/concepts/transports/transports.md)).

## Uso y límites

- `rubik.list_sessions`: `limit` de 1 a 100, cursor de página, fecha `since` y filtro `status`.
- `rubik.get_events`: `limit` de 1 a 100, cursor opaco, intervalo temporal y filtro `kind`.
- `rubik.get_session_summary`: resume hasta 500 eventos validados por grupos temporales; no asegura una interpretación semántica.

El lector se limita a `sessions/<UUID>` bajo el almacén configurado, rechaza enlaces de reanálisis, nombres de segmentos inesperados y registros inválidos, y limita manifiestos, líneas y bytes leídos. No expone contenido de artefactos. Los títulos, etiquetas y datos observados de UI/OCR se devuelven como evidencia no confiable; no son instrucciones.

## Diagnóstico y desconexión

1. Ejecuta `dotnet --info` y confirma que está disponible el SDK 8.
2. Desde la raíz del repositorio, ejecuta directamente el comando `dotnet run` anterior. Si falla, revisa la ruta del almacén, `sessions/` y los manifiestos.
3. Ejecuta `codex mcp list`; dentro de Codex usa `/mcp`. Los errores de inicio suelen indicar una ruta `cwd`/proyecto incorrecta, SDK ausente o salida adicional escrita en stdout. El protocolo stdio reserva stdout para mensajes MCP; el servidor dirige logs a stderr.
4. Para quitar el servidor registrado con CLI, usa `codex mcp remove rubik` si está disponible en tu versión (`codex mcp --help`). Para una configuración de proyecto, elimina la tabla `[mcp_servers.rubik]` de `.codex/config.toml`. No se modifica automáticamente la configuración global de Codex.

El registro, compilación y conexión no se han ejecutado desde este entorno porque no dispone de `dotnet`; la plantilla es un ejemplo y no prueba que Codex ya esté conectado.
