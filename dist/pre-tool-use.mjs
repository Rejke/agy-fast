// agy-fast PreToolUse Hook (bundled zero-dependency ESM)


// src/utils/quota-hooks.ts
import path2 from "node:path";

// src/utils/hook-io.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
var DEFAULT_MAX_STDIN_BYTES = 256 * 1024;
function getHookHomeDir(env = process.env) {
  return process.platform === "win32" ? env.USERPROFILE || env.HOME || os.homedir() : env.HOME || env.USERPROFILE || os.homedir();
}
function getHookCacheDir(env = process.env) {
  const custom = env.AGY_FAST_CACHE_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(getHookHomeDir(env), ".gemini", "cache", "agy-fast");
}
async function readHookConfig(env = process.env) {
  try {
    const cfgPath = path.join(getHookCacheDir(env), "config.json");
    const raw = await fs.readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return {};
}
async function readStdin(timeoutMs = 1500, maxBytes = DEFAULT_MAX_STDIN_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        finish();
        return;
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        totalBytes += remaining;
        finish();
      } else {
        chunks.push(buf);
        totalBytes += buf.length;
      }
    };
    const onEnd = () => finish();
    const onError = () => finish();
    const ignoreLateError = () => {
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      process.stdin.off("error", onError);
      process.stdin.on("error", ignoreLateError);
      process.stdin.pause();
      if (typeof process.stdin.unref === "function") {
        process.stdin.unref();
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("close", onEnd);
    process.stdin.on("error", onError);
  });
}
function writeAndExit(payload) {
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    process.exit(0);
  };
  const failsafe = setTimeout(done, 150);
  failsafe.unref();
  process.stdout.on("error", done);
  try {
    process.stdout.write(payload, done);
  } catch {
    done();
  }
}

// src/utils/transcript-context.ts
import { promises as fs2 } from "node:fs";
var DEFAULT_IMAGE_GUARD_TOKENS = 15e4;
var INITIAL_TAIL_CHUNK_BYTES = 128 * 1024;
var MAX_CHUNK_BYTES = 512 * 1024;
var DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024;
var PLANNER_MARKER = Buffer.from("PLANNER_RESPONSE", "utf8");
function parseFiniteNonNegativeInt(val) {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) return null;
  return Math.floor(val);
}
function parseTokenThreshold(raw) {
  if (raw === void 0 || raw === null) return null;
  if (raw === false) return 0;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const norm = raw.trim().toLowerCase();
    if (!norm) return null;
    if (norm === "0" || norm === "off" || norm === "false" || norm === "disabled") {
      return 0;
    }
    const cleaned = norm.replace(/_/g, "");
    if (!/^\d+$/.test(cleaned)) return null;
    const n = Number.parseInt(cleaned, 10);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}
function resolveTokenThreshold(envValue, configValue, defaultValue) {
  const fromEnv = parseTokenThreshold(envValue);
  if (fromEnv !== null) return fromEnv;
  const fromCfg = parseTokenThreshold(configValue);
  if (fromCfg !== null) return fromCfg;
  return defaultValue;
}
function parsePlannerResponseLine(lineBuf) {
  if (lineBuf.length === 0 || !lineBuf.includes(PLANNER_MARKER)) return null;
  let obj;
  try {
    const parsed = JSON.parse(lineBuf.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed;
  } catch {
    return null;
  }
  if (obj.type !== "PLANNER_RESPONSE") return null;
  const inputTokens = parseFiniteNonNegativeInt(obj.input_tokens ?? obj.inputTokens);
  const cacheReadTokens = parseFiniteNonNegativeInt(
    obj.cache_read_tokens ?? obj.cacheReadTokens
  );
  if (inputTokens === null && cacheReadTokens === null) return null;
  const total = (inputTokens ?? 0) + (cacheReadTokens ?? 0);
  if (total <= 0) return null;
  const stepIndex = parseFiniteNonNegativeInt(obj.step_index ?? obj.stepIndex);
  const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : void 0;
  return {
    contextTokens: total,
    inputTokens: inputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    stepIndex,
    model
  };
}
function scanBufferBackwardsForPlanner(buf) {
  let end = buf.length;
  while (end > 0) {
    const nl = buf.lastIndexOf(10, end - 1);
    const start = nl === -1 ? 0 : nl + 1;
    let lineEnd = end;
    if (lineEnd > start && buf[lineEnd - 1] === 13) {
      lineEnd--;
    }
    if (lineEnd > start) {
      const hit = parsePlannerResponseLine(buf.subarray(start, lineEnd));
      if (hit) return hit;
    }
    end = nl;
  }
  return null;
}
async function readExactChunk(fh, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const res = await fh.read(buf, filled, length - filled, offset + filled);
    if (res.bytesRead <= 0) break;
    filled += res.bytesRead;
  }
  return filled === length ? buf : buf.subarray(0, filled);
}
async function readLatestTranscriptContext(transcriptPath, options = {}) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  const trimmed = transcriptPath.trim();
  if (!trimmed) return null;
  const maxTailBytes = Math.max(
    4096,
    options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES
  );
  let chunkSize = Math.max(
    1024,
    Math.min(options.initialChunkBytes ?? INITIAL_TAIL_CHUNK_BYTES, maxTailBytes)
  );
  let fh = null;
  try {
    fh = await fs2.open(trimmed, "r");
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size <= 0) return null;
    let pos = stat.size;
    let totalRead = 0;
    let trailingPartial = Buffer.alloc(0);
    while (pos > 0 && totalRead < maxTailBytes) {
      const remainingBudget = maxTailBytes - totalRead;
      const toRead = Math.min(chunkSize, pos, remainingBudget);
      const start = pos - toRead;
      const chunk = await readExactChunk(fh, start, toRead);
      if (chunk.length === 0) break;
      pos = start;
      totalRead += chunk.length;
      const combined = trailingPartial.length > 0 ? Buffer.concat([chunk, trailingPartial]) : chunk;
      if (pos === 0) {
        return scanBufferBackwardsForPlanner(combined);
      }
      const firstNl = combined.indexOf(10);
      if (firstNl === -1) {
        trailingPartial = combined;
      } else {
        trailingPartial = combined.subarray(0, firstNl);
        const completeTail = combined.subarray(firstNl + 1);
        const found = scanBufferBackwardsForPlanner(completeTail);
        if (found) return found;
      }
      chunkSize = Math.min(chunkSize * 2, MAX_CHUNK_BYTES);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) {
      await fh.close().catch(() => {
      });
    }
  }
}

// src/utils/quota-hooks.ts
var STATE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var BLOCKED_IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
  ".tiff",
  ".tif"
]);
function formatTokensCompact(tokens) {
  if (tokens >= 1e3) {
    return `${Math.round(tokens / 1e3)}k`;
  }
  return String(tokens);
}
function getTranscriptPath(payload) {
  if (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) {
    return payload.transcriptPath.trim();
  }
  if (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) {
    return payload.transcript_path.trim();
  }
  return "";
}
function parseToolArgs(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}
function extractFilePathArg(args) {
  for (const key of [
    "Path",
    "path",
    "AbsolutePath",
    "absolutePath",
    "file_path",
    "filePath"
  ]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}
function isImageFilePath(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  const ext = path2.posix.extname(normalized).toLowerCase();
  return BLOCKED_IMAGE_EXTENSIONS.has(ext);
}
function detectImageToolCall(payload) {
  const toolCall = payload.toolCall ?? payload.tool_call;
  if (!toolCall || typeof toolCall !== "object") return null;
  const rawName = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
  if (!rawName) return null;
  const normName = rawName.toLowerCase();
  const args = parseToolArgs(toolCall.args ?? toolCall.arguments);
  if (!args) return null;
  if (normName === "read_file" || normName === "view_file") {
    const targetPath = extractFilePathArg(args);
    if (targetPath && isImageFilePath(targetPath)) {
      return {
        kind: "read_file",
        toolName: rawName,
        target: targetPath
      };
    }
    return null;
  }
  if (normName === "preview_snapshot" || normName.endsWith("_preview_snapshot")) {
    if (args.includeImage === true || args.include_image === true) {
      return {
        kind: "preview_snapshot",
        toolName: rawName,
        target: rawName
      };
    }
    return null;
  }
  return null;
}
async function evaluatePreToolUse(payload, options = {}) {
  const match = detectImageToolCall(payload);
  if (!match) return {};
  const env = options.env ?? process.env;
  const transcriptPath = getTranscriptPath(payload);
  if (!transcriptPath) return {};
  const cfg = await readHookConfig(env);
  const threshold = resolveTokenThreshold(
    env.AGY_FAST_IMAGE_GUARD_TOKENS,
    cfg.imageGuardTokens,
    DEFAULT_IMAGE_GUARD_TOKENS
  );
  if (threshold <= 0) return {};
  const snapshot = await readLatestTranscriptContext(
    transcriptPath,
    options.tailOptions
  );
  if (!snapshot || snapshot.contextTokens < threshold) {
    return {};
  }
  const currentLabel = formatTokensCompact(snapshot.contextTokens);
  const thresholdLabel = formatTokensCompact(threshold);
  const callDesc = match.kind === "read_file" ? `${match.toolName}(${path2.posix.basename(match.target.replace(/\\/g, "/"))})` : `${match.toolName}(includeImage: true)`;
  return {
    decision: "deny",
    reason: `[agy-fast image guard] Blocked ${callDesc} at ~${currentLabel} context tokens (limit: ${thresholdLabel}) to prevent prompt-cache invalidation and 3-7x TTFT spikes. Delegate visual inspection of this image to a subagent (e.g. invoke_subagent) and have it return text-only findings (values, selectors, file paths, concrete fixes).`
  };
}
async function runPreToolUseCli() {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      writeAndExit("{}\n");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      writeAndExit("{}\n");
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      writeAndExit("{}\n");
      return;
    }
    const result = await evaluatePreToolUse(payload);
    writeAndExit(`${JSON.stringify(result)}
`);
  } catch {
    writeAndExit("{}\n");
  }
}

// src/pre-tool-use.ts
void runPreToolUseCli();
