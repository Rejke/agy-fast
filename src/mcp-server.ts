import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpStdioServer, type McpToolDefinition } from "./protocol/mcp.js";
import { MCP_CALL_BUDGET_SEC } from "./utils/exec-utils.js";
import {
  readSavedEditsFormatSync,
  resolveHostCompat,
  type EditsFormatMode,
  type ResolvedHostCompat,
} from "./utils/host-compat.js";
import { runApplyEdits, type ApplyEditsInput } from "./tools/apply-edits.js";
import { runBatchSearch, type BatchSearchInput } from "./tools/batch-search.js";
import {
  runQuickOutline,
  runReadSlices,
  type QuickOutlineInput,
  type ReadSlicesInput,
} from "./tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./tools/run-checks.js";

const SERVER_VERSION = "0.2.10";
const DEFAULT_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export interface AgyFastServerOptions {
  env?: NodeJS.ProcessEnv;
  configEditsFormat?: EditsFormatMode;
  processCwd?: () => string;
  pluginRoot?: string;
}

function canonicalizeDir(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  try {
    return typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrSubdir(candidate: string, root: string): boolean {
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  const normCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const normRoot = caseInsensitive ? root.toLowerCase() : root;
  const rel = path.relative(normRoot, normCandidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

function isInstalledPluginPath(dirPath: string): boolean {
  const posix = dirPath.replace(/\\/g, "/");
  return /(?:^|\/)(?:\.gemini\/(?:config\/|antigravity[^/]*\/)?plugins|\.agents\/plugins)\/[^/]+(?:\/|$)/i.test(
    posix,
  );
}

function detectPluginInstallCwd(
  env: NodeJS.ProcessEnv,
  currentCwd: string,
  scriptPluginRoot: string,
): string | null {
  const canonCwd = canonicalizeDir(currentCwd);

  for (const envRoot of [env.PLUGIN_ROOT, env.AGY_PLUGIN_ROOT]) {
    if (typeof envRoot === "string" && envRoot.trim()) {
      const canonEnvRoot = canonicalizeDir(envRoot.trim());
      if (isSameOrSubdir(canonCwd, canonEnvRoot)) {
        return envRoot.trim();
      }
    }
  }

  const canonScriptRoot = canonicalizeDir(scriptPluginRoot);
  if (isSameOrSubdir(canonCwd, canonScriptRoot)) {
    const isRuntimeOnlyInstall =
      fs.existsSync(path.join(canonScriptRoot, "plugin.json")) &&
      !fs.existsSync(path.join(canonScriptRoot, "src", "mcp-server.ts"));
    if (isInstalledPluginPath(canonScriptRoot) || isRuntimeOnlyInstall) {
      return scriptPluginRoot;
    }
  }

  return null;
}

function buildApplyEditsToolDefinition(
  compat: ResolvedHostCompat,
): McpToolDefinition {
  const preferStringEdits = compat.editsFormat === "string";
  const editsSchema = preferStringEdits
    ? {
        type: "string",
        description:
          'JSON array string of 1-50 files: [{"path","hunks"?:[{"target","replacement","startLine"?,"endLine"?,"replaceAll"?}],"create"?,"overwrite"?}].',
      }
    : {
        type: "array",
        minItems: 1,
        maxItems: 50,
        description: "Files to edit/create (JSON array string also accepted).",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            hunks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  target: { type: "string", description: "Exact text to match." },
                  replacement: { type: "string", description: "Replacement text." },
                  startLine: {
                    type: "integer",
                    minimum: 1,
                    description: "1-based start line.",
                  },
                  endLine: {
                    type: "integer",
                    minimum: 1,
                    description: "1-based end line.",
                  },
                  replaceAll: {
                    type: "boolean",
                    description: "Replace all matches in range.",
                  },
                },
                required: ["target", "replacement"],
              },
            },
            create: {
              type: "string",
              description: "Full content for new file (instead of hunks).",
            },
            overwrite: {
              type: "boolean",
              description: "Allow overwriting existing file with create.",
            },
          },
          required: ["path"],
        },
      };

  return {
    name: "apply_edits",
    description: preferStringEdits
      ? "Atomically edit/create 1-50 files with multi-hunk replacements and optional verify. Pass 'edits' as a JSON array string."
      : "Atomically edit/create 1-50 files with multi-hunk replacements and optional inline verify.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Workspace root (required if roots/list is unavailable).",
        },
        edits: editsSchema,
        dryRun: {
          type: "boolean",
          description: "Validate without writing (default false).",
        },
        bestEffort: {
          type: "boolean",
          description: "Write valid files even if others fail; skips verify on failure.",
        },
        verify: {
          type: "string",
          description: "Shell command run after writing (e.g. 'npm run typecheck').",
        },
        verifyTimeoutSec: {
          type: "integer",
          minimum: 1,
          maximum: MCP_CALL_BUDGET_SEC,
          description: `Verify timeout in seconds (default 60, max ${MCP_CALL_BUDGET_SEC}).`,
        },
        maxVerifyChars: {
          type: "integer",
          minimum: 300,
          maximum: 7500,
          description: "Verify output cap (default 4000, max 7500).",
        },
      },
      required: ["edits"],
    },
  };
}

export function createAgyFastServer(
  options: AgyFastServerOptions = {},
): McpStdioServer {
  const env = options.env ?? process.env;
  const getProcessCwd = options.processCwd ?? (() => process.cwd());
  const scriptPluginRoot = options.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  const savedEditsFormat =
    options.configEditsFormat ?? readSavedEditsFormatSync(env);
  let hostCompat = resolveHostCompat({
    env,
    configEditsFormat: savedEditsFormat,
  });

  // agy starts plugin servers in the plugin directory; resolve omitted or relative
  // tool `cwd` values against the first valid workspace root without mutating process.cwd().
  // Never silently fall back to the installed plugin directory when roots/list is unavailable.
  let defaultCwd: string | undefined;

  const resolveToolArgs = <T extends { cwd?: string }>(
    args: Record<string, unknown>,
  ): { ok: true; value: T } | { ok: false; error: string } => {
    if (args.cwd !== undefined && args.cwd !== null && typeof args.cwd !== "string") {
      return {
        ok: false,
        error: `Error: 'cwd' must be a string path (received ${Array.isArray(args.cwd) ? "array" : typeof args.cwd}).`,
      };
    }
    const rawCwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const isHomePath =
      rawCwd === "~" || rawCwd.startsWith("~/") || rawCwd.startsWith("~\\");
    if (!rawCwd) {
      if (defaultCwd) {
        return {
          ok: true,
          value: { ...args, cwd: defaultCwd } as unknown as T,
        };
      }
      const pluginFallbackDir = detectPluginInstallCwd(
        env,
        getProcessCwd(),
        scriptPluginRoot,
      );
      if (pluginFallbackDir) {
        return {
          ok: false,
          error: `Error: 'cwd' is required because this host did not report a workspace root via MCP roots/list and the MCP server started inside the plugin directory (${pluginFallbackDir}). Pass the active workspace root explicitly in 'cwd'.`,
        };
      }
      return {
        ok: true,
        value: { ...args, cwd: undefined } as unknown as T,
      };
    }
    if (!path.isAbsolute(rawCwd) && !isHomePath) {
      if (defaultCwd) {
        return {
          ok: true,
          value: { ...args, cwd: path.resolve(defaultCwd, rawCwd) } as unknown as T,
        };
      }
      const pluginFallbackDir = detectPluginInstallCwd(
        env,
        getProcessCwd(),
        scriptPluginRoot,
      );
      if (pluginFallbackDir) {
        return {
          ok: false,
          error: `Error: 'cwd' must be an absolute workspace path because this host did not report a workspace root via MCP roots/list and the MCP server started inside the plugin directory (${pluginFallbackDir}). Received relative cwd: ${JSON.stringify(rawCwd)}.`,
        };
      }
    }
    return { ok: true, value: { ...args, cwd: rawCwd } as unknown as T };
  };

  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION,
    onInitialize: ({ clientInfo }) => {
      hostCompat = resolveHostCompat({
        clientInfo,
        env,
        configEditsFormat: savedEditsFormat,
      });
    },
    shouldRequestRoots: (_toolName, args) => {
      const rawCwd = args.cwd;
      if (rawCwd !== undefined && rawCwd !== null && typeof rawCwd !== "string") {
        return false;
      }
      if (typeof rawCwd !== "string" || !rawCwd.trim()) return true;
      const trimmed = rawCwd.trim();
      const isHome =
        trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
      return !path.isAbsolute(trimmed) && !isHome;
    },
    onWorkspaceRoots: (paths) => {
      for (const candidate of paths) {
        try {
          if (fs.statSync(candidate).isDirectory()) {
            defaultCwd = candidate;
            return;
          }
        } catch {
          // Ignore nonexistent or inaccessible root paths
        }
      }
    },
  });

  server.registerTool(
    {
      name: "batch_search",
      description:
        "Run read-only text/regex searches, globs, fuzzy path lookups, and read-only git queries concurrently with bounded output.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace root (required if roots/list is unavailable).",
          },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description: "Queries to run concurrently.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["text", "regex", "glob", "fuzzy", "git"],
                },
                pattern: {
                  type: "string",
                  description: "Text, regex, fuzzy path, glob (* / {a,b}), or read-only git args.",
                },
                path: {
                  type: "string",
                  description: "Subdirectory or file relative to cwd.",
                },
                glob: {
                  type: "string",
                  description: "File filter glob (e.g. '*.ts').",
                },
                multiline: {
                  type: "boolean",
                  description: "Match across lines.",
                },
                outputMode: {
                  type: "string",
                  enum: ["content", "files_with_matches", "count"],
                  description: "content (default), files_with_matches, or count.",
                },
                fileType: {
                  type: "string",
                  description: "Language/extension filter (e.g. ts, py).",
                },
                sortBy: {
                  type: "string",
                  enum: ["path", "mtime"],
                  description: "Glob order: path (default) or mtime.",
                },
                caseSensitive: {
                  type: "boolean",
                  description: "Case-sensitive match (default true).",
                },
                contextLines: {
                  type: "integer",
                  minimum: 0,
                  maximum: 5,
                  description: "Context lines (0-5).",
                },
                maxResults: {
                  type: "integer",
                  minimum: 1,
                  maximum: 200,
                  description: "Max results (default 40).",
                },
              },
              required: ["type", "pattern"],
            },
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 8800,
            description: "Output cap (default 8500, max 8800).",
          },
        },
        required: ["queries"],
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<BatchSearchInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runBatchSearch(resolved.value);
    },
  );

  server.registerTool(
    () => buildApplyEditsToolDefinition(hostCompat),
    async (args) => {
      const resolved = resolveToolArgs<ApplyEditsInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runApplyEdits(resolved.value);
    },
  );

  server.registerTool(
    {
      name: "read_slices",
      description:
        "Batch-extract symbol/section outlines (TS/JS/HTML/Vue/Svelte/CSS/Python/GDScript/Go/Rust/Java/MD/JSON/YAML) across files (prefer 10-20 files/batch, max 40) in one call, plus optional tiny <=120-line slices. For reading >150 lines of known ranges, prefer parallel built-in read_file(StartLine, EndLine) (46KB/call inline, 0 remote check).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace root directory for relative paths (required if the host does not report MCP roots/list, e.g. Desktop 2.0 Hub).",
          },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" },
            description: "File paths to extract top-level symbol/section line ranges from (prefer 10-20 per batch for fuller outlines; max 40).",
          },
          slices: {
            type: "array",
            maxItems: 30,
            description: "Optional tiny 1-based inclusive [startLine, endLine] ranges to piggyback (total response hard-capped <= 8800 UTF-8 bytes). For flat shorthand, you may also pass 'lineRanges'.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                ranges: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "array",
                    minItems: 2,
                    maxItems: 2,
                    items: { type: "integer", minimum: 1 },
                  },
                },
              },
              required: ["path", "ranges"],
            },
          },
          lineRanges: {
            type: "array",
            maxItems: 30,
            items: { type: "string" },
            description: "Flat shorthand for tiny slices: 'path:start-end' or 'path:start1-end1,start2-end2' (e.g. 'src/server.ts:1-50,120-160').",
          },
          maxChars: {
            type: "integer",
            minimum: 1000,
            maximum: 8800,
            description: "Total character cap (default 8500; hard inline UTF-8 cap <= 8800 bytes to prevent output.txt spills).",
          },
        },
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<ReadSlicesInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runReadSlices(resolved.value);
    },
  );

  server.registerTool(
    {
      name: "quick_outline",
      description:
        "Fast symbol/section outline extractor for unknown large files (TS/JS/HTML/Vue/Svelte/CSS/Python/GDScript/Go/Rust/Java/MD/JSON/YAML; prefer 10-20 files/batch, max 40). Flat paths-only schema for mapping line ranges before parallel built-in read_file(StartLine, EndLine).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace root directory for relative paths (required if the host does not report MCP roots/list, e.g. Desktop 2.0 Hub).",
          },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            items: { type: "string" },
            description: "File paths to extract top-level symbol/section line ranges from (prefer 10-20 per batch; max 40).",
          },
          maxChars: {
            type: "integer",
            minimum: 1000,
            maximum: 8800,
            description: "Total character cap (default 8500; hard inline UTF-8 cap <= 8800 bytes).",
          },
        },
        required: ["paths"],
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<QuickOutlineInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runQuickOutline(resolved.value);
    },
  );

  server.registerTool(
    {
      name: "run_checks",
      description:
        "Run multiple independent non-interactive shell commands concurrently under one check (build/typecheck/lint/test with outputMode 'compact', or diagnostic/audit scripts with outputMode 'full').",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace root directory for relative paths (required if the host does not report MCP roots/list, e.g. Desktop 2.0 Hub).",
          },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description: "Commands to execute concurrently.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short label (e.g. 'typecheck')." },
                command: { type: "string", description: "Shell command to run." },
                cwd: { type: "string", description: "Optional working directory override." },
                timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
              },
              required: ["command"],
            },
          },
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 8,
            description: "Max parallel commands (default 4).",
          },
          timeoutSec: {
            type: "integer",
            minimum: 1,
            maximum: MCP_CALL_BUDGET_SEC,
            description: `Default per-command timeout in seconds (default 60). All commands of one call share a ${MCP_CALL_BUDGET_SEC}s budget because agy drops MCP results after 180s; commands that cannot start within it are reported as not run.`,
          },
          outputMode: {
            type: "string",
            enum: ["compact", "full"],
            description: "'compact' hides verbose pass logs (default); 'full' preserves stdout for diagnostic/inspection commands.",
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 8800,
            description: "Total character cap (default 8000; hard inline UTF-8 cap <= 8800 bytes).",
          },
        },
        required: ["commands"],
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<RunChecksInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runChecks(resolved.value);
    },
  );

  return server;
}

function main(): void {
  const server = createAgyFastServer();
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
