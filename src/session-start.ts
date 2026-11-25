import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, writeAndExit } from "./utils/hook-io.js";
import { truncateWithByteNotice } from "./utils/output-filter.js";
import {
  formatSessionStartCompatNotice,
  readSavedEditsFormat,
  resolveHostCompat,
} from "./utils/host-compat.js";
import { runPreInvocationCli } from "./utils/quota-hooks.js";
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

const MAX_SNAPSHOT_BYTES = 1500;

async function main(): Promise<void> {
  // Backward-compatible dispatch for installations auto-updated by older agy-fast
  // updaters (<=0.2.10) that copy dist/session-start.mjs and hooks.json but not yet
  // dist/pre-invocation.mjs.
  const hookMode = (globalThis as { __agyFastHook?: unknown }).__agyFastHook;
  if (hookMode === "pre-invocation") {
    await runPreInvocationCli();
    return;
  }

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
