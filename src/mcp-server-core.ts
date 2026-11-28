import fs from "node:fs";
import os from "node:os";
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

const SERVER_VERSION = "0.3.2";
const DEFAULT_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const ALL_MCP_TOOLS = [
  "batch_search",
  "apply_edits",
  "read_slices",
  "quick_outline",
  "run_checks",
] as const;

export type AgyFastToolName = (typeof ALL_MCP_TOOLS)[number];
const ALL_MCP_TOOL_SET = new Set<string>(ALL_MCP_TOOLS);

export type SchemaCompatMode = "standard" | "minimal";

export interface AgyFastServerOptions {
  env?: NodeJS.ProcessEnv;
  configEditsFormat?: EditsFormatMode;
  schemaCompat?: SchemaCompatMode;
  processCwd?: () => string;
  pluginRoot?: string;
  tools?: readonly AgyFastToolName[] | ReadonlySet<AgyFastToolName>;
}

export function parseToolFilter(
  raw: string,
  sourceLabel = "--tools",
): Set<AgyFastToolName> {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new Error(
      `Invalid ${sourceLabel} value "${raw}". Expected comma-separated tool names from: ${ALL_MCP_TOOLS.join(", ")}.`,
    );
  }
  const invalid = parts.filter((p) => !ALL_MCP_TOOL_SET.has(p));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown tool(s) in ${sourceLabel}: ${invalid.join(", ")}. Valid tools: ${ALL_MCP_TOOLS.join(", ")}.`,
    );
  }
  return new Set(parts as AgyFastToolName[]);
}

function normalizeProvidedTools(
  tools: Iterable<AgyFastToolName>,
): Set<AgyFastToolName> {
  const list = [...tools];
  if (list.length === 0) {
    throw new Error(
      `Invalid options.tools value (empty). Expected at least one tool from: ${ALL_MCP_TOOLS.join(", ")}.`,
    );
  }
  const invalid = list.filter((name) => !ALL_MCP_TOOL_SET.has(name));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown tool(s) in options.tools: ${invalid.join(", ")}. Valid tools: ${ALL_MCP_TOOLS.join(", ")}.`,
    );
  }
  return new Set(list);
}

const MINIMAL_SCHEMA_STRIPPED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "multipleOf",
]);

export function parseSchemaCompatMode(raw: unknown): SchemaCompatMode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "standard" || v === "minimal") return v;
  return null;
}

/**
 * Recursively strips JSON Schema range/length constraint keywords (minimum,
 * maximum, minItems, maxItems, etc.) while preserving schema structure and
 * property names (including properties literally named "pattern"). Runtime
 * argument validation inside every tool remains unchanged.
 */
export function sanitizeSchemaToMinimalSubset(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (MINIMAL_SCHEMA_STRIPPED_KEYWORDS.has(key)) continue;
    if (
      key === "properties" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] =
          propSchema !== null &&
          typeof propSchema === "object" &&
          !Array.isArray(propSchema)
            ? sanitizeSchemaToMinimalSubset(propSchema as Record<string, unknown>)
            : propSchema;
      }
      out.properties = props;
    } else if (
      key === "items" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out.items = sanitizeSchemaToMinimalSubset(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? sanitizeSchemaToMinimalSubset(item as Record<string, unknown>)
          : item,
      );
    } else if (value !== null && typeof value === "object") {
      out[key] = sanitizeSchemaToMinimalSubset(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

type ParsedServerCliArgs =
  | { ok: true; help: true }
  | {
      ok: true;
      help: false;
      schemaCompat?: SchemaCompatMode;
      tools?: Set<AgyFastToolName>;
    }
  | { ok: false; error: string };

export function parseMcpServerCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedServerCliArgs {
  let schemaCompat: SchemaCompatMode | undefined;
  let tools: Set<AgyFastToolName> | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      return { ok: true, help: true };
    }
    if (arg === "--tools" || arg.startsWith("--tools=")) {
      let rawTools: string;
      if (arg.startsWith("--tools=")) {
        rawTools = arg.slice("--tools=".length);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          return {
            ok: false,
            error: `Missing value after --tools. Valid tools: ${ALL_MCP_TOOLS.join(", ")}.`,
          };
        }
        rawTools = next;
        i++;
      }
      try {
        tools = parseToolFilter(rawTools, "--tools");
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      continue;
    }
    if (arg === "--schema-compat" || arg.startsWith("--schema-compat=")) {
      const rawValue = arg.startsWith("--schema-compat=")
        ? arg.slice("--schema-compat=".length)
        : argv[++i];
      if (rawValue === undefined || !rawValue.trim()) {
        return {
          ok: false,
          error: "Missing value for --schema-compat (expected: standard | minimal).",
        };
      }
      const parsed = parseSchemaCompatMode(rawValue);
      if (!parsed) {
        return {
          ok: false,
          error: `Invalid --schema-compat value ${JSON.stringify(rawValue)} (expected: standard | minimal).`,
        };
      }
      schemaCompat = parsed;
      continue;
    }
    return {
      ok: false,
      error: `Unknown argument ${JSON.stringify(arg)}. Run with --help for usage.`,
    };
  }
  if (tools === undefined) {
    const envTools = env.AGY_FAST_TOOLS?.trim();
    if (envTools) {
      try {
        tools = parseToolFilter(envTools, "AGY_FAST_TOOLS");
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  return { ok: true, help: false, schemaCompat, tools };
}

export function parseServerCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { help: boolean; schemaCompat?: SchemaCompatMode; tools?: Set<AgyFastToolName> } {
  const parsed = parseMcpServerCliArgs(argv, env);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (parsed.help) {
    return { help: true };
  }
  return {
    help: false,
    schemaCompat: parsed.schemaCompat,
    tools: parsed.tools,
  };
}

export function printMcpServerHelp(): void {
  process.stdout.write(
    [
      "agy-fast MCP stdio server",
      "",
      "Usage:",
      "  agy-fast-mcp [--tools <tool1,tool2,...>] [--schema-compat <standard|minimal>]",
      "  agy-fast mcp [--tools <tool1,tool2,...>] [--schema-compat <standard|minimal>]",
      "  agy-fast-mcp --cli <search|outline|slice|edit|check> [args...]",
      "",
      "Options:",
      "  --tools <list>",
      "      Comma-separated subset of MCP tools to expose",
      `      (valid: ${ALL_MCP_TOOLS.join(", ")}; env: AGY_FAST_TOOLS).`,
      "  --schema-compat <standard|minimal>",
      "      Schema keyword profile for tools/list (env: AGY_FAST_SCHEMA_COMPAT).",
      "      'minimal' strips numeric/array range keywords (minimum/maximum/minItems/maxItems)",
      "      for strict JSON Schema subset hosts while keeping all runtime checks intact.",
      "  -h, --help",
      "      Show this help message.",
      "",
    ].join("\n"),
  );
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

function isSameDir(a: string, b: string): boolean {
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// A host that reports no MCP roots may start the server somewhere that is never a workspace:
// the filesystem root or the user's home directory itself. Resolving an omitted or relative
// `cwd` there writes files and runs commands outside any project, so ask for `cwd` instead.
function detectNonWorkspaceCwd(
  env: NodeJS.ProcessEnv,
  currentCwd: string,
): { dir: string; place: string } | null {
  const canonCwd = canonicalizeDir(currentCwd);
  if (path.parse(canonCwd).root === canonCwd) {
    return { dir: canonCwd, place: "the filesystem root" };
  }
  const isFullAbsPath = (p: string): boolean =>
    process.platform === "win32"
      ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(p)
      : path.isAbsolute(p);
  const driveHome =
    process.platform === "win32" &&
    typeof env.HOMEDRIVE === "string" &&
    typeof env.HOMEPATH === "string" &&
    env.HOMEDRIVE.trim() &&
    env.HOMEPATH.trim()
      ? `${env.HOMEDRIVE.trim()}${env.HOMEPATH.trim()}`
      : "";
  const homes = [env.HOME, env.USERPROFILE, driveHome]
    .map((h) => (typeof h === "string" ? h.trim() : ""))
    .filter((h) => h && isFullAbsPath(h));
  if (homes.length === 0 && env === process.env) {
    try {
      const osHome = os.homedir();
      if (isFullAbsPath(osHome)) homes.push(osHome);
    } catch {
      // No home directory to compare against
    }
  }
  for (const home of homes) {
    if (home && isSameDir(canonCwd, canonicalizeDir(home))) {
      return { dir: canonCwd, place: "the home directory" };
    }
  }
  return null;
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
          'JSON array string (1-50 files): [{"path","hunks"?:[{"target","replacement","startLine"?,"endLine"?,"replaceAll"?}],"create"?,"overwrite"?}]. Exact target in 1-based window (all if replaceAll). Nonempty hunks XOR full-file create. overwrite allows replacing via create. Native arrays also work, but call_mcp_tool can turn long ones into [].',
      }
    : {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            hunks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  target: { type: "string" },
                  replacement: { type: "string" },
                  startLine: { type: "integer", minimum: 1 },
                  endLine: { type: "integer", minimum: 1 },
                  replaceAll: { type: "boolean" },
                },
                required: ["target", "replacement"],
              },
            },
            create: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["path"],
        },
      };

  const baseDesc = `Atomic multi-file edits. bestEffort writes valid files atomically per file, gives closest lines, skips verify on failure. dryRun=false (true validates only). verify shell in cwd after writes (60s/4000 chars default, agy drops at 180s). 8800 UTF-8 bytes total. Absolute cwd if no roots/list (Desktop 2.0 Hub).`;

  return {
    name: "apply_edits",
    description: preferStringEdits
      ? baseDesc
      : `${baseDesc} Exact target in 1-based window (all if replaceAll). Nonempty hunks XOR full-file create. overwrite allows replacing via create.`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        edits: editsSchema,
        dryRun: { type: "boolean" },
        bestEffort: { type: "boolean" },
        verify: { type: "string" },
        verifyTimeoutSec: {
          type: "integer",
          minimum: 1,
          maximum: MCP_CALL_BUDGET_SEC,
        },
        maxVerifyChars: {
          type: "integer",
          minimum: 300,
          maximum: 7500,
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
  const selectedTools =
    options.tools !== undefined ? normalizeProvidedTools(options.tools) : undefined;
  const shouldRegister = (name: AgyFastToolName): boolean =>
    !selectedTools || selectedTools.has(name);
  const schemaCompat: SchemaCompatMode =
    options.schemaCompat ??
    parseSchemaCompatMode(env.AGY_FAST_SCHEMA_COMPAT) ??
    "standard";
  const applySchemaCompat = (def: McpToolDefinition): McpToolDefinition =>
    schemaCompat === "minimal"
      ? { ...def, inputSchema: sanitizeSchemaToMinimalSubset(def.inputSchema) }
      : def;
  let hostCompat = resolveHostCompat({
    env,
    configEditsFormat: savedEditsFormat,
  });

  // agy starts plugin servers in the plugin directory; resolve omitted or relative
  // tool `cwd` values against the first valid workspace root without mutating process.cwd().
  // Never silently fall back to the installed plugin directory, the filesystem root or the
  // home directory when roots/list is unavailable.
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
      const nonWorkspace = detectNonWorkspaceCwd(env, getProcessCwd());
      if (nonWorkspace) {
        return {
          ok: false,
          error: `Error: 'cwd' is required because this host did not report a workspace root via MCP roots/list and the MCP server started in ${nonWorkspace.place} (${nonWorkspace.dir}), which is not a workspace. Pass the active workspace root explicitly in 'cwd'.`,
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
      const nonWorkspace = detectNonWorkspaceCwd(env, getProcessCwd());
      if (nonWorkspace) {
        return {
          ok: false,
          error: `Error: 'cwd' must be an absolute workspace path because this host did not report a workspace root via MCP roots/list and the MCP server started in ${nonWorkspace.place} (${nonWorkspace.dir}), which is not a workspace. Received relative cwd: ${JSON.stringify(rawCwd)}.`,
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

  if (shouldRegister("batch_search")) {
    server.registerTool(
    applySchemaCompat({
      name: "batch_search",
      description:
        "Parallel search: literal text, regex, fuzzy paths, glob (*/{a,b}, no |), read-only git. Absolute cwd if no roots/list (Desktop 2.0 Hub). path rel/abs file/dir; glob filters text/regex; fileType lang/ext (text/regex/fuzzy). multiline spans lines (dot too); count/file=lines or multiline occurrences. Defaults: outputMode=content, caseSensitive=true, contextLines=0, maxResults=40, maxChars=8500 (8800B UTF-8 max); glob sortBy=path (mtime newest).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["text", "regex", "glob", "fuzzy", "git"],
                },
                pattern: { type: "string" },
                path: { type: "string" },
                glob: { type: "string" },
                multiline: { type: "boolean" },
                outputMode: {
                  type: "string",
                  enum: ["content", "files_with_matches", "count"],
                },
                fileType: { type: "string" },
                sortBy: { type: "string", enum: ["path", "mtime"] },
                caseSensitive: { type: "boolean" },
                contextLines: { type: "integer", minimum: 0, maximum: 10 },
                maxResults: { type: "integer", minimum: 1, maximum: 200 },
              },
              required: ["type", "pattern"],
            },
          },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 },
        },
        required: ["queries"],
      },
    }),
    async (args) => {
      const resolved = resolveToolArgs<BatchSearchInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runBatchSearch(resolved.value);
    },
  );
  }

  if (shouldRegister("apply_edits")) {
    server.registerTool(
    () => applySchemaCompat(buildApplyEditsToolDefinition(hostCompat)),
    async (args) => {
      const resolved = resolveToolArgs<ApplyEditsInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runApplyEdits(resolved.value);
    },
  );
  }

  if (shouldRegister("read_slices")) {
    server.registerTool(
    applySchemaCompat({
      name: "read_slices",
      description:
        "Batch outlines (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; prefer 10-20, max 40) + tiny <=120-line slices. For >150 known lines total, prefer parallel read_file(StartLine, EndLine) if available (agy: 46KB/call, no remote check). Absolute cwd if no roots/list (Desktop 2.0 Hub). slices: 1-based inclusive [start,end]; lineRanges: 'path:start-end,s2-e2'. maxChars default 8500; 8800 UTF-8 bytes total.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" },
          },
          slices: {
            type: "array",
            maxItems: 30,
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
          },
          maxChars: { type: "integer", minimum: 1000, maximum: 8800 },
        },
      },
    }),
    async (args) => {
      const resolved = resolveToolArgs<ReadSlicesInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runReadSlices(resolved.value);
    },
  );
  }

  if (shouldRegister("quick_outline")) {
    server.registerTool(
    applySchemaCompat({
      name: "quick_outline",
      description:
        "Fast symbol/section line-range outlines for large files (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; prefer 10-20, max 40) before parallel ranged read_file(StartLine, EndLine). Flat paths-only schema. Absolute cwd if no roots/list (Desktop 2.0 Hub). maxChars default 8500; 8800 UTF-8 bytes total.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            items: { type: "string" },
          },
          maxChars: { type: "integer", minimum: 1000, maximum: 8800 },
        },
        required: ["paths"],
      },
    }),
    async (args) => {
      const resolved = resolveToolArgs<QuickOutlineInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runQuickOutline(resolved.value);
    },
  );
  }

  if (shouldRegister("run_checks")) {
    server.registerTool(
    applySchemaCompat({
      name: "run_checks",
      description:
        `Batch >=2 independent non-interactive shell commands concurrently (for 1 lightweight command, prefer run_command). outputMode 'compact' (default) hides pass logs, keeps failures; 'full' keeps passing stdout. concurrency default 4. Per-cmd timeoutSec default 60; shared ${MCP_CALL_BUDGET_SEC}s budget (agy drops results at 180s; commands that cannot start are marked not run). Absolute cwd if no roots/list (Desktop 2.0 Hub); command.cwd overrides; name is label. maxChars default 8000; 8800 UTF-8 bytes total.`,
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
              },
              required: ["command"],
            },
          },
          concurrency: { type: "integer", minimum: 1, maximum: 8 },
          timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
          outputMode: { type: "string", enum: ["compact", "full"] },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 },
        },
        required: ["commands"],
      },
    }),
    async (args) => {
      const resolved = resolveToolArgs<RunChecksInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runChecks(resolved.value);
    },
  );
  }

  return server;
}
