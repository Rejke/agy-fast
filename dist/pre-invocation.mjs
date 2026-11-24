// agy-fast PreInvocation Hook (bundled zero-dependency ESM)


// src/utils/quota-hooks.ts
import crypto from "node:crypto";
import { promises as fs3 } from "node:fs";
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
var DEFAULT_AUTO_COMPACT_TOKENS = 38e4;
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
var COMPACT_STATE_DIR = "compact-nudge";
var STATE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var MAX_TRACKED_FILES = 400;
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
function getConversationKey(payload, transcriptPath) {
  if (typeof payload.conversationId === "string" && payload.conversationId.trim()) {
    return payload.conversationId.trim();
  }
  if (typeof payload.conversation_id === "string" && payload.conversation_id.trim()) {
    return payload.conversation_id.trim();
  }
  return transcriptPath;
}
function getConversationStateHash(conversationKey) {
  return crypto.createHash("sha256").update(conversationKey).digest("hex").slice(0, 24);
}
async function readMarkerFile(filePath) {
  let raw;
  try {
    raw = await fs3.readFile(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "in-progress" };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const e = parsed;
      if (typeof e.nudgedAtTokens === "number" && Number.isFinite(e.nudgedAtTokens) && typeof e.nudgeCount === "number" && Number.isFinite(e.nudgeCount) && typeof e.updatedAt === "number" && Number.isFinite(e.updatedAt)) {
        return {
          status: "present",
          entry: {
            nudgedAtTokens: Math.floor(e.nudgedAtTokens),
            nudgedAtStep: typeof e.nudgedAtStep === "number" && Number.isFinite(e.nudgedAtStep) ? Math.floor(e.nudgedAtStep) : null,
            nudgeCount: Math.max(1, Math.floor(e.nudgeCount)),
            updatedAt: e.updatedAt
          }
        };
      }
    }
  } catch {
  }
  return { status: "in-progress" };
}
async function tryClaimMarker(filePath, entry) {
  try {
    await fs3.mkdir(path2.dirname(filePath), { recursive: true });
  } catch {
    return false;
  }
  let handle = null;
  try {
    handle = await fs3.open(filePath, "wx");
    await handle.writeFile(`${JSON.stringify(entry)}
`, "utf8");
    await handle.close();
    handle = null;
    return true;
  } catch {
    if (handle) {
      await handle.close().catch(() => {
      });
      await fs3.rm(filePath, { force: true }).catch(() => {
      });
    }
    return false;
  }
}
async function pruneOldMarkerFiles(stateDir, now) {
  try {
    const names = await fs3.readdir(stateDir);
    const jsonNames = names.filter((n) => n.endsWith(".json"));
    if (jsonNames.length === 0) return;
    const stats = await Promise.all(
      jsonNames.map(async (name) => {
        const full = path2.join(stateDir, name);
        try {
          const st = await fs3.stat(full);
          return { full, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const live = stats.filter((s) => s !== null);
    const toDelete = [];
    const kept = [];
    for (const item of live) {
      if (now - item.mtimeMs > STATE_TTL_MS) {
        toDelete.push(item.full);
      } else {
        kept.push(item);
      }
    }
    if (kept.length > MAX_TRACKED_FILES) {
      kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const extra of kept.slice(MAX_TRACKED_FILES)) {
        toDelete.push(extra.full);
      }
    }
    await Promise.all(
      toDelete.map((full) => fs3.rm(full, { force: true }).catch(() => {
      }))
    );
  } catch {
  }
}
async function evaluatePreInvocation(payload, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const transcriptPath = getTranscriptPath(payload);
  if (!transcriptPath) return {};
  const cfg = await readHookConfig(env);
  const threshold = resolveTokenThreshold(
    env.AGY_FAST_AUTO_COMPACT_TOKENS,
    cfg.autoCompactTokens,
    DEFAULT_AUTO_COMPACT_TOKENS
  );
  if (threshold <= 0) return {};
  const snapshot = await readLatestTranscriptContext(
    transcriptPath,
    options.tailOptions
  );
  if (!snapshot) return {};
  const conversationKey = getConversationKey(payload, transcriptPath);
  const stateDir = path2.join(getHookCacheDir(env), COMPACT_STATE_DIR);
  const keyHash = getConversationStateHash(conversationKey);
  const marker1Path = path2.join(stateDir, `${keyHash}.1.json`);
  const marker2Path = path2.join(stateDir, `${keyHash}.2.json`);
  if (snapshot.contextTokens < threshold) {
    const existingMarker = await readMarkerFile(marker1Path);
    if (existingMarker.status === "present") {
      const staleReset = snapshot.stepIndex !== null && existingMarker.entry.nudgedAtStep !== null && snapshot.stepIndex <= existingMarker.entry.nudgedAtStep;
      if (!staleReset) {
        await Promise.all([
          fs3.rm(marker1Path, { force: true }).catch(() => {
          }),
          fs3.rm(marker2Path, { force: true }).catch(() => {
          })
        ]);
      }
    }
    return {};
  }
  const firstMarker = await readMarkerFile(marker1Path);
  let nextNudgeCount = 0;
  let targetMarkerPath = "";
  if (firstMarker.status === "missing") {
    nextNudgeCount = 1;
    targetMarkerPath = marker1Path;
  } else if (firstMarker.status === "present") {
    const escalationStep = Math.max(5e4, Math.round(threshold * 0.15));
    if (snapshot.contextTokens >= firstMarker.entry.nudgedAtTokens + escalationStep) {
      const secondMarker = await readMarkerFile(marker2Path);
      if (secondMarker.status === "missing") {
        nextNudgeCount = 2;
        targetMarkerPath = marker2Path;
      }
    }
  }
  if (nextNudgeCount === 0 || !targetMarkerPath) {
    return {};
  }
  const claimed = await tryClaimMarker(targetMarkerPath, {
    nudgedAtTokens: snapshot.contextTokens,
    nudgedAtStep: snapshot.stepIndex,
    nudgeCount: nextNudgeCount,
    updatedAt: now
  });
  if (!claimed) {
    return {};
  }
  await pruneOldMarkerFiles(stateDir, now);
  const currentLabel = formatTokensCompact(snapshot.contextTokens);
  const thresholdLabel = formatTokensCompact(threshold);
  const message = nextNudgeCount === 1 ? `[agy-fast context guard] Context is at ~${currentLabel} tokens (soft threshold: ${thresholdLabel}; built-in compaction cliff: ~510k). Finish only your current atomic step, summarize progress and remaining work cleanly, and return control to the host/user for /compact instead of starting new work.` : `[agy-fast context guard] Urgent: context reached ~${currentLabel} tokens (approaching the ~510k compaction cliff). Do not start additional tool calls; summarize current state and next steps immediately and return control for /compact.`;
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: message
        }
      }
    ]
  };
}
async function runPreInvocationCli() {
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
    const result = await evaluatePreInvocation(payload);
    writeAndExit(`${JSON.stringify(result)}
`);
  } catch {
    writeAndExit("{}\n");
  }
}

// src/pre-invocation.ts
void runPreInvocationCli();
