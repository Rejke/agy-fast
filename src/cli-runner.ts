import { runApplyEdits, type ApplyEditsInput } from "./tools/apply-edits.js";
import {
  runBatchSearch,
  type BatchSearchInput,
  type SearchQuery,
} from "./tools/batch-search.js";
import {
  runQuickOutline,
  runReadSlices,
  type QuickOutlineInput,
  type ReadSlicesInput,
} from "./tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./tools/run-checks.js";

export type CliCanonicalTool =
  | "batch_search"
  | "quick_outline"
  | "read_slices"
  | "apply_edits"
  | "run_checks";

export interface CliIo {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  cwd?: string;
}

const MAX_CLI_STDIN_BYTES = 2 * 1024 * 1024;
const IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS = 500;

const TOOL_ALIASES: Record<string, CliCanonicalTool> = {
  search: "batch_search",
  batch_search: "batch_search",
  outline: "quick_outline",
  quick_outline: "quick_outline",
  slice: "read_slices",
  slices: "read_slices",
  read_slices: "read_slices",
  edit: "apply_edits",
  apply_edits: "apply_edits",
  check: "run_checks",
  checks: "run_checks",
  run_checks: "run_checks",
};

export function resolveCliToolAlias(name: string | undefined): CliCanonicalTool | null {
  if (!name) return null;
  return TOOL_ALIASES[name.trim().toLowerCase()] ?? null;
}

export function formatCliUsage(): string {
  return [
    "agy-fast direct CLI mode (for Swarm workers, scripts, and non-MCP environments)",
    "",
    "Usage:",
    "  node <plugin>/dist/mcp-server.mjs --cli <command> [options] [args...]",
    "",
    "Commands (aliases):",
    "  outline | quick_outline <file...> [--cwd <dir>] [--max-chars <N>]",
    "  slice   | read_slices   <path:start-end,...> [--outline <file>] [--cwd <dir>]",
    "  search  | batch_search  [--text <p>] [--regex <p>] [--glob <p>] [--fuzzy <p>] [--git <cmd>]",
    "                          [--pattern <p>] [--type text|regex|glob|fuzzy|git]",
    "                          [--path <dir>] [--file-type <t>] [--glob-filter <g>]",
    "                          [--output-mode content|files_with_matches|count] [--sort-by path|mtime]",
    "                          [--context <0..5>] [--max-results <N>] [-i|--ignore-case] [--multiline]",
    "                          (modifiers before a query scope only to that query; trailing modifiers apply to all)",
    "  check   | run_checks    <cmd...> [--compact|--full] [--concurrency <N>] [--timeout <sec>]",
    "  edit    | apply_edits   [--best-effort] [--dry-run] [--verify <cmd>] (JSON via --json or stdin)",
    "",
    "JSON input (works for every command using the exact MCP tool schema):",
    "  --json '<json>'         Pass tool arguments JSON object (or shorthand array) inline",
    "  --stdin                 Read tool arguments JSON from stdin (or pipe/heredoc with no positional args)",
    "  --cwd <dir>             Override working directory (defaults to shell CWD)",
    "  --max-chars <N>         Override output character cap (hard UTF-8 ceiling <= 8800 bytes)",
  ].join("\n");
}

function parseIntFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) {
    throw new Error(`Expected integer value after ${flag}`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer value after ${flag}: ${raw}`);
  }
  return n;
}

async function readStdinText(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
  explicitStdin: boolean,
): Promise<string> {
  if (!explicitStdin && stream.isTTY) {
    return "";
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof (stream as { pause?: () => void }).pause === "function") {
        (stream as { pause: () => void }).pause();
      }
      const maybeUnref = (stream as unknown as { unref?: () => void }).unref;
      if (typeof maybeUnref === "function") {
        maybeUnref.call(stream);
      }
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_CLI_STDIN_BYTES) {
        fail(new Error(`stdin payload exceeds ${MAX_CLI_STDIN_BYTES} bytes limit`));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    };

    const onError = (err: Error) => {
      fail(err);
    };

    if (!explicitStdin) {
      firstByteTimer = setTimeout(() => {
        if (totalBytes === 0) {
          if (typeof (stream as { pause?: () => void }).pause === "function") {
            (stream as { pause: () => void }).pause();
          }
          finish("");
        }
      }, IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS);
    }

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    if (typeof (stream as { resume?: () => void }).resume === "function") {
      (stream as { resume: () => void }).resume();
    }
  });
}

function parseJsonPayload(
  rawText: string,
  tool: CliCanonicalTool,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid JSON input for '${tool}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (Array.isArray(parsed)) {
    if (tool === "batch_search") return { queries: parsed };
    if (tool === "apply_edits") return { edits: parsed };
    if (tool === "quick_outline") return { paths: parsed };
    if (tool === "read_slices") {
      if (parsed.every((item) => typeof item === "string")) {
        return { lineRanges: parsed };
      }
      return { slices: parsed };
    }
    if (tool === "run_checks") {
      return {
        commands: parsed.map((item) =>
          typeof item === "string" ? { command: item } : item,
        ),
      };
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { ...(parsed as Record<string, unknown>) };
  }
  throw new Error(`JSON input for '${tool}' must be an object (or shorthand array).`);
}

interface SearchQueryModifiers {
  path?: string;
  fileType?: string;
  glob?: string;
  outputMode?: "content" | "files_with_matches" | "count";
  sortBy?: "path" | "mtime";
  contextLines?: number;
  maxResults?: number;
  caseSensitive?: boolean;
  multiline?: boolean;
}

function applySearchModifiers(
  q: SearchQuery,
  mods: SearchQueryModifiers,
): SearchQuery {
  return {
    ...q,
    ...(mods.path !== undefined && q.path === undefined ? { path: mods.path } : {}),
    ...(mods.fileType !== undefined && q.fileType === undefined
      ? { fileType: mods.fileType }
      : {}),
    ...(mods.glob !== undefined && q.glob === undefined ? { glob: mods.glob } : {}),
    ...(mods.outputMode !== undefined && q.outputMode === undefined
      ? { outputMode: mods.outputMode }
      : {}),
    ...(mods.sortBy !== undefined && q.sortBy === undefined ? { sortBy: mods.sortBy } : {}),
    ...(mods.contextLines !== undefined && q.contextLines === undefined
      ? { contextLines: mods.contextLines }
      : {}),
    ...(mods.maxResults !== undefined && q.maxResults === undefined
      ? { maxResults: mods.maxResults }
      : {}),
    ...(mods.caseSensitive !== undefined && q.caseSensitive === undefined
      ? { caseSensitive: mods.caseSensitive }
      : {}),
    ...(mods.multiline !== undefined && q.multiline === undefined
      ? { multiline: mods.multiline }
      : {}),
  };
}

const SEARCH_QUERY_TYPES = new Set<SearchQuery["type"]>([
  "text",
  "regex",
  "glob",
  "fuzzy",
  "git",
]);

const VALUE_LONG_FLAGS = new Set([
  "--cwd",
  "--max-chars",
  "--json",
  "--text",
  "--regex",
  "--glob",
  "--fuzzy",
  "--git",
  "--pattern",
  "--type",
  "--path",
  "--file-type",
  "--glob-filter",
  "--output-mode",
  "--sort-by",
  "--context",
  "--max-results",
  "--outline",
  "--concurrency",
  "--timeout",
  "--verify",
  "--verify-timeout",
  "--max-verify-chars",
]);

interface ParsedCliOptions {
  showHelp: boolean;
  cwd?: string;
  maxChars?: number;
  jsonRaw?: string;
  explicitStdin: boolean;
  positionals: string[];
  // search flags
  searchQueries: SearchQuery[];
  implicitTypeQueryIndices: Set<number>;
  trailingSearchType?: SearchQuery["type"];
  trailingSearchMods: SearchQueryModifiers;
  // slice flags
  outlineFiles: string[];
  // check flags
  outputMode?: "compact" | "full";
  concurrency?: number;
  timeoutSec?: number;
  // edit flags
  bestEffort?: boolean;
  dryRun?: boolean;
  verify?: string;
  verifyTimeoutSec?: number;
  maxVerifyChars?: number;
}

function parseToolFlags(tool: CliCanonicalTool, rawArgs: string[]): ParsedCliOptions {
  const opts: ParsedCliOptions = {
    showHelp: false,
    explicitStdin: false,
    positionals: [],
    searchQueries: [],
    implicitTypeQueryIndices: new Set<number>(),
    trailingSearchMods: {},
    outlineFiles: [],
  };
  let pendingMods: SearchQueryModifiers = {};
  let pendingType: SearchQuery["type"] | undefined;
  const pushScopedQuery = (base: SearchQuery, explicitType: boolean) => {
    const idx = opts.searchQueries.length;
    opts.searchQueries.push(applySearchModifiers(base, pendingMods));
    if (!explicitType) {
      opts.implicitTypeQueryIndices.add(idx);
    }
    pendingMods = {};
    pendingType = undefined;
  };

  let afterDoubleDash = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const rawArg = rawArgs[i]!;
    if (afterDoubleDash) {
      if (tool === "batch_search") {
        const explicit = pendingType !== undefined;
        pushScopedQuery({ type: pendingType ?? "text", pattern: rawArg }, explicit);
      } else {
        opts.positionals.push(rawArg);
      }
      continue;
    }
    if (rawArg === "--") {
      afterDoubleDash = true;
      continue;
    }

    let arg = rawArg;
    let inlineValue: string | undefined;
    if (rawArg.startsWith("--")) {
      const eqIdx = rawArg.indexOf("=");
      if (eqIdx > 2) {
        const candidateFlag = rawArg.slice(0, eqIdx);
        if (VALUE_LONG_FLAGS.has(candidateFlag)) {
          arg = candidateFlag;
          inlineValue = rawArg.slice(eqIdx + 1);
        }
      }
    }

    const consumeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = rawArgs[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value after ${arg}`);
      }
      i += 1;
      return next;
    };

    if (arg === "--help" || arg === "-h") {
      opts.showHelp = true;
      continue;
    }
    if (arg === "--cwd") {
      opts.cwd = consumeValue();
      continue;
    }
    if (arg === "--max-chars") {
      opts.maxChars = parseIntFlag(arg, consumeValue());
      continue;
    }
    if (arg === "--json") {
      opts.jsonRaw = consumeValue();
      continue;
    }
    if (arg === "--stdin") {
      opts.explicitStdin = true;
      continue;
    }

    if (tool === "batch_search") {
      if (arg === "--text" || arg === "-t") {
        pushScopedQuery({ type: "text", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--regex" || arg === "-r") {
        pushScopedQuery({ type: "regex", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--glob" || arg === "-g") {
        pushScopedQuery({ type: "glob", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--fuzzy" || arg === "-f") {
        pushScopedQuery({ type: "fuzzy", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--git") {
        pushScopedQuery({ type: "git", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--type") {
        const rawType = consumeValue().trim().toLowerCase();
        if (!SEARCH_QUERY_TYPES.has(rawType as SearchQuery["type"])) {
          throw new Error(
            `Invalid --type: ${rawType} (expected text, regex, glob, fuzzy, or git)`,
          );
        }
        pendingType = rawType as SearchQuery["type"];
        continue;
      }
      if (arg === "--pattern") {
        const explicit = pendingType !== undefined;
        pushScopedQuery({ type: pendingType ?? "text", pattern: consumeValue() }, explicit);
        continue;
      }
      if (arg === "--path" || arg === "-p") {
        pendingMods.path = consumeValue();
        continue;
      }
      if (arg === "--file-type") {
        pendingMods.fileType = consumeValue();
        continue;
      }
      if (arg === "--glob-filter") {
        pendingMods.glob = consumeValue();
        continue;
      }
      if (arg === "--output-mode") {
        const mode = consumeValue();
        if (mode !== "content" && mode !== "files_with_matches" && mode !== "count") {
          throw new Error(`Invalid --output-mode: ${mode}`);
        }
        pendingMods.outputMode = mode;
        continue;
      }
      if (arg === "--sort-by") {
        const sortBy = consumeValue();
        if (sortBy !== "path" && sortBy !== "mtime") {
          throw new Error(`Invalid --sort-by: ${sortBy}`);
        }
        pendingMods.sortBy = sortBy;
        continue;
      }
      if (arg === "--context" || arg === "-C") {
        pendingMods.contextLines = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--max-results") {
        pendingMods.maxResults = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--ignore-case" || arg === "-i") {
        pendingMods.caseSensitive = false;
        continue;
      }
      if (arg === "--multiline") {
        pendingMods.multiline = true;
        continue;
      }
    } else if (tool === "read_slices") {
      if (arg === "--outline" || arg === "-o") {
        opts.outlineFiles.push(consumeValue());
        continue;
      }
    } else if (tool === "run_checks") {
      if (arg === "--compact") {
        opts.outputMode = "compact";
        continue;
      }
      if (arg === "--full") {
        opts.outputMode = "full";
        continue;
      }
      if (arg === "--output-mode") {
        const mode = consumeValue();
        if (mode !== "compact" && mode !== "full") {
          throw new Error(`Invalid --output-mode for check: ${mode}`);
        }
        opts.outputMode = mode;
        continue;
      }
      if (arg === "--concurrency") {
        opts.concurrency = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--timeout") {
        opts.timeoutSec = parseIntFlag(arg, consumeValue());
        continue;
      }
    } else if (tool === "apply_edits") {
      if (arg === "--best-effort") {
        opts.bestEffort = true;
        continue;
      }
      if (arg === "--dry-run") {
        opts.dryRun = true;
        continue;
      }
      if (arg === "--verify") {
        opts.verify = consumeValue();
        continue;
      }
      if (arg === "--verify-timeout") {
        opts.verifyTimeoutSec = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--max-verify-chars") {
        opts.maxVerifyChars = parseIntFlag(arg, consumeValue());
        continue;
      }
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option '${rawArg}' for '${tool}'. Run with '--cli --help' for usage.`);
    }
    if (tool === "batch_search") {
      const explicit = pendingType !== undefined;
      pushScopedQuery({ type: pendingType ?? "text", pattern: rawArg }, explicit);
    } else {
      opts.positionals.push(rawArg);
    }
  }

  opts.trailingSearchType = pendingType;
  opts.trailingSearchMods = pendingMods;
  return opts;
}

export async function runAgyFastCli(
  argv: string[],
  io: CliIo = {},
): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const defaultCwd = io.cwd ?? process.cwd();

  const cmdArg = argv[0];
  if (!cmdArg || cmdArg === "--help" || cmdArg === "-h" || cmdArg === "help") {
    stdout.write(`${formatCliUsage()}\n`);
    return 0;
  }

  const rest = argv.slice(1);
  const tool = resolveCliToolAlias(cmdArg);
  if (!tool) {
    stderr.write(
      `Error: unknown --cli command '${cmdArg}'. Expected one of: search, outline, slice, edit, check (or --help).\n`,
    );
    return 1;
  }

  let opts: ParsedCliOptions;
  try {
    opts = parseToolFlags(tool, rest);
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (opts.showHelp) {
    stdout.write(`${formatCliUsage()}\n`);
    return 0;
  }

  const hasShorthandArgs =
    opts.positionals.length > 0 ||
    opts.searchQueries.length > 0 ||
    opts.outlineFiles.length > 0;

  let jsonInput: Record<string, unknown> | null = null;
  try {
    if (opts.jsonRaw !== undefined) {
      jsonInput = parseJsonPayload(opts.jsonRaw, tool);
    } else if (opts.explicitStdin || !hasShorthandArgs) {
      const stdinText = (await readStdinText(stdin, opts.explicitStdin)).trim();
      if (stdinText) {
        jsonInput = parseJsonPayload(stdinText, tool);
      }
    }
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let result: { text: string; isError: boolean };
  const effectiveCwd = opts.cwd ?? (typeof jsonInput?.cwd === "string" ? jsonInput.cwd : defaultCwd);

  if (tool === "batch_search") {
    let payload: BatchSearchInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as BatchSearchInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      const queries: SearchQuery[] = [
        ...opts.searchQueries.map((q, idx): SearchQuery =>
          opts.trailingSearchType !== undefined && opts.implicitTypeQueryIndices.has(idx)
            ? { ...q, type: opts.trailingSearchType }
            : q,
        ),
        ...opts.positionals.map(
          (pattern): SearchQuery => ({ type: opts.trailingSearchType ?? "text", pattern }),
        ),
      ].map((q) => applySearchModifiers(q, opts.trailingSearchMods));
      if (queries.length === 0) {
        stderr.write(
          "Error: 'search' requires at least one query (--text/--regex/--glob/--fuzzy/--git/--pattern, --json, or JSON on stdin).\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        queries,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runBatchSearch(payload);
  } else if (tool === "quick_outline") {
    let payload: QuickOutlineInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as QuickOutlineInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          "Error: 'outline' requires one or more file paths (e.g. --cli outline src/a.ts src/b.ts) or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        paths: opts.positionals,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runQuickOutline(payload);
  } else if (tool === "read_slices") {
    let payload: ReadSlicesInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as ReadSlicesInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0 && opts.outlineFiles.length === 0) {
        stderr.write(
          "Error: 'slice' requires lineRanges specs (e.g. src/a.ts:1-60), --outline <file>, or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        ...(opts.outlineFiles.length > 0 ? { outlines: opts.outlineFiles } : {}),
        ...(opts.positionals.length > 0 ? { lineRanges: opts.positionals } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runReadSlices(payload);
  } else if (tool === "apply_edits") {
    if (!jsonInput) {
      stderr.write(
        "Error: 'edit' requires JSON input via --json or stdin (e.g. {\"edits\":[...],\"bestEffort\":true}).\n",
      );
      return 1;
    }
    const effectiveMaxVerifyChars =
      opts.maxVerifyChars ??
      (opts.maxChars !== undefined
        ? Math.max(300, Math.min(7500, opts.maxChars))
        : undefined);
    const payload: ApplyEditsInput = {
      ...(jsonInput as unknown as ApplyEditsInput),
      cwd: effectiveCwd,
      ...(opts.bestEffort !== undefined ? { bestEffort: opts.bestEffort } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
      ...(opts.verifyTimeoutSec !== undefined
        ? { verifyTimeoutSec: opts.verifyTimeoutSec }
        : {}),
      ...(effectiveMaxVerifyChars !== undefined
        ? { maxVerifyChars: effectiveMaxVerifyChars }
        : {}),
    };
    result = await runApplyEdits(payload);
  } else {
    let payload: RunChecksInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as RunChecksInput),
        cwd: effectiveCwd,
        ...(opts.outputMode !== undefined ? { outputMode: opts.outputMode } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          "Error: 'check' requires one or more shell command strings (e.g. --cli check \"npm run typecheck\" \"npm test\") or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        commands: opts.positionals.map((command) => ({ command })),
        ...(opts.outputMode !== undefined ? { outputMode: opts.outputMode } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runChecks(payload);
  }

  stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  return shouldCliExitNonZero(tool, result) ? 1 : 0;
}

export function shouldCliExitNonZero(
  tool: CliCanonicalTool,
  result: { text: string; isError: boolean },
): boolean {
  return (
    result.isError ||
    (tool === "run_checks" &&
      /^Checks:\s+\d+\/\d+\s+passed,\s+(?:[1-9]\d*\s+failed|[1-9]\d*\s+not run)\b/.test(
        result.text,
      )) ||
    (tool === "apply_edits" &&
      /(?:^|\n)Verify \[(?:FAIL|TIMEOUT|ERROR)\b/.test(result.text))
  );
}
