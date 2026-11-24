import { promises as fs } from "node:fs";

export const DEFAULT_AUTO_COMPACT_TOKENS = 380_000;
export const DEFAULT_IMAGE_GUARD_TOKENS = 150_000;

const INITIAL_TAIL_CHUNK_BYTES = 128 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024;
const PLANNER_MARKER = Buffer.from("PLANNER_RESPONSE", "utf8");

export interface TranscriptContextSnapshot {
  contextTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  stepIndex: number | null;
  model?: string;
}

export interface TailReadOptions {
  initialChunkBytes?: number;
  maxTailBytes?: number;
}

function parseFiniteNonNegativeInt(val: unknown): number | null {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) return null;
  return Math.floor(val);
}

/**
 * Parse a token threshold setting from env or config.json.
 * Returns:
 * - `0` when explicitly disabled (`0`, `"0"`, `"off"`, `"false"`, `"disabled"`, `false`)
 * - positive integer when valid
 * - `null` when unset or invalid (caller should fall back to next source/default)
 */
export function parseTokenThreshold(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
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

export function resolveTokenThreshold(
  envValue: unknown,
  configValue: unknown,
  defaultValue: number,
): number {
  const fromEnv = parseTokenThreshold(envValue);
  if (fromEnv !== null) return fromEnv;
  const fromCfg = parseTokenThreshold(configValue);
  if (fromCfg !== null) return fromCfg;
  return defaultValue;
}

function parsePlannerResponseLine(lineBuf: Buffer): TranscriptContextSnapshot | null {
  if (lineBuf.length === 0 || !lineBuf.includes(PLANNER_MARKER)) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(lineBuf.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (obj.type !== "PLANNER_RESPONSE") return null;

  const inputTokens = parseFiniteNonNegativeInt(obj.input_tokens ?? obj.inputTokens);
  const cacheReadTokens = parseFiniteNonNegativeInt(
    obj.cache_read_tokens ?? obj.cacheReadTokens,
  );
  if (inputTokens === null && cacheReadTokens === null) return null;

  const total = (inputTokens ?? 0) + (cacheReadTokens ?? 0);
  // Skip incomplete/errored zero-token responses so they do not falsely reset high-water marks
  if (total <= 0) return null;

  const stepIndex = parseFiniteNonNegativeInt(obj.step_index ?? obj.stepIndex);
  const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : undefined;

  return {
    contextTokens: total,
    inputTokens: inputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    stepIndex,
    model,
  };
}

function scanBufferBackwardsForPlanner(buf: Buffer): TranscriptContextSnapshot | null {
  let end = buf.length;
  while (end > 0) {
    const nl = buf.lastIndexOf(0x0a, end - 1);
    const start = nl === -1 ? 0 : nl + 1;
    let lineEnd = end;
    if (lineEnd > start && buf[lineEnd - 1] === 0x0d) {
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

async function readExactChunk(
  fh: fs.FileHandle,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const res = await fh.read(buf, filled, length - filled, offset + filled);
    if (res.bytesRead <= 0) break;
    filled += res.bytesRead;
  }
  return filled === length ? buf : buf.subarray(0, filled);
}

/**
 * Quickly read the tail of an Antigravity `transcript.jsonl` file backwards in
 * bounded chunks to find the most recent `PLANNER_RESPONSE` token counts without
 * loading multi-megabyte transcripts into memory. Strictly fail-open (`null` on error).
 */
export async function readLatestTranscriptContext(
  transcriptPath: string,
  options: TailReadOptions = {},
): Promise<TranscriptContextSnapshot | null> {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  const trimmed = transcriptPath.trim();
  if (!trimmed) return null;

  const maxTailBytes = Math.max(
    4096,
    options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES,
  );
  let chunkSize = Math.max(
    1024,
    Math.min(options.initialChunkBytes ?? INITIAL_TAIL_CHUNK_BYTES, maxTailBytes),
  );

  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(trimmed, "r");
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size <= 0) return null;

    let pos = stat.size;
    let totalRead = 0;
    let trailingPartial: Buffer = Buffer.alloc(0);

    while (pos > 0 && totalRead < maxTailBytes) {
      const remainingBudget = maxTailBytes - totalRead;
      const toRead = Math.min(chunkSize, pos, remainingBudget);
      const start = pos - toRead;
      const chunk = await readExactChunk(fh, start, toRead);
      if (chunk.length === 0) break;

      pos = start;
      totalRead += chunk.length;

      const combined =
        trailingPartial.length > 0 ? Buffer.concat([chunk, trailingPartial]) : chunk;

      if (pos === 0) {
        return scanBufferBackwardsForPlanner(combined);
      }

      const firstNl = combined.indexOf(0x0a);
      if (firstNl === -1) {
        // Single line spans more than this chunk; carry it to the next backward read
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
      await fh.close().catch(() => {});
    }
  }
}
