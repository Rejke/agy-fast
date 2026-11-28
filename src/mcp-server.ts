import { runAgyFastCli } from "./cli-runner.js";
import {
  createAgyFastServer,
  parseMcpServerCliArgs,
  printMcpServerHelp,
} from "./mcp-server-core.js";

export {
  ALL_MCP_TOOLS,
  createAgyFastServer,
  parseMcpServerCliArgs,
  parseSchemaCompatMode,
  parseServerCliArgs,
  parseToolFilter,
  printMcpServerHelp,
  sanitizeSchemaToMinimalSubset,
  type AgyFastServerOptions,
  type AgyFastToolName,
  type SchemaCompatMode,
} from "./mcp-server-core.js";

function main(): void {
  if (process.argv[2] === "--cli") {
    void runAgyFastCli(process.argv.slice(3))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      });
    return;
  }

  const cliParsed = parseMcpServerCliArgs(process.argv.slice(2), process.env);
  if (!cliParsed.ok) {
    process.stderr.write(`Error: ${cliParsed.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (cliParsed.help) {
    printMcpServerHelp();
    return;
  }

  const server = createAgyFastServer({
    schemaCompat: cliParsed.schemaCompat,
    tools: cliParsed.tools,
  });
  let flushing = false;
  const exitImmediately = () => {
    process.exit(0);
  };
  const flushAndExit = () => {
    if (flushing) return;
    flushing = true;
    // Failsafe timer prevents broken Windows named pipes from stalling stdout.end()
    // and provoking forced CTRL_C/CTRL_BREAK termination (0xc000013a).
    const failsafe = setTimeout(() => {
      process.exit(0);
    }, 150);
    failsafe.unref();
    try {
      // Wait for buffered stdout pipe writes (>64KB) to drain before exiting
      process.stdout.end(() => {
        process.exit(0);
      });
    } catch {
      process.exit(0);
    }
  };
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (
      flushing ||
      err.code === "EPIPE" ||
      err.code === "EOF" ||
      err.code === "ECONNRESET" ||
      err.code === "ERR_STREAM_DESTROYED" ||
      err.code === "ERR_STREAM_WRITE_AFTER_END"
    ) {
      exitImmediately();
    }
  });
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  if (process.platform === "win32") {
    process.on("SIGBREAK", exitImmediately);
  }
  server.listen(process.stdin, process.stdout, flushAndExit);
}

main();
