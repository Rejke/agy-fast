import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_STDIN_BYTES = 256 * 1024;

export interface HookConfig {
  autoCompactTokens?: unknown;
}

export function getHookHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "win32"
    ? env.USERPROFILE || env.HOME || os.homedir()
    : env.HOME || env.USERPROFILE || os.homedir();
}

export function getHookCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.AGY_FAST_CACHE_DIR?.trim();
  return custom
    ? path.resolve(custom)
    : path.join(getHookHomeDir(env), ".gemini", "cache", "agy-fast");
}

export async function readHookConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookConfig> {
  try {
    const cfgPath = path.join(getHookCacheDir(env), "config.json");
    const raw = await fs.readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HookConfig;
    }
  } catch {
    // Missing or unreadable config: fall back to defaults
  }
  return {};
}

export async function readStdin(
  timeoutMs = 1500,
  maxBytes = DEFAULT_MAX_STDIN_BYTES,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const onData = (chunk: Buffer | string) => {
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

export function writeAndExit(payload: string): void {
  // Explicitly exit after stdout flushes so abandoned libuv fs/stdin handles
  // can never keep a hook subprocess alive past its response.
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
