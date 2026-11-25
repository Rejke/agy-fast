import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_AUTO_COMPACT_TOKENS,
  parseTokenThreshold,
  readLatestTranscriptContext,
} from "../src/utils/transcript-context.js";
import { getConversationStateHash } from "../src/utils/quota-hooks.js";

const PRE_INVOCATION_SCRIPT = path.resolve(process.cwd(), "dist", "pre-invocation.mjs");

function runNodeHook(
  scriptPath: string,
  stdinText: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.AGY_FAST_CACHE_DIR;
    delete env.AGY_FAST_AUTO_COMPACT_TOKENS;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, durationMs: Date.now() - start }),
    );
    child.stdin.end(stdinText);
  });
}

function runShellHook(
  command: string,
  cwd: string,
  stdinText: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PLUGIN_ROOT;
    delete env.AGY_PLUGIN_ROOT;
    delete env.AGY_FAST_CACHE_DIR;
    delete env.AGY_FAST_AUTO_COMPACT_TOKENS;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

function plannerLine(
  stepIndex: number,
  inputTokens: number,
  cacheReadTokens: number,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    model: "gemini-4-neon-high",
    input_tokens: inputTokens,
    cache_read_tokens: cacheReadTokens,
    ...extra,
  });
}

describe("quota & context guard hooks", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-quota-hooks-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads only the tail of multi-MB transcripts across chunk and UTF-8 boundaries", async () => {
    const bigTranscript = path.join(tmpDir, "big-transcript.jsonl");
    const fh = await fs.open(bigTranscript, "w");
    try {
      // Write ~2.5MB of filler GENERIC lines with multibyte UTF-8 text
      const padLine = `${JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        content: "Привет мир 🚀 ".repeat(120),
      })}\n`;
      for (let i = 0; i < 1100; i++) {
        await fh.write(padLine);
      }
      // Write an older PLANNER_RESPONSE, then a newer one, then trailing GENERIC & zero-token step
      await fh.write(`${plannerLine(100, 100_000, 100_000)}\n`);
      await fh.write(
        `${plannerLine(105, 85_000, 310_000, { thinking: "Кириллица и эмодзи ✅ ".repeat(80) })}\n`,
      );
      // Force multiple small chunks after the latest PLANNER_RESPONSE
      for (let i = 0; i < 4; i++) {
        await fh.write(padLine);
      }
      // Trailing zero-token incomplete response must be skipped
      await fh.write(`${plannerLine(110, 0, 0)}\n`);
    } finally {
      await fh.close();
    }

    const stat = await fs.stat(bigTranscript);
    assert.ok(stat.size > 2 * 1024 * 1024, `Expected >2MB fixture, got ${stat.size}`);

    // Use a tiny initialChunkBytes so the PLANNER_RESPONSE straddles chunk boundaries
    const snap = await readLatestTranscriptContext(bigTranscript, {
      initialChunkBytes: 4096,
      maxTailBytes: 128 * 1024,
    });
    assert.ok(snap, "Expected snapshot from tail");
    assert.equal(snap.contextTokens, 395_000);
    assert.equal(snap.inputTokens, 85_000);
    assert.equal(snap.cacheReadTokens, 310_000);
    assert.equal(snap.stepIndex, 105);

    // Supports camelCase fields and fails open on missing/corrupt files
    const camelPath = path.join(tmpDir, "camel.jsonl");
    await fs.writeFile(
      camelPath,
      `not-json\n${JSON.stringify({ type: "PLANNER_RESPONSE", inputTokens: 12_000, cacheReadTokens: 150_000, stepIndex: 7 })}\n`,
      "utf8",
    );
    const camelSnap = await readLatestTranscriptContext(camelPath);
    assert.equal(camelSnap?.contextTokens, 162_000);
    assert.equal(camelSnap?.stepIndex, 7);

    assert.equal(await readLatestTranscriptContext(path.join(tmpDir, "missing.jsonl")), null);
    assert.equal(parseTokenThreshold("off"), 0);
    assert.equal(parseTokenThreshold("380_000"), 380_000);
    assert.equal(parseTokenThreshold("invalid"), null);
    assert.equal(DEFAULT_AUTO_COMPACT_TOKENS, 380_000);
  });

  it("PreInvocation nudges at >=380k, debounces, escalates once, and resets after compaction", async () => {
    const cacheDir = path.join(tmpDir, "cache-pre-inv");
    const transcript = path.join(tmpDir, "pre-inv.jsonl");
    const env = { AGY_FAST_CACHE_DIR: cacheDir };
    const convId = "conv-watermark-test";

    // 1. Below threshold (379,999) -> silent {}
    await fs.writeFile(transcript, `${plannerLine(1, 79_999, 300_000)}\n`, "utf8");
    const r1 = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: convId, transcriptPath: transcript, hookEventName: "PreInvocation" }),
      env,
    );
    assert.equal(r1.code, 0);
    assert.equal(r1.stderr, "");
    assert.deepEqual(JSON.parse(r1.stdout), {});

    // 2. Crosses 380k (385k) -> injects wrap-up systemMessage
    await fs.appendFile(transcript, `${plannerLine(2, 85_000, 300_000)}\n`, "utf8");
    const r2 = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: convId, transcriptPath: transcript }),
      env,
    );
    assert.equal(r2.code, 0);
    const msg2: string = JSON.parse(r2.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.match(msg2, /context guard/i);
    assert.match(msg2, /385k/);
    assert.match(msg2, /\/compact/);

    // 3. Subsequent steps at 395k and 420k -> debounced (no spam)
    for (const [step, inp] of [
      [3, 95_000],
      [4, 120_000],
    ] as const) {
      await fs.appendFile(transcript, `${plannerLine(step, inp, 300_000)}\n`, "utf8");
      const rDebounced = await runNodeHook(
        PRE_INVOCATION_SCRIPT,
        JSON.stringify({ conversationId: convId, transcriptPath: transcript }),
        env,
      );
      assert.equal(rDebounced.code, 0);
      assert.deepEqual(JSON.parse(rDebounced.stdout), {});
    }

    // 4. Context jumps by >=57k (to 445k) -> one urgent reminder
    await fs.appendFile(transcript, `${plannerLine(5, 145_000, 300_000)}\n`, "utf8");
    const rUrgent = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: convId, transcriptPath: transcript }),
      env,
    );
    const msgUrgent: string = JSON.parse(rUrgent.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.match(msgUrgent, /Urgent/i);
    assert.match(msgUrgent, /445k/);

    // 5. Further growth (480k) stays silent (capped at 2 nudges per epoch)
    await fs.appendFile(transcript, `${plannerLine(6, 180_000, 300_000)}\n`, "utf8");
    const rCapped = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: convId, transcriptPath: transcript }),
      env,
    );
    assert.deepEqual(JSON.parse(rCapped.stdout), {});

    // 6. Independent conversationId still gets its own nudge
    const rOtherConv = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: "conv-other", transcriptPath: transcript }),
      env,
    );
    assert.match(
      JSON.parse(rOtherConv.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? "",
      /context guard/i,
    );

    // 7. After compaction drops context to 45k -> silent AND resets watermark
    await fs.appendFile(transcript, `${plannerLine(7, 45_000, 0)}\n`, "utf8");
    const rPostCompact = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: convId, transcriptPath: transcript }),
      env,
    );
    assert.deepEqual(JSON.parse(rPostCompact.stdout), {});

    // 8. Crossing 380k again in new epoch -> nudges cleanly again
    await fs.appendFile(transcript, `${plannerLine(8, 82_000, 300_000)}\n`, "utf8");
    const rSecondEpoch = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: convId, transcriptPath: transcript }),
      env,
    );
    assert.match(
      JSON.parse(rSecondEpoch.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? "",
      /382k/,
    );
  });

  it("PreInvocation honors env/config thresholds, disable mode, and fails open on bad input", async () => {
    const cacheDir = path.join(tmpDir, "cache-pre-inv-cfg");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "config.json"),
      JSON.stringify({ autoCompactTokens: 200_000 }),
      "utf8",
    );
    const transcript = path.join(tmpDir, "pre-inv-cfg.jsonl");
    await fs.writeFile(transcript, `${plannerLine(1, 50_000, 160_000)}\n`, "utf8"); // 210k

    // Config threshold (200k) triggers at 210k
    const rCfg = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: "cfg-conv", transcriptPath: transcript }),
      { AGY_FAST_CACHE_DIR: cacheDir },
    );
    assert.match(
      JSON.parse(rCfg.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? "",
      /210k/,
    );

    // Env "off" disables hook even when config sets 200k
    const rOff = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: "cfg-conv-2", transcriptPath: transcript }),
      { AGY_FAST_CACHE_DIR: cacheDir, AGY_FAST_AUTO_COMPACT_TOKENS: "off" },
    );
    assert.deepEqual(JSON.parse(rOff.stdout), {});

    // Fail-open cases
    for (const bad of [
      "",
      "{broken-json",
      "[]",
      JSON.stringify({ conversationId: "x" }),
      JSON.stringify({ conversationId: "x", transcriptPath: path.join(tmpDir, "nope.jsonl") }),
    ]) {
      const res = await runNodeHook(PRE_INVOCATION_SCRIPT, bad, { AGY_FAST_CACHE_DIR: cacheDir });
      assert.equal(res.code, 0);
      assert.deepEqual(JSON.parse(res.stdout), {});
    }
  });


  it("hooks.json command for PreInvocation is shell-safe and resolves from unrelated CWD", async () => {
    const hooksConfig = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), "hooks.json"), "utf8"),
    ) as {
      "agy-fast-context-guard": { PreInvocation: Array<{ command: string }> };
      "agy-fast-image-guard"?: unknown;
    };

    assert.equal(hooksConfig["agy-fast-image-guard"], undefined);
    const preInvCmd = hooksConfig["agy-fast-context-guard"].PreInvocation[0]!.command;

    // Cross-shell safe (no sh/cmd-divergent metacharacters)
    assert.doesNotMatch(preInvCmd, /[$%!<>|&`\\]/);

    const unrelatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-unrelated-quota-"));
    const cacheDir = path.join(unrelatedCwd, "cache");
    const transcript = path.join(unrelatedCwd, "transcript.jsonl");
    await fs.writeFile(transcript, `${plannerLine(20, 100_000, 300_000)}\n`, "utf8"); // 400k

    try {
      const rInv = await runShellHook(
        preInvCmd,
        unrelatedCwd,
        JSON.stringify({ conversationId: "shell-cwd-test", transcriptPath: transcript }),
        { PLUGIN_ROOT: process.cwd(), AGY_FAST_CACHE_DIR: cacheDir },
      );
      assert.equal(rInv.code, 0, `stderr: ${rInv.stderr}`);
      assert.equal(rInv.stderr, "");
      assert.match(
        JSON.parse(rInv.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? "",
        /400k/,
      );
    } finally {
      await fs.rm(unrelatedCwd, { recursive: true, force: true });
    }
  });

  it("refuses to execute decoy workspace modules when PLUGIN_ROOT is unset (C2)", async () => {
    const hooksConfig = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), "hooks.json"), "utf8"),
    ) as {
      "agy-fast-context-guard": { PreInvocation: Array<{ command: string }> };
    };
    const preInvCmd = hooksConfig["agy-fast-context-guard"].PreInvocation[0]!.command;

    const decoyDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-decoy-ws-"));
    const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-decoy-home-"));
    const sentinel = path.join(decoyDir, "pwned.txt");
    try {
      await fs.mkdir(path.join(decoyDir, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(decoyDir, "plugin.json"),
        JSON.stringify({ name: "agy-fast", version: "9.9.9" }),
        "utf8",
      );
      const decoyScript = `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sentinel)}, "owned"); process.stdout.write('{"decision":"allow"}\\n');\n`;
      for (const name of ["pre-invocation.mjs", "session-start.mjs"]) {
        await fs.writeFile(path.join(decoyDir, "dist", name), decoyScript, "utf8");
      }

      const env = {
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        GEMINI_HOME: undefined,
        PLUGIN_ROOT: undefined,
        AGY_PLUGIN_ROOT: undefined,
      };
      const r1 = await runShellHook(preInvCmd, decoyDir, "{}", env);
      assert.equal(r1.code, 0);
      assert.deepEqual(JSON.parse(r1.stdout), {});
      await assert.rejects(fs.stat(sentinel), "Decoy workspace module must never execute");
    } finally {
      await fs.rm(decoyDir, { recursive: true, force: true });
      await fs.rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("works after an upgrade by the legacy v0.2.10 updater copy list without new dist bundles (C1)", async () => {
    const hooksConfig = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), "hooks.json"), "utf8"),
    ) as {
      "agy-fast-context-guard": { PreInvocation: Array<{ command: string }> };
    };
    const preInvCmd = hooksConfig["agy-fast-context-guard"].PreInvocation[0]!.command;

    const legacyInstallDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-legacy-upgrade-"));
    const cacheDir = path.join(legacyInstallDir, "cache");
    const transcript = path.join(legacyInstallDir, "transcript.jsonl");
    await fs.writeFile(transcript, `${plannerLine(30, 120_000, 280_000)}\n`, "utf8"); // 400k

    try {
      // Simulate base 2014a981 UPDATER_RUNTIME_FILES (does NOT include dist/pre-invocation.mjs)
      const legacyFiles = [
        "plugin.json",
        "mcp_config.json",
        "hooks.json",
        "rules/AGENTS.md",
        "assets/logo.svg",
        "dist/mcp-server.mjs",
        "dist/session-start.mjs",
        "dist/benchmark.mjs",
        "dist/updater.mjs",
        "scripts/install.mjs",
        "LICENSE",
      ];
      for (const rel of legacyFiles) {
        const src = path.resolve(process.cwd(), rel);
        const dst = path.join(legacyInstallDir, rel);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      }

      const env = { PLUGIN_ROOT: legacyInstallDir, AGY_FAST_CACHE_DIR: cacheDir };
      const rInv = await runShellHook(
        preInvCmd,
        legacyInstallDir,
        JSON.stringify({ conversationId: "legacy-upgrade-conv", transcriptPath: transcript }),
        env,
      );
      assert.equal(rInv.code, 0, `stderr: ${rInv.stderr}`);
      assert.equal(rInv.stderr, "");
      assert.match(
        JSON.parse(rInv.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? "",
        /400k/,
      );

      // Doctor must also pass on this legacy-upgraded installation (C7)
      const docOut = execFileSync(
        process.execPath,
        [path.join(legacyInstallDir, "scripts", "install.mjs"), "doctor", "--target", legacyInstallDir],
        {
          env: {
            ...process.env,
            AGY_FAST_CACHE_DIR: cacheDir,
            AGY_FAST_AUTO_UPDATE: "off",
          },
          encoding: "utf8",
        },
      );
      assert.match(docOut, /PreInvocation: OK/);
    } finally {
      await fs.rm(legacyInstallDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent PreInvocation calls across same and distinct conversations (C3) and fails silent on unwritable cache (C4)", async () => {
    const cacheDir = path.join(tmpDir, "cache-concurrent");
    const transcript = path.join(tmpDir, "concurrent.jsonl");
    await fs.writeFile(transcript, `${plannerLine(40, 100_000, 290_000)}\n`, "utf8"); // 390k
    const env = { AGY_FAST_CACHE_DIR: cacheDir };

    // 1. 4 simultaneous calls for the SAME conversationId -> exactly 1 nudge, 0 duplicates
    const sameResults = await Promise.all(
      Array.from({ length: 4 }, () =>
        runNodeHook(
          PRE_INVOCATION_SCRIPT,
          JSON.stringify({ conversationId: "race-same", transcriptPath: transcript }),
          env,
        ),
      ),
    );
    for (const r of sameResults) {
      assert.equal(r.code, 0);
      assert.equal(r.stderr, "");
    }
    const sameNudges = sameResults.filter(
      (r) => Boolean(JSON.parse(r.stdout)?.injectSteps?.length),
    );
    assert.equal(sameNudges.length, 1, `Expected exactly 1 nudge on concurrent same-conv race, got ${sameNudges.length}`);

    // 2. 4 simultaneous calls for DISTINCT conversationIds -> all 4 nudge and all 4 persist without lost updates
    const distinctIds = ["race-a", "race-b", "race-c", "race-d"];
    const distinctResults = await Promise.all(
      distinctIds.map((conversationId) =>
        runNodeHook(
          PRE_INVOCATION_SCRIPT,
          JSON.stringify({ conversationId, transcriptPath: transcript }),
          env,
        ),
      ),
    );
    for (const r of distinctResults) {
      assert.equal(r.code, 0);
      assert.equal(r.stderr, "");
      assert.ok(JSON.parse(r.stdout)?.injectSteps?.length === 1);
    }
    const stateDir = path.join(cacheDir, "compact-nudge");
    for (const id of ["race-same", ...distinctIds]) {
      const markerPath = path.join(stateDir, `${getConversationStateHash(id)}.1.json`);
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
        nudgeCount: number;
      };
      assert.equal(marker.nudgeCount, 1, `Expected persisted marker for ${id}`);
    }

    // 2b. 4 simultaneous calls racing to escalate to nudge #2 -> kernel-atomic O_CREAT|O_EXCL gives exactly 1 urgent nudge
    const escalatedTranscript = path.join(tmpDir, "concurrent-escalated.jsonl");
    await fs.writeFile(
      escalatedTranscript,
      `${plannerLine(45, 160_000, 300_000)}\n`, // 460k >= 390k + 57k
      "utf8",
    );
    const escalateResults = await Promise.all(
      Array.from({ length: 4 }, () =>
        runNodeHook(
          PRE_INVOCATION_SCRIPT,
          JSON.stringify({ conversationId: "race-same", transcriptPath: escalatedTranscript }),
          env,
        ),
      ),
    );
    for (const r of escalateResults) {
      assert.equal(r.code, 0);
      assert.equal(r.stderr, "");
    }
    const escalateNudges = escalateResults.filter(
      (r) => Boolean(JSON.parse(r.stdout)?.injectSteps?.length),
    );
    assert.equal(
      escalateNudges.length,
      1,
      `Expected exactly 1 urgent nudge on concurrent escalation race, got ${escalateNudges.length}`,
    );

    // 2c. Delayed/older below-threshold snapshot (step 5) must NOT erase a newer above-threshold claim (step 40)
    const olderLowTranscript = path.join(tmpDir, "older-low.jsonl");
    await fs.writeFile(olderLowTranscript, `${plannerLine(5, 50_000, 100_000)}\n`, "utf8"); // 150k at older step 5
    const staleResetRes = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: "race-same", transcriptPath: olderLowTranscript }),
      env,
    );
    assert.equal(staleResetRes.code, 0);
    assert.deepEqual(JSON.parse(staleResetRes.stdout), {});
    // Newer claim at step 40 must still exist, so a subsequent above-threshold call does NOT re-emit nudge #1
    const afterStaleResetRes = await runNodeHook(
      PRE_INVOCATION_SCRIPT,
      JSON.stringify({ conversationId: "race-same", transcriptPath: transcript }),
      env,
    );
    assert.deepEqual(JSON.parse(afterStaleResetRes.stdout), {});

    // 3. Unwritable cache dir (a regular file path, plus /dev/null on POSIX) -> returns {} without spamming
    const blockingFile = path.join(tmpDir, "not-a-dir");
    await fs.writeFile(blockingFile, "block", "utf8");
    const unwritableDirs =
      process.platform === "win32" ? [blockingFile] : [blockingFile, "/dev/null"];
    for (const badCache of unwritableDirs) {
      const rFail = await runNodeHook(
        PRE_INVOCATION_SCRIPT,
        JSON.stringify({ conversationId: "unwritable-conv", transcriptPath: transcript }),
        { AGY_FAST_CACHE_DIR: badCache },
      );
      assert.equal(rFail.code, 0);
      assert.equal(rFail.stderr, "");
      assert.deepEqual(JSON.parse(rFail.stdout), {});
    }
  });
});
