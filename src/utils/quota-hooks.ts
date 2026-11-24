import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getHookCacheDir,
  readHookConfig,
  readStdin,
  writeAndExit,
} from "./hook-io.js";
import {
  DEFAULT_AUTO_COMPACT_TOKENS,
  DEFAULT_IMAGE_GUARD_TOKENS,
  readLatestTranscriptContext,
  resolveTokenThreshold,
  type TailReadOptions,
} from "./transcript-context.js";

const COMPACT_STATE_DIR = "compact-nudge";
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TRACKED_FILES = 400;

export const BLOCKED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
  ".tiff",
  ".tif",
]);

export interface PreInvocationPayload {
  conversationId?: string;
  conversation_id?: string;
  transcriptPath?: string;
  transcript_path?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  hookEventName?: string;
}

export interface PreToolUseToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  arguments?: unknown;
}

export interface PreToolUsePayload {
  conversationId?: string;
  conversation_id?: string;
  transcriptPath?: string;
  transcript_path?: string;
  toolCall?: PreToolUseToolCall;
  tool_call?: PreToolUseToolCall;
  stepIdx?: number;
  hookEventName?: string;
}

export interface CompactNudgeEntry {
  nudgedAtTokens: number;
  nudgedAtStep: number | null;
  nudgeCount: number;
  updatedAt: number;
}

export interface PreInvocationResult {
  injectSteps?: Array<{
    systemMessage: {
      systemMessage: string;
    };
  }>;
}

export interface PreToolUseResult {
  decision?: "allow" | "deny" | "ask" | "force_ask";
  reason?: string;
}

export interface ImageToolCallMatch {
  kind: "read_file" | "preview_snapshot";
  toolName: string;
  target: string;
}

export function formatTokensCompact(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return String(tokens);
}

function getTranscriptPath(payload: {
  transcriptPath?: string;
  transcript_path?: string;
}): string {
  if (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) {
    return payload.transcriptPath.trim();
  }
  if (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) {
    return payload.transcript_path.trim();
  }
  return "";
}

function getConversationKey(
  payload: { conversationId?: string; conversation_id?: string },
  transcriptPath: string,
): string {
  if (typeof payload.conversationId === "string" && payload.conversationId.trim()) {
    return payload.conversationId.trim();
  }
  if (typeof payload.conversation_id === "string" && payload.conversation_id.trim()) {
    return payload.conversation_id.trim();
  }
  return transcriptPath;
}

function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function extractFilePathArg(args: Record<string, unknown>): string {
  for (const key of [
    "Path",
    "path",
    "AbsolutePath",
    "absolutePath",
    "file_path",
    "filePath",
  ]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

export function isImageFilePath(filePath: string): boolean {
  if (!filePath) return false;
  // Normalize Windows backslashes so path.extname works identically across platforms
  const normalized = filePath.replace(/\\/g, "/");
  const ext = path.posix.extname(normalized).toLowerCase();
  return BLOCKED_IMAGE_EXTENSIONS.has(ext);
}

export function detectImageToolCall(
  payload: PreToolUsePayload,
): ImageToolCallMatch | null {
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
        target: targetPath,
      };
    }
    return null;
  }

  if (
    normName === "preview_snapshot" ||
    normName.endsWith("_preview_snapshot")
  ) {
    if (args.includeImage === true || args.include_image === true) {
      return {
        kind: "preview_snapshot",
        toolName: rawName,
        target: rawName,
      };
    }
    return null;
  }

  return null;
}

export function getConversationStateHash(conversationKey: string): string {
  return crypto.createHash("sha256").update(conversationKey).digest("hex").slice(0, 24);
}

type MarkerReadResult =
  | { status: "missing" }
  | { status: "in-progress" }
  | { status: "present"; entry: CompactNudgeEntry };

async function readMarkerFile(filePath: string): Promise<MarkerReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "in-progress" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const e = parsed as Record<string, unknown>;
      if (
        typeof e.nudgedAtTokens === "number" &&
        Number.isFinite(e.nudgedAtTokens) &&
        typeof e.nudgeCount === "number" &&
        Number.isFinite(e.nudgeCount) &&
        typeof e.updatedAt === "number" &&
        Number.isFinite(e.updatedAt)
      ) {
        return {
          status: "present",
          entry: {
            nudgedAtTokens: Math.floor(e.nudgedAtTokens),
            nudgedAtStep:
              typeof e.nudgedAtStep === "number" && Number.isFinite(e.nudgedAtStep)
                ? Math.floor(e.nudgedAtStep)
                : null,
            nudgeCount: Math.max(1, Math.floor(e.nudgeCount)),
            updatedAt: e.updatedAt,
          },
        };
      }
    }
  } catch {
    // Another process just created the marker via O_CREAT|O_EXCL and is mid-write
  }
  return { status: "in-progress" };
}

/**
 * Atomically claim a per-conversation nudge marker via O_CREAT|O_EXCL ("wx").
 * Eliminates lock files, stale-lock reclamation, and cross-conversation contention:
 * the kernel guarantees at most one concurrent caller can claim a given marker.
 */
async function tryClaimMarker(
  filePath: string,
  entry: CompactNudgeEntry,
): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  } catch {
    return false;
  }

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "wx");
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.close();
    handle = null;
    return true;
  } catch {
    if (handle) {
      await handle.close().catch(() => {});
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
    return false;
  }
}

async function pruneOldMarkerFiles(stateDir: string, now: number): Promise<void> {
  try {
    const names = await fs.readdir(stateDir);
    const jsonNames = names.filter((n) => n.endsWith(".json"));
    if (jsonNames.length === 0) return;
    const stats = await Promise.all(
      jsonNames.map(async (name) => {
        const full = path.join(stateDir, name);
        try {
          const st = await fs.stat(full);
          return { full, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const live = stats.filter((s): s is { full: string; mtimeMs: number } => s !== null);
    const toDelete: string[] = [];
    const kept: Array<{ full: string; mtimeMs: number }> = [];
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
      toDelete.map((full) => fs.rm(full, { force: true }).catch(() => {})),
    );
  } catch {
    // Best-effort cleanup; never affect hook execution
  }
}

export async function evaluatePreInvocation(
  payload: PreInvocationPayload,
  options: {
    env?: NodeJS.ProcessEnv;
    now?: number;
    tailOptions?: TailReadOptions;
  } = {},
): Promise<PreInvocationResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();

  const transcriptPath = getTranscriptPath(payload);
  if (!transcriptPath) return {};

  const cfg = await readHookConfig(env);
  const threshold = resolveTokenThreshold(
    env.AGY_FAST_AUTO_COMPACT_TOKENS,
    cfg.autoCompactTokens,
    DEFAULT_AUTO_COMPACT_TOKENS,
  );
  if (threshold <= 0) return {};

  const snapshot = await readLatestTranscriptContext(
    transcriptPath,
    options.tailOptions,
  );
  if (!snapshot) return {};

  const conversationKey = getConversationKey(payload, transcriptPath);
  const stateDir = path.join(getHookCacheDir(env), COMPACT_STATE_DIR);
  const keyHash = getConversationStateHash(conversationKey);
  const marker1Path = path.join(stateDir, `${keyHash}.1.json`);
  const marker2Path = path.join(stateDir, `${keyHash}.2.json`);

  // Context dropped below threshold (e.g. after /compact or auto-compaction): clear epoch markers
  // ONLY if the below-threshold snapshot is strictly newer than the recorded claim step, so a
  // delayed/older below-threshold caller can never erase a newer above-threshold claim.
  if (snapshot.contextTokens < threshold) {
    const existingMarker = await readMarkerFile(marker1Path);
    if (existingMarker.status === "present") {
      const staleReset =
        snapshot.stepIndex !== null &&
        existingMarker.entry.nudgedAtStep !== null &&
        snapshot.stepIndex <= existingMarker.entry.nudgedAtStep;
      if (!staleReset) {
        await Promise.all([
          fs.rm(marker1Path, { force: true }).catch(() => {}),
          fs.rm(marker2Path, { force: true }).catch(() => {}),
        ]);
      }
    }
    return {};
  }

  // Above threshold: claim nudge #1 via kernel-atomic O_CREAT|O_EXCL, or escalate once
  // to nudge #2 if context continues growing substantially without compacting.
  const firstMarker = await readMarkerFile(marker1Path);
  let nextNudgeCount = 0;
  let targetMarkerPath = "";

  if (firstMarker.status === "missing") {
    nextNudgeCount = 1;
    targetMarkerPath = marker1Path;
  } else if (firstMarker.status === "present") {
    const escalationStep = Math.max(50_000, Math.round(threshold * 0.15));
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
    updatedAt: now,
  });
  if (!claimed) {
    // Lost concurrent race or unwritable cache dir: stay silent (no duplicate or spam)
    return {};
  }

  await pruneOldMarkerFiles(stateDir, now);

  const currentLabel = formatTokensCompact(snapshot.contextTokens);
  const thresholdLabel = formatTokensCompact(threshold);
  const message =
    nextNudgeCount === 1
      ? `[agy-fast context guard] Context is at ~${currentLabel} tokens (soft threshold: ${thresholdLabel}; built-in compaction cliff: ~510k). Finish only your current atomic step, summarize progress and remaining work cleanly, and return control to the host/user for /compact instead of starting new work.`
      : `[agy-fast context guard] Urgent: context reached ~${currentLabel} tokens (approaching the ~510k compaction cliff). Do not start additional tool calls; summarize current state and next steps immediately and return control for /compact.`;

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: message,
        },
      },
    ],
  };
}

export async function evaluatePreToolUse(
  payload: PreToolUsePayload,
  options: {
    env?: NodeJS.ProcessEnv;
    tailOptions?: TailReadOptions;
  } = {},
): Promise<PreToolUseResult> {
  // Fast path: exit with zero disk I/O for non-image tool calls (e.g. code read_file, text preview_snapshot)
  const match = detectImageToolCall(payload);
  if (!match) return {};

  const env = options.env ?? process.env;
  const transcriptPath = getTranscriptPath(payload);
  if (!transcriptPath) return {};

  const cfg = await readHookConfig(env);
  const threshold = resolveTokenThreshold(
    env.AGY_FAST_IMAGE_GUARD_TOKENS,
    cfg.imageGuardTokens,
    DEFAULT_IMAGE_GUARD_TOKENS,
  );
  if (threshold <= 0) return {};

  const snapshot = await readLatestTranscriptContext(
    transcriptPath,
    options.tailOptions,
  );
  if (!snapshot || snapshot.contextTokens < threshold) {
    // Return {} (neutral pass-through) instead of {"decision":"allow"} so we never
    // auto-approve restricted reads or MCP tools in approval-required mode.
    return {};
  }

  const currentLabel = formatTokensCompact(snapshot.contextTokens);
  const thresholdLabel = formatTokensCompact(threshold);
  const callDesc =
    match.kind === "read_file"
      ? `${match.toolName}(${path.posix.basename(match.target.replace(/\\/g, "/"))})`
      : `${match.toolName}(includeImage: true)`;

  return {
    decision: "deny",
    reason: `[agy-fast image guard] Blocked ${callDesc} at ~${currentLabel} context tokens (limit: ${thresholdLabel}) to prevent prompt-cache invalidation and 3-7x TTFT spikes. Delegate visual inspection of this image to a subagent (e.g. invoke_subagent) and have it return text-only findings (values, selectors, file paths, concrete fixes).`,
  };
}

export async function runPreInvocationCli(): Promise<void> {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      writeAndExit("{}\n");
      return;
    }

    let payload: PreInvocationPayload;
    try {
      payload = JSON.parse(raw) as PreInvocationPayload;
    } catch {
      writeAndExit("{}\n");
      return;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      writeAndExit("{}\n");
      return;
    }

    const result = await evaluatePreInvocation(payload);
    writeAndExit(`${JSON.stringify(result)}\n`);
  } catch {
    writeAndExit("{}\n");
  }
}

export async function runPreToolUseCli(): Promise<void> {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      writeAndExit("{}\n");
      return;
    }

    let payload: PreToolUsePayload;
    try {
      payload = JSON.parse(raw) as PreToolUsePayload;
    } catch {
      writeAndExit("{}\n");
      return;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      writeAndExit("{}\n");
      return;
    }

    const result = await evaluatePreToolUse(payload);
    writeAndExit(`${JSON.stringify(result)}\n`);
  } catch {
    writeAndExit("{}\n");
  }
}
