import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { truncateWithByteNotice } from "./utils/output-filter.js";
import {
  formatSessionStartCompatNotice,
  readSavedEditsFormat,
  resolveHostCompat,
} from "./utils/host-compat.js";
import { buildWorkspaceSnapshot } from "./utils/snapshot.js";
import {
  consumeSnapshotUpdateNotice,
  readInstalledVersion,
  readUpdateState,
  resolveUpdaterSettings,
  shouldTriggerBackgroundCheck,
  spawnBackgroundUpdateCheck,
  writeUpdateState,
} from "./utils/updater-core.js";

interface SessionStartPayload {
  cwd?: string;
  workspacePaths?: string[];
  workspace_paths?: string[];
  workspaceRoots?: string[];
  workspace_roots?: string[];
  transcriptPath?: string;
  transcript_path?: string;
  artifactDirectoryPath?: string;
  artifact_directory_path?: string;
  modelName?: string;
  model_name?: string;
  hookEventName?: string;
  hook_event_name?: string;
}

function firstNonEmptyPath(list: unknown): string {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return "";
}

const MAX_STDIN_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 1500;

async function readStdin(timeoutMs = 1500): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const endsWithCloseBrace = (buf: Buffer): boolean => {
      for (let i = buf.length - 1; i >= 0; i--) {
        const b = buf[i]!;
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
        return b === 0x7d;
      }
      return false;
    };

    const hasCompleteJsonObject = (): boolean => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text.startsWith("{") || !text.endsWith("}")) return false;
      try {
        const parsed = JSON.parse(text) as unknown;
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      } catch {
        return false;
      }
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = MAX_STDIN_BYTES - totalBytes;
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
        // Return immediately once a complete JSON object arrives instead of waiting
        // the full readStdin timeout when a host keeps stdin open without EOF.
        if (endsWithCloseBrace(buf) && hasCompleteJsonObject()) {
          finish();
        }
      }
    };

    const onEnd = () => finish();
    const onError = () => finish();
    const ignoreLateError = () => {};

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      process.stdin.off("error", onError);
      // Keep a no-op error listener so late pipe resets never crash fail-open exit
      process.stdin.on("error", ignoreLateError);
      // Release stdin handle so a parent that omits EOF never hangs the hook process
      process.stdin.pause();
      if (typeof (process.stdin as { unref?: () => void }).unref === "function") {
        (process.stdin as { unref: () => void }).unref();
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

function writeAndExit(payload: string): void {
  // Explicitly exit after stdout flushes so any abandoned libuv fs.readdir/fs.readFile
  // threadpool call after scanTimeoutMs cannot keep the SessionStart subprocess alive.
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

async function main(): Promise<void> {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      writeAndExit("{}\n");
      return;
    }

    let payload: SessionStartPayload;
    try {
      payload = JSON.parse(raw) as SessionStartPayload;
    } catch {
      writeAndExit("{}\n");
      return;
    }

    const workspaceDir =
      (typeof payload.cwd === "string" && payload.cwd.trim()) ||
      firstNonEmptyPath(payload.workspacePaths) ||
      firstNonEmptyPath(payload.workspace_paths) ||
      firstNonEmptyPath(payload.workspaceRoots) ||
      firstNonEmptyPath(payload.workspace_roots);

    if (!workspaceDir) {
      writeAndExit("{}\n");
      return;
    }

    const snapshot = await buildWorkspaceSnapshot(workspaceDir, {
      maxChars: MAX_SNAPSHOT_BYTES,
      maxBytes: MAX_SNAPSHOT_BYTES,
      gitTimeoutMs: 800,
    });

    if (!snapshot) {
      writeAndExit("{}\n");
      return;
    }

    let updateNotice: string | null = null;
    try {
      const pluginDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
      );
      const settings = await resolveUpdaterSettings();
      if (settings.mode !== "off") {
        const [currentVersion, state] = await Promise.all([
          readInstalledVersion(pluginDir),
          readUpdateState(),
        ]);
        updateNotice = await consumeSnapshotUpdateNotice(
          pluginDir,
          currentVersion,
        );
        if (shouldTriggerBackgroundCheck(state, Date.now(), settings.checkIntervalMs)) {
          const updaterPath = path.join(pluginDir, "dist", "updater.mjs");
          const hasUpdater = await fs
            .access(updaterPath)
            .then(() => true)
            .catch(() => false);
          if (hasUpdater) {
            await writeUpdateState({
              lastCheckAttemptAt: new Date().toISOString(),
            }).catch(() => {});
            spawnBackgroundUpdateCheck(pluginDir);
          }
        }
      }
    } catch {
      // Never block or break SessionStart on updater errors
    }

    let compatNotice: string | null = null;
    try {
      const configEditsFormat = await readSavedEditsFormat(process.env);
      const hostCompat = resolveHostCompat({
        transcriptPath:
          typeof payload.transcriptPath === "string"
            ? payload.transcriptPath
            : typeof payload.transcript_path === "string"
              ? payload.transcript_path
              : undefined,
        artifactDirectoryPath:
          typeof payload.artifactDirectoryPath === "string"
            ? payload.artifactDirectoryPath
            : typeof payload.artifact_directory_path === "string"
              ? payload.artifact_directory_path
              : undefined,
        modelName:
          typeof payload.modelName === "string"
            ? payload.modelName
            : typeof payload.model_name === "string"
              ? payload.model_name
              : undefined,
        env: process.env,
        configEditsFormat,
      });
      compatNotice = formatSessionStartCompatNotice(hostCompat);
    } catch {
      // Never block SessionStart on host-compat inspection
    }

    const trailingNotices = [compatNotice, updateNotice].filter(
      (n): n is string => Boolean(n),
    );
    let messageText = snapshot;
    if (trailingNotices.length > 0) {
      const suffix = trailingNotices.join("\n");
      const combined = `${snapshot}\n${suffix}`;
      if (Buffer.byteLength(combined, "utf8") <= MAX_SNAPSHOT_BYTES) {
        messageText = combined;
      } else {
        const noticeBytes = Buffer.byteLength(suffix, "utf8") + 1;
        const snapshotBudget = MAX_SNAPSHOT_BYTES - noticeBytes;
        messageText =
          snapshotBudget >= 64
            ? `${truncateWithByteNotice(snapshot, snapshotBudget)}\n${suffix}`
            : truncateWithByteNotice(combined, MAX_SNAPSHOT_BYTES);
      }
    }

    const response = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: messageText,
          },
        },
      ],
    };
    writeAndExit(`${JSON.stringify(response)}\n`);
  } catch {
    // Always fail open so session startup is never blocked
    writeAndExit("{}\n");
  }
}

void main();
