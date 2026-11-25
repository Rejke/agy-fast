import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearSkippedVersion,
  parseUpdateChannel,
  runPluginUpdate,
  skipUpdateVersion,
  type UpdateChannel,
} from "./utils/updater-core.js";

function requireFlagValue(args: string[], idx: number, flag: string): string {
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) {
    throw new Error(`Missing value after ${flag}`);
  }
  return next;
}

function parseCliArgs(argv: string[]): {
  pluginDir: string;
  background: boolean;
  checkOnly: boolean;
  force: boolean;
  json: boolean;
  skipVersion?: string;
  clearSkip: boolean;
  channel?: UpdateChannel;
  repoUrl?: string;
} {
  const args = argv.slice(2);
  const defaultPluginDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  let pluginDir = defaultPluginDir;
  let background = false;
  let checkOnly = false;
  let force = false;
  let json = false;
  let skipVersion: string | undefined;
  let clearSkip = false;
  let channel: UpdateChannel | undefined;
  let repoUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--background") {
      background = true;
    } else if (a === "--check") {
      checkOnly = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--clear-skip") {
      clearSkip = true;
    } else if (a === "--skip-version") {
      skipVersion = requireFlagValue(args, i, "--skip-version");
      i++;
    } else if (a === "--plugin-dir") {
      pluginDir = path.resolve(requireFlagValue(args, i, "--plugin-dir"));
      i++;
    } else if (a === "--channel") {
      const val = requireFlagValue(args, i, "--channel");
      const parsed = parseUpdateChannel(val);
      if (!parsed) throw new Error(`Invalid --channel value (expected 'release' or 'main')`);
      channel = parsed;
      i++;
    } else if (a === "--repo") {
      repoUrl = requireFlagValue(args, i, "--repo");
      i++;
    } else {
      throw new Error(`Unknown updater option: ${a}`);
    }
  }

  return {
    pluginDir,
    background,
    checkOnly,
    force,
    json,
    skipVersion,
    clearSkip,
    channel,
    repoUrl,
  };
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv);

  if (opts.clearSkip) {
    await clearSkippedVersion();
    const res = {
      status: "cleared-skip",
      message: "Cleared skipped agy-fast version preference.",
    };
    process.stdout.write(
      opts.json ? `${JSON.stringify(res, null, 2)}\n` : `${res.message}\n`,
    );
    return;
  }

  if (opts.skipVersion) {
    const { version } = await skipUpdateVersion(opts.skipVersion);
    const res = {
      status: "skipped-version",
      skippedVersion: version,
      message: `Skipped agy-fast v${version}. You will be notified again when a newer release is published.`,
    };
    process.stdout.write(
      opts.json ? `${JSON.stringify(res, null, 2)}\n` : `${res.message}\n`,
    );
    return;
  }

  const result = await runPluginUpdate({
    pluginDir: opts.pluginDir,
    background: opts.background,
    checkOnly: opts.checkOnly,
    force: opts.force,
    channel: opts.channel,
    repoUrl: opts.repoUrl,
  });

  if (opts.background) {
    return;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
  }

  if (result.status === "error") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  if (!process.argv.includes("--background")) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (process.argv.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", message: errMsg, error: errMsg }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`Error: ${errMsg}\n`);
    }
    process.exitCode = 1;
  }
});
