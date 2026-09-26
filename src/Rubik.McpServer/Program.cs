using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using Rubik.McpServer;

// MCP stdio reserves stdout for JSON-RPC frames. Keep all host logs on stderr.
Console.SetOut(Console.Error);
var dataDirectory = ReadDataDirectory(args);
var builder = Host.CreateApplicationBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddConsole(options => options.LogToStandardErrorThreshold = LogLevel.Trace);
builder.Services.AddSingleton(new SessionReader(dataDirectory));
builder.Services.AddMcpServer()
    .WithStdioServerTransport()
    .WithTools<RubikTools>();
await builder.Build().RunAsync();

static string ReadDataDirectory(string[] arguments)
{
    string? configured = Environment.GetEnvironmentVariable("RUBIK_DATA_DIR");
    for (var i = 0; i < arguments.Length; i++)
    {
        if (arguments[i] == "--data-dir" && i + 1 < arguments.Length)
        {
            configured = arguments[++i];
            continue;
        }
        if (arguments[i] == "--data-dir" || arguments[i].StartsWith("--data-dir=", StringComparison.Ordinal))
            throw new ArgumentException("--data-dir requires a non-empty directory path.");
        throw new ArgumentException("Only --data-dir <path> is supported.");
    }
    if (string.IsNullOrWhiteSpace(configured))
        configured = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Rubik");
    return Path.GetFullPath(configured);
}
