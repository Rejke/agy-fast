import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runChecks } from "../src/tools/run-checks.js";
import {
  buildPowerShellUtf8Command,
  decodeProcessOutput,
  execBinaryAsync,
  formatPowerShellCommand,
  needsPowerShellOnWindows,
  parseWindowsCodePage,
  resetWindowsShellCache,
  resolveWindowsPowerShell,
  unwrapTrivialWindowsPowerShellCommand,
  withNonInteractiveGitEnv,
} from "../src/utils/exec-utils.js";
import {
  fitSectionsToByteBudget,
  sliceSafeCharsTail,
  sliceUtf8BytesTail,
  truncateHeadTailWithByteNotice,
  truncateHeadTailWithNotice,
  truncateWithByteNotice,
  truncateWithNotice,
} from "../src/utils/output-filter.js";

describe("run_checks", () => {
  const nodeBin = JSON.stringify(process.execPath);

  it("executes multiple commands concurrently and compacts passing output", async () => {
    const start = Date.now();
    const res = await runChecks({
      concurrency: 3,
      outputMode: "compact",
      commands: [
        {
          name: "c1",
          command: `${nodeBin} -e "setTimeout(() => console.log('line1\\nline2\\nAll 10 tests passed'), 180)"`,
        },
        {
          name: "c2",
          command: `${nodeBin} -e "setTimeout(() => console.log('Build done in 0.2s'), 180)"`,
        },
        {
          name: "c3",
          command: `${nodeBin} -e "setTimeout(() => console.log('0 errors'), 180)"`,
        },
      ],
    });
    const elapsed = Date.now() - start;

    assert.equal(res.isError, false);
    assert.match(res.text, /Checks: 3\/3 passed/);
    assert.match(res.text, /\[PASS \d+ms\] c1/);
    assert.match(res.text, /All 10 tests passed/);
    // Should clearly execute concurrently rather than 3 * 180ms = 540ms+ serially
    assert.ok(elapsed < 480, `Expected concurrent execution <480ms, got ${elapsed}ms`);
  });

  it("extracts error lines on failure and strips ANSI escape codes", async () => {
    const script = [
      "for (let i = 0; i < 40; i++) console.log('info step ' + i);",
      "console.error('\\x1b[31mError: TS2322 type mismatch at src/a.ts:12\\x1b[0m');",
      "console.log('progress 10%\\rprogress 100%');",
      "process.exitCode = 2;",
    ].join(" ");

    const res = await runChecks({
      outputMode: "compact",
      commands: [{ name: "typecheck", command: `${nodeBin} -e "${script}"` }],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /Checks: 0\/1 passed, 1 failed/);
    assert.match(res.text, /FAIL \(exit 2\)/);
    assert.match(res.text, /Error: TS2322 type mismatch/);
    assert.doesNotMatch(res.text, /\x1b\[31m/);
    assert.match(res.text, /progress 100%/);
  });

  it("enforces command timeouts cleanly", async () => {
    const res = await runChecks({
      timeoutSec: 1,
      commands: [
        {
          name: "hang",
          command: `${nodeBin} -e "setTimeout(() => console.log('never'), 10000)"`,
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /TIMEOUT/);
  });

  it("finishes within the shared call budget and reports commands that never started", async () => {
    const budgetMs = 2_000;
    const start = Date.now();
    const res = await runChecks(
      {
        concurrency: 1,
        timeoutSec: 5,
        commands: [
          { name: "quick", command: `${nodeBin} -e "setTimeout(() => console.log('ok'), 300)"` },
          { name: "hang", command: `${nodeBin} -e "setTimeout(() => {}, 10000)"` },
          { name: "late", command: `${nodeBin} -e "console.log('late')"` },
        ],
      },
      budgetMs,
    );
    const elapsed = Date.now() - start;

    assert.ok(elapsed < budgetMs + 1_000, `call took ${elapsed}ms`);
    assert.match(res.text, /^Checks: 1\/3 passed, 1 failed, 1 not run \(call time budget of 2s used up/);
    assert.match(res.text, /\[PASS \d+ms\] quick/);
    assert.match(res.text, /## \[TIMEOUT \d+ms\] hang/);
    assert.match(res.text, /## \[NOT RUN\] late/);
  });

  it("supports full output mode and rejects invalid inputs", async () => {
    const full = await runChecks({
      outputMode: "full",
      commands: [`${nodeBin} -e "console.log('alpha\\nbeta\\ngamma')"`],
    });
    assert.equal(full.isError, false);
    assert.match(full.text, /alpha\nbeta\ngamma/);

    const empty = await runChecks({ commands: [] });
    assert.equal(empty.isError, true);

    const badSubCwd = await runChecks({
      commands: [{ name: "badcwd", command: "echo hi", cwd: "/nonexistent-agy-fast-dir-12345" }],
    });
    assert.equal(badSubCwd.isError, true);
    assert.match(badSubCwd.text, /does not exist/);

    // Non-string commands[i].cwd returns a clean validation error; boolean timeoutSec falls back
    const nonStrSubCwd = await runChecks({
      commands: [{ name: "bad-type", command: `${nodeBin} -e "0"`, cwd: 123 as unknown as string }],
    });
    assert.equal(nonStrSubCwd.isError, true);
    assert.match(nonStrSubCwd.text, /commands\[0\]\.cwd must be a string/);

    const boolTimeout = await runChecks({
      timeoutSec: false as unknown as number,
      commands: [{ name: "bool-timeout", command: `${nodeBin} -e "setTimeout(() => console.log('ok'), 1150)"` }],
    });
    assert.equal(boolTimeout.isError, false);
    assert.match(boolTimeout.text, /1\/1 passed/);
  });

  it("captures npm ERR! lines and respects tight maxChars across multiple failures", async () => {
    const npmErrScript = [
      "for (let i = 0; i < 80; i++) console.log('verbose build step number ' + i + ' padding padding');",
      "console.error('npm ERR! code ELIFECYCLE');",
      "console.error('npm ERR! errno 1');",
      "for (let i = 0; i < 40; i++) console.log('trailing line ' + i + ' padding padding');",
      "process.exitCode = 1;",
    ].join(" ");

    const res = await runChecks({
      outputMode: "compact",
      maxChars: 1200,
      commands: [
        { name: "npm-fail-1", command: `${nodeBin} -e "${npmErrScript}"` },
        { name: "npm-fail-2", command: `${nodeBin} -e "console.error('FAIL_TWO_MARKER'); process.exit(1)"` },
      ],
    });
    assert.equal(res.isError, false);
    assert.ok(res.text.length <= 1200, `Exceeded maxChars: ${res.text.length}`);
    assert.match(res.text, /npm ERR! code ELIFECYCLE/);
    assert.match(res.text, /FAIL_TWO_MARKER/);
  });

  it("circuit-breaks corrupted commands (boolean/null) and accepts stringified JSON arrays", async () => {
    const bad = await runChecks({
      commands: [true, null] as unknown as never[],
    });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /nested argument serialization corruption/i);
    assert.match(bad.text, /commands\[0\]: received boolean \(true\)/);
    assert.match(bad.text, /commands\[1\]: received null/);

    const ok = await runChecks({
      commands: JSON.stringify([{ name: "json-ok", command: `${nodeBin} -e "console.log('ok')"` }]) as unknown as never[],
    });
    assert.equal(ok.isError, false);
    assert.match(ok.text, /\[PASS/);
  });

  it("detects PowerShell syntax vs cross-platform commands and formats quoted executables", () => {
    assert.equal(
      needsPowerShellOnWindows('node "$env:USERPROFILE\\.gemini\\dist\\benchmark.mjs" --help'),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows('node "$Env:USERPROFILE\\dist\\benchmark.mjs" --help'),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("echo $ENV:PATH; echo $LastExitCode"),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("Get-ChildItem src | Select-Object -First 5"),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("if (Test-Path dist) { Write-Output $LASTEXITCODE }"),
      true,
    );
    assert.equal(needsPowerShellOnWindows("$x = 1; echo $x"), true);
    assert.equal(needsPowerShellOnWindows("echo $(Get-Date)"), true);
    assert.equal(needsPowerShellOnWindows('@("a", "b") -join ","'), true);

    // Cross-platform CLI tools and quoted patterns must NOT false-positive as PowerShell
    assert.equal(needsPowerShellOnWindows("npm test"), false);
    assert.equal(needsPowerShellOnWindows("npm run test-unit"), false);
    assert.equal(needsPowerShellOnWindows("start-server-and-test dev 3000 test"), false);
    assert.equal(needsPowerShellOnWindows("copy-webpack-plugin --version"), false);
    assert.equal(needsPowerShellOnWindows("wait-on http://localhost:3000 && npm test"), false);
    assert.equal(needsPowerShellOnWindows("start-storybook -p 6006"), false);
    assert.equal(needsPowerShellOnWindows("copy-files src dist"), false);
    assert.equal(needsPowerShellOnWindows("npm run build && test-runner"), false);
    assert.equal(needsPowerShellOnWindows('git log --grep="(set-cookie)"'), false);
    assert.equal(needsPowerShellOnWindows('git log --grep="(Get-Item)"'), false);
    assert.equal(needsPowerShellOnWindows('rg "(get-user|set-user)" src/'), false);
    assert.equal(
      needsPowerShellOnWindows('node -e "console.log(JSON.stringify({ msg: \\"(get-id)\\" }))"'),
      false,
    );
    assert.equal(needsPowerShellOnWindows("echo '$env:PATH'"), false);
    assert.equal(needsPowerShellOnWindows('rg "\\$env:FOO" src/'), false);
    assert.equal(
      needsPowerShellOnWindows('"D:\\Program Files\\nodejs\\node.exe" -e "console.log(1)"'),
      false,
    );
    assert.equal(needsPowerShellOnWindows("echo %USERPROFILE%"), false);
    assert.equal(
      needsPowerShellOnWindows('pwsh -NoProfile -Command "Write-Output ok"'),
      false,
    );

    // Quoted executable invocation vs PowerShell string expressions
    assert.equal(
      formatPowerShellCommand('"$Env:USERPROFILE\\bin\\tool.exe" --version'),
      '& "$Env:USERPROFILE\\bin\\tool.exe" --version',
    );
    assert.equal(
      formatPowerShellCommand("'C:\\Tools\\my`tool.exe' --help"),
      "& 'C:\\Tools\\my`tool.exe' --help",
    );
    assert.equal(formatPowerShellCommand('"hello" | Out-Null'), '"hello" | Out-Null');
    assert.equal(formatPowerShellCommand('"$Env:FOO" -eq "bar"'), '"$Env:FOO" -eq "bar"');
    assert.equal(formatPowerShellCommand('"{0}" -f $Env:USERNAME'), '"{0}" -f $Env:USERNAME');
    assert.equal(formatPowerShellCommand('"$Env:PATH".Split(\';\')'), '"$Env:PATH".Split(\';\')');
    assert.equal(formatPowerShellCommand('"$Env:USERPROFILE"[0]'), '"$Env:USERPROFILE"[0]');
    assert.equal(formatPowerShellCommand('"$Env:FOO" > out.txt'), '"$Env:FOO" > out.txt');
    assert.equal(formatPowerShellCommand('"$Env:FOO" 2> err.txt'), '"$Env:FOO" 2> err.txt');
    assert.equal(formatPowerShellCommand('"$Env:FOO" * 3'), '"$Env:FOO" * 3');
    assert.equal(formatPowerShellCommand('"$Env:A", "$Env:B"'), '"$Env:A", "$Env:B"');
    assert.equal(formatPowerShellCommand("'it''s' + $Env:FOO"), "'it''s' + $Env:FOO");
    assert.equal(formatPowerShellCommand('"a""b" -eq $Env:FOO'), '"a""b" -eq $Env:FOO');
    assert.equal(
      formatPowerShellCommand('node "$env:USERPROFILE\\a.js"'),
      'node "$env:USERPROFILE\\a.js"',
    );
    assert.equal(
      formatPowerShellCommand('"$env:FOO"\nGet-Date'),
      '"$env:FOO"\nGet-Date',
    );
    assert.equal(
      formatPowerShellCommand('"$env:FOO" \nGet-Date'),
      '"$env:FOO" \nGet-Date',
    );
    assert.equal(
      formatPowerShellCommand('"$env:FOO"  \t\r\nGet-Date'),
      '"$env:FOO"  \t\r\nGet-Date',
    );
    assert.equal(needsPowerShellOnWindows('echo "C:\\\\" && Get-ChildItem'), true);
    assert.equal(needsPowerShellOnWindows('echo "foo``" && Get-ChildItem'), true);

    // UTF-8 prefix guards non-console hosts and avoids BOM
    const wrapped = buildPowerShellUtf8Command('Write-Output "ok"');
    assert.match(wrapped, /try \{ \[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\) \} catch \{\}/);
    assert.match(wrapped, /\$OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
    assert.ok(wrapped.endsWith('Write-Output "ok"'));
  });

  it("resolves pwsh -> powershell.exe -> null fallback chain and caches probe results", async () => {
    try {
      resetWindowsShellCache();
      const probed: string[] = [];
      const first = await resolveWindowsPowerShell(async (bin) => {
        probed.push(bin);
        return bin === "pwsh";
      });
      const cached = await resolveWindowsPowerShell(async (bin) => {
        probed.push(`unexpected-${bin}`);
        return false;
      });
      assert.equal(first, "pwsh");
      assert.equal(cached, "pwsh");
      assert.deepEqual(probed, ["pwsh"]);

      resetWindowsShellCache();
      const fallbackProbed: string[] = [];
      const second = await resolveWindowsPowerShell(async (bin) => {
        fallbackProbed.push(bin);
        return bin === "powershell.exe";
      });
      assert.equal(second, "powershell.exe");
      assert.deepEqual(fallbackProbed, ["pwsh", "powershell.exe"]);

      resetWindowsShellCache();
      const noneProbed: string[] = [];
      const third = await resolveWindowsPowerShell(async (bin) => {
        noneProbed.push(bin);
        return false;
      });
      assert.equal(third, null);
      assert.deepEqual(noneProbed, ["pwsh", "powershell.exe"]);
    } finally {
      resetWindowsShellCache();
    }
  });

  it("decodes UTF-8, truncated UTF-8 tails, and legacy codepage buffers cleanly", () => {
    assert.equal(parseWindowsCodePage("Active code page: 936\r\n"), "gb18030");
    assert.equal(parseWindowsCodePage("Active code page: 866\r\n"), "ibm866");
    assert.equal(parseWindowsCodePage("Active code page: 874\r\n"), "windows-874");
    assert.equal(parseWindowsCodePage("Active code page: 1253\r\n"), "windows-1253");
    assert.equal(parseWindowsCodePage("Active code page: 1255\r\n"), "windows-1255");
    assert.equal(parseWindowsCodePage("Active code page: 1257\r\n"), "windows-1257");
    assert.equal(parseWindowsCodePage("Active code page: 1258\r\n"), "windows-1258");
    assert.equal(parseWindowsCodePage("Active code page: 65001\r\n"), null);
    assert.equal(parseWindowsCodePage("no digits here"), null);

    const utf8 = Buffer.from("中文 UTF-8 输出 OK", "utf8");
    assert.equal(decodeProcessOutput(utf8, false, "gb18030"), "中文 UTF-8 输出 OK");

    // Simulate maxOutputBytes cutting a 3-byte UTF-8 character mid-sequence
    const midCut = Buffer.concat([Buffer.from("中文", "utf8"), Buffer.from([0xe8, 0xbe])]);
    assert.equal(decodeProcessOutput(midCut, true, "gb18030"), "中文");

    // GBK bytes for "'x' 不是"
    const gbk = Buffer.from("27782720b2bbcac7", "hex");
    assert.equal(decodeProcessOutput(gbk, false, "gb18030"), "'x' 不是");

    // Multi-line pure GBK preserves line endings and decodes every line
    const multiGbk = Buffer.from("27782720b2bbcac70d0a27792720b2bbcac7", "hex");
    assert.equal(decodeProcessOutput(multiGbk, false, "gb18030"), "'x' 不是\r\n'y' 不是");

    // Mixed UTF-8 + GBK lines (e.g. chained `python && node` on Windows CP936)
    // must keep valid UTF-8 lines intact instead of turning the whole buffer into mojibake
    const mixed = Buffer.concat([
      Buffer.from("ℹ pass 11\r\n", "utf8"),
      Buffer.from("构建产物校验通过 → 404\n", "utf8"),
      Buffer.from("27782720b2bbcac70d0a", "hex"),
      Buffer.from("尾部 UTF-8 保留", "utf8"),
    ]);
    assert.equal(
      decodeProcessOutput(mixed, false, "gb18030"),
      "ℹ pass 11\r\n构建产物校验通过 → 404\n'x' 不是\r\n尾部 UTF-8 保留",
    );

    // Mixed GBK line followed by a UTF-8 final line truncated mid-character
    const mixedTrunc = Buffer.concat([
      Buffer.from("27782720b2bbcac70a", "hex"),
      Buffer.from("中文", "utf8"),
      Buffer.from([0xe8, 0xbe]),
    ]);
    assert.equal(decodeProcessOutput(mixedTrunc, true, "gb18030"), "'x' 不是\n中文");
  });

  it("folds oversized command output with Head-Tail preservation and UTF-8/surrogate safety", async () => {
    const loneSurrogateRe =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    // Direct unit checks on Head-Tail helpers (ASCII, CJK, 4-byte emoji)
    const lines = [
      "HEAD_ROOT_CAUSE: TypeError at src/app.ts:12",
      ...Array.from({ length: 80 }, (_, i) => `middle noise line ${i}: ${"x".repeat(40)}`),
      "TAIL_FINAL_SUMMARY: 1 failed, 42 passed (1.2s)",
    ];
    const bigText = lines.join("\n");
    const folded = truncateHeadTailWithNotice(bigText, 420);
    assert.ok(folded.length <= 420, `expected <=420 chars, got ${folded.length}`);
    assert.match(folded, /HEAD_ROOT_CAUSE/);
    assert.match(folded, /\[truncated: folded \d+ middle chars; total \d+ chars\]/);
    assert.match(folded, /TAIL_FINAL_SUMMARY/);

    const emojiText = "头部日志🚀\n" + "中间数据🔥测试".repeat(200) + "\n尾部汇总✅完成";
    const foldedBytes = truncateHeadTailWithByteNotice(emojiText, 260);
    assert.ok(
      Buffer.byteLength(foldedBytes, "utf8") <= 260,
      `expected <=260 UTF-8 bytes, got ${Buffer.byteLength(foldedBytes, "utf8")}`,
    );
    assert.match(foldedBytes, /头部日志/);
    assert.match(foldedBytes, /\[truncated: folded \d+ middle bytes; total \d+ bytes\]/);
    assert.match(foldedBytes, /尾部汇总✅完成/);
    assert.equal(loneSurrogateRe.test(foldedBytes), false);

    // Tail slicers never create lone UTF-16 surrogates
    assert.equal(loneSurrogateRe.test(sliceSafeCharsTail("a" + "🚀".repeat(20), 5)), false);
    assert.equal(loneSurrogateRe.test(sliceUtf8BytesTail("a" + "🚀".repeat(20), 6)), false);
    assert.ok(Buffer.byteLength(sliceUtf8BytesTail("中文🚀测试", 7), "utf8") <= 7);

    // fitSectionsToByteBudget in head-tail mode preserves head + tail under tight byte cap
    const fitted = fitSectionsToByteBudget([emojiText], 500, 260, "\n\n", "head-tail");
    assert.ok(Buffer.byteLength(fitted, "utf8") <= 260);
    assert.match(fitted, /头部日志/);
    assert.match(fitted, /尾部汇总✅完成/);

    // Multi-section fitSectionsToByteBudget where BOTH maxChars and maxBytes bind must preserve all section headers
    const multiMixed = fitSectionsToByteBudget(
      [
        "## [FAIL] check-1\n" + "a".repeat(4500),
        "## [FAIL] check-2\n" + "b".repeat(4500),
        "## [FAIL] check-3\n" + "中".repeat(450) + "c".repeat(6000),
      ],
      8000,
      8800,
      "\n\n",
      "head-tail",
    );
    assert.ok(multiMixed.length <= 8000);
    assert.ok(Buffer.byteLength(multiMixed, "utf8") <= 8800);
    assert.match(multiMixed, /## \[FAIL\] check-1/);
    assert.match(multiMixed, /## \[FAIL\] check-2/);
    assert.match(multiMixed, /## \[FAIL\] check-3/);

    // Tight budgets on huge inputs never produce 0-content notices
    const tinyCharTrunc = truncateWithNotice("a".repeat(1_000_000), 49);
    assert.ok(tinyCharTrunc.length <= 49);
    assert.ok(!tinyCharTrunc.startsWith("\n... [truncated: showed 0"));
    const tinyByteTrunc = truncateWithByteNotice("a".repeat(1_000_000), 56);
    assert.ok(Buffer.byteLength(tinyByteTrunc, "utf8") <= 56);
    assert.ok(!tinyByteTrunc.startsWith("\n... [truncated: showed 0"));

    // End-to-end run_checks compact + full modes preserve actual stdout/stderr head AND tail
    // (dynamic token construction ensures tokens never appear in the echoed `$ node -e ...` line)
    const script = [
      "const h = String.fromCharCode(70,73,82,83,84) + '_OUT_HEAD';",
      "const t = String.fromCharCode(84,65,73,76) + '_OUT_END';",
      "console.error(h + ': Error in module A');",
      "for (let i = 0; i < 60; i++) console.error('Error: duplicate noisy failure line ' + i + ' ' + 'z'.repeat(60));",
      "console.error(t + ': 61 errors found in suite');",
      "process.exitCode = 1;",
    ].join(" ");
    const compactRes = await runChecks({
      outputMode: "compact",
      maxChars: 900,
      commands: [{ name: "head-tail-compact", command: `${nodeBin} -e ${JSON.stringify(script)}` }],
    });
    assert.equal(compactRes.isError, false);
    assert.ok(compactRes.text.length <= 900);
    assert.match(compactRes.text, /FIRST_OUT_HEAD: Error in module A/);
    assert.match(compactRes.text, /\[truncated: \d+ lines omitted\]/);
    assert.match(compactRes.text, /TAIL_OUT_END: 61 errors found in suite/);

    const fullRes = await runChecks({
      outputMode: "full",
      maxChars: 900,
      commands: [{ name: "head-tail-full", command: `${nodeBin} -e ${JSON.stringify(script)}` }],
    });
    assert.equal(fullRes.isError, false);
    assert.ok(fullRes.text.length <= 900);
    assert.match(fullRes.text, /FIRST_OUT_HEAD: Error in module A/);
    assert.match(fullRes.text, /\[truncated: folded \d+ middle chars; total [3-9]\d{3,} chars\]/);
    assert.match(fullRes.text, /TAIL_OUT_END: 61 errors found in suite/);
  });

  it("water-fills unused budget in full mode (with head-tail) and uses 2-pass tiered PASS+FAIL pooling in compact mode", async () => {
    const richCmd = (tag: string) =>
      `${nodeBin} -e "for (let i = 0; i < 60; i++) console.log('${tag}_LINE_' + String(i).padStart(2, '0') + '_' + 'x'.repeat(30)); console.log('${tag}' + '_END_TAIL');"`;

    const fullWf = await runChecks({
      outputMode: "full",
      maxChars: 8000,
      concurrency: 4,
      commands: [
        { name: "empty-1", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "empty-2", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "empty-3", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "empty-4", command: `${nodeBin} -e "console.log('[]')"` },
        { name: "rich-1", command: richCmd("RICH1") },
        { name: "rich-2", command: richCmd("RICH2") },
        { name: "rich-3", command: richCmd("RICH3") },
        { name: "rich-4", command: richCmd("RICH4") },
      ],
    });
    assert.equal(fullWf.isError, false);
    assert.ok(fullWf.text.length <= 8000);
    assert.ok(Buffer.byteLength(fullWf.text, "utf8") <= 8_800);
    for (const tag of ["RICH1", "RICH2", "RICH3", "RICH4"]) {
      const matches = fullWf.text.match(new RegExp(`${tag}_LINE_\\d{2}_`, "g")) ?? [];
      assert.ok(matches.length >= 30, `Expected >=30 lines for ${tag}, got ${matches.length}`);
      assert.match(fullWf.text, new RegExp(`${tag}_END_TAIL`));
    }

    // Compact mode: PASS + short FAIL donate unused space to long FAIL; dynamic tokens avoid command-echo false positives
    const longFailScript = [
      "console.log('> @app/web@1.0.0 build');",
      "console.log('> vite build');",
      "console.log('vite v5.4.0 building for production...');",
      "console.log('transforming...');",
      "console.log('✓ 40 modules transformed.');",
      "console.log('rendering chunks...');",
      "console.log('computing gzip size...');",
      "for (let i = 0; i < 15; i++) console.log('dist/assets/chunk-' + i + '.js   12.34 kB │ gzip: 4.12 kB');",
      "console.log('✓ built in 1.10s');",
      "console.error('src/root.ts(1,1): error TS2304: FIRST_' + 'LONG_FAIL_ROOT');",
      "for (let i = 0; i < 45; i++) console.error('src/mid-' + i + '.ts(10,2): error TS2322: cascade line ' + i + ' ' + 'a'.repeat(30));",
      "console.error('src/end.ts(99,5): error TS2345: FINAL_' + 'LONG_FAIL_TAIL');",
      "process.exitCode = 1;",
    ].join(" ");

    const compactWf = await runChecks({
      outputMode: "compact",
      maxChars: 2400,
      commands: [
        { name: "pass-verbose", command: `${nodeBin} -e "console.log('PASS_SUMMARY: ' + 'p'.repeat(420) + ' passed')"` },
        { name: "fail-short", command: `${nodeBin} -e "console.error('Error: SHORT_' + 'FAIL_ONLY'); process.exit(1)"` },
        { name: "fail-long", command: `${nodeBin} -e ${JSON.stringify(longFailScript)}` },
      ],
    });
    assert.equal(compactWf.isError, false);
    assert.ok(compactWf.text.length <= 2400);
    assert.match(compactWf.text, /Error: SHORT_FAIL_ONLY/);
    assert.match(compactWf.text, /FIRST_LONG_FAIL_ROOT/);
    assert.match(compactWf.text, /FINAL_LONG_FAIL_TAIL/);
    const longFailSection = compactWf.text.split("## [FAIL")[2] ?? "";
    assert.ok(longFailSection.length > 1400, `Expected water-filled fail-long > 1400 chars, got ${longFailSection.length}`);

    // Mixed ASCII neutral lines + dense CJK failure lines must converge and preserve CJK tail <= 8800 UTF-8 bytes
    const mixedCjkScript = [
      "for (let i = 0; i < 400; i++) console.log('ascii neutral build log ' + i + ' ' + 'a'.repeat(30));",
      "console.error('Error: 首个中文根因_' + 'CJK_ROOT');",
      "for (let i = 0; i < 120; i++) console.error('Error: 中文编译报错详情行_' + i + '_类型不匹配需要检查字段定义和接口约束');",
      "console.error('Error: 最终中文尾部_' + 'CJK_TAIL_FINAL');",
      "process.exitCode = 1;",
    ].join(" ");
    const cjkRes = await runChecks({
      outputMode: "compact",
      maxChars: 8000,
      commands: [{ name: "cjk-mixed", command: `${nodeBin} -e ${JSON.stringify(mixedCjkScript)}` }],
    });
    assert.equal(cjkRes.isError, false);
    assert.ok(Buffer.byteLength(cjkRes.text, "utf8") <= 8_800);
    assert.match(cjkRes.text, /首个中文根因_CJK_ROOT/);
    assert.match(cjkRes.text, /最终中文尾部_CJK_TAIL_FINAL/);
    assert.doesNotMatch(cjkRes.text, /\uFFFD/);

    // Long-named PASS-heavy batch at tight maxChars: 550 must NEVER starve the sole FAIL command
    const longNamePasses = Array.from({ length: 10 }, (_, i) => ({
      name: `very-long-workspace-package-check-name-${String(i).padStart(2, "0")}`,
      command: `${nodeBin} -e "console.log('ok')"`,
    }));
    const starveRes = await runChecks({
      outputMode: "compact",
      maxChars: 550,
      concurrency: 4,
      commands: [
        ...longNamePasses,
        {
          name: "sole-fail",
          command: `${nodeBin} -e "console.error('Error: MUST_SEE_' + 'FAIL_CAUSE'); process.exit(1)"`,
        },
      ],
    });
    assert.equal(starveRes.isError, false);
    assert.ok(starveRes.text.length <= 550);
    assert.match(starveRes.text, /MUST_SEE_FAIL_CAUSE/);

    // Multiple long [NOT RUN] commands must share capped budget so timed-out command still keeps its output
    const notRunStarve = await runChecks({
      outputMode: "compact",
      concurrency: 1,
      maxChars: 800,
      commands: [
        {
          name: "timeout-cmd",
          timeoutSec: 1,
          command: `${nodeBin} -e "console.error('HANG_' + 'ROOT_CAUSE'); setTimeout(() => {}, 5000)"`,
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          name: `not-run-${i}`,
          command: `${nodeBin} -e "const huge = '${"x".repeat(300)}'; console.log(huge)"`,
        })),
      ],
    }, 1050);
    assert.equal(notRunStarve.isError, false);
    assert.ok(notRunStarve.text.length <= 800);
    assert.match(notRunStarve.text, /TIMED OUT/);
    assert.match(notRunStarve.text, /HANG_ROOT_CAUSE/);
    assert.match(notRunStarve.text, /\[NOT RUN\] not-run-0/);
  });

  it("transparently unwraps only safe Windows powershell -Command wrappers around allowlisted CLI binaries", () => {
    // Safe allowlisted single-command wrappers -> unwrapped
    assert.equal(
      unwrapTrivialWindowsPowerShellCommand('powershell -Command "git status --short"'),
      "git status --short",
    );
    assert.equal(
      unwrapTrivialWindowsPowerShellCommand('powershell.exe -NoProfile -NonInteractive -NoLogo -c "npm test"'),
      "npm test",
    );
    assert.equal(
      unwrapTrivialWindowsPowerShellCommand("pwsh -NoP -Command 'rg \"foo bar\" src'"),
      'rg "foo bar" src',
    );
    assert.equal(
      unwrapTrivialWindowsPowerShellCommand("powershell -NoProfile -Command git log -n 5 --oneline"),
      "git log -n 5 --oneline",
    );
    assert.equal(
      unwrapTrivialWindowsPowerShellCommand('pwsh.exe -c "pytest -q tests/test_auth.py"'),
      "pytest -q tests/test_auth.py",
    );
    assert.equal(
      unwrapTrivialWindowsPowerShellCommand('powershell -Command "go test ./..."'),
      "go test ./...",
    );

    // Unsafe aliases, cmdlets, pipes, env vars, quoting edge cases, or extra flags -> NEVER unwrapped
    const mustKeepOriginal = [
      'powershell -Command "del temp.txt"',
      'powershell -Command "rm -Recurse -Force build"',
      'powershell -Command "ls -la"',
      'powershell -Command "dir"',
      'powershell -Command "echo hello"',
      'powershell -Command "curl https://example.com"',
      'powershell -Command "Get-ChildItem | Select-Object -First 5"',
      'powershell -Command "git status | findstr M"',
      'powershell -Command "git status && npm test"',
      'powershell -Command "git status; npm test"',
      'powershell -Command "git status > out.txt"',
      'powershell -Command "git log -n 5 --format=%H"',
      `powershell -Command "git log -n 5 --format='%h %s'"`,
      'powershell -Command "node -e $env:FOO"',
      'powershell -Command "git status" && echo done',
      'powershell -ExecutionPolicy Bypass -Command "git status"',
      'powershell -File build.ps1',
      'powershell -EncodedCommand Z2l0IHN0YXR1cw==',
      'powershell -WorkingDirectory C:\\repo -Command "git status"',
      'powershell -Command "git.ps1 status"',
      'powershell -Command "./git status"',
      'powershell -Command "node -e \\"console.log(1)\\""',
      "powershell -Command 'rg \"foo\\\\\" src'",
      'powershell -Command "rg foo\\\\"',
      'powershell -Command "rg foo\\\\\\\\"',
      'powershell -Command "rg \u2018foo bar\u2019 src"',
      'powershell -Command "git log \u2013oneline"',
      'powershell -Command "git\u00a0status"',
      "git status --short",
    ];
    for (const cmd of mustKeepOriginal) {
      assert.equal(
        unwrapTrivialWindowsPowerShellCommand(cmd),
        cmd,
        `Must NOT unwrap: ${cmd}`,
      );
    }
  });

  if (process.platform === "win32") {
    it("executes PowerShell $env: variables, UTF-8 Unicode output, and cmdlets cleanly on Windows", async () => {
      const prev = process.env.AGY_FAST_PWSH_TEST;
      process.env.AGY_FAST_PWSH_TEST = "pwsh_env_expanded_ok";
      try {
        const res = await runChecks({
          outputMode: "full",
          commands: [
            {
              name: "win-ps-env",
              command: `${nodeBin} -e "console.log(process.argv[1])" "$Env:AGY_FAST_PWSH_TEST"`,
            },
            {
              name: "win-ps-unicode",
              command: 'Write-Output "✔ 🚀 $Env:AGY_FAST_PWSH_TEST"',
            },
            {
              name: "win-missing-cmd-encoding",
              command: "agy_fast_nonexistent_cmd_xyz --version",
            },
          ],
        });
        assert.equal(res.isError, false);
        assert.match(res.text, /Checks: 2\/3 passed, 1 failed/);
        assert.match(res.text, /✔ 🚀 pwsh_env_expanded_ok/);
        assert.doesNotMatch(res.text, /\uFFFD/);
      } finally {
        if (prev === undefined) {
          delete process.env.AGY_FAST_PWSH_TEST;
        } else {
          process.env.AGY_FAST_PWSH_TEST = prev;
        }
      }
    });

    it("falls back cleanly without crashing when taskkill is unavailable on command timeout", async () => {
      const savedEnv = { ...process.env };
      const savedPath = process.env.PATH;
      const savedSystemRoot = process.env.SystemRoot;
      const savedWindir = process.env.WINDIR;
      try {
        // 1. Empty PATH with intact SystemRoot resolves System32\taskkill.exe directly
        process.env.PATH = "";
        const resWithSysRoot = await execBinaryAsync(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 250, env: savedEnv },
        );
        assert.equal(resWithSysRoot.timedOut, true);
        assert.notEqual(resWithSysRoot.signal, "SIGKILL");
        assert.ok(resWithSysRoot.durationMs < 1400, `expected prompt termination, got ${resWithSysRoot.durationMs}ms`);

        // 2. Empty PATH + missing SystemRoot/WINDIR emits async spawn ENOENT, handled by error listener + fallbackKill
        delete process.env.SystemRoot;
        delete process.env.WINDIR;
        const resNoTaskkill = await execBinaryAsync(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 250, env: savedEnv },
        );
        assert.equal(resNoTaskkill.timedOut, true);
        assert.notEqual(resNoTaskkill.signal, "SIGKILL");
        assert.ok(resNoTaskkill.durationMs < 1400, `expected fallbackKill before settle timer, got ${resNoTaskkill.durationMs}ms`);

        // 3. Invalid SystemRoot (nonexistent bin + invalid cwd) also emits async ENOENT handled by fallbackKill
        process.env.SystemRoot = path.join(os.tmpdir(), "agy-fast-nonexistent-sysroot");
        const resBadSysRoot = await execBinaryAsync(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 250, env: savedEnv },
        );
        assert.equal(resBadSysRoot.timedOut, true);
        assert.notEqual(resBadSysRoot.signal, "SIGKILL");
        assert.ok(resBadSysRoot.durationMs < 1400, `expected fallbackKill before settle timer, got ${resBadSysRoot.durationMs}ms`);
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
        if (savedSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = savedSystemRoot;
        if (savedWindir === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = savedWindir;
      }
    });
  }

  it("injects non-interactive git env defaults without overriding caller values", async () => {
    const base: NodeJS.ProcessEnv = { CUSTOM_VAR: "keep" };
    const defaulted = withNonInteractiveGitEnv(base);
    assert.equal(defaulted.CUSTOM_VAR, "keep");
    assert.equal(defaulted.GIT_TERMINAL_PROMPT, "0");
    assert.equal(defaulted.GCM_INTERACTIVE, "never");
    assert.equal(base.GIT_TERMINAL_PROMPT, undefined);
    assert.equal(base.GCM_INTERACTIVE, undefined);

    const overridden = withNonInteractiveGitEnv({
      GIT_TERMINAL_PROMPT: "1",
      GCM_INTERACTIVE: "always",
    });
    assert.equal(overridden.GIT_TERMINAL_PROMPT, "1");
    assert.equal(overridden.GCM_INTERACTIVE, "always");

    // Plain shallow-cloned env objects on Windows must respect case-insensitive caller keys
    const winLower = withNonInteractiveGitEnv(
      { git_terminal_prompt: "1", gcm_interactive: "auto" },
      "win32",
    );
    assert.equal(winLower.git_terminal_prompt, "1");
    assert.equal(winLower.gcm_interactive, "auto");
    assert.equal(winLower.GIT_TERMINAL_PROMPT, undefined);
    assert.equal(winLower.GCM_INTERACTIVE, undefined);

    const posixLower = withNonInteractiveGitEnv(
      { git_terminal_prompt: "1", gcm_interactive: "auto" },
      "linux",
    );
    assert.equal(posixLower.GIT_TERMINAL_PROMPT, "0");
    assert.equal(posixLower.GCM_INTERACTIVE, "never");

    const prevPrompt = process.env.GIT_TERMINAL_PROMPT;
    const prevGcm = process.env.GCM_INTERACTIVE;
    try {
      delete process.env.GIT_TERMINAL_PROMPT;
      delete process.env.GCM_INTERACTIVE;
      const defaultRes = await runChecks({
        outputMode: "full",
        commands: [
          {
            name: "git-env-default",
            command: `${nodeBin} -e "console.log(process.env.GIT_TERMINAL_PROMPT, process.env.GCM_INTERACTIVE)"`,
          },
        ],
      });
      assert.equal(defaultRes.isError, false);
      assert.match(defaultRes.text, /\b0 never\b/);

      process.env.GIT_TERMINAL_PROMPT = "1";
      process.env.GCM_INTERACTIVE = "auto";
      const overrideRes = await runChecks({
        outputMode: "full",
        commands: [
          {
            name: "git-env-override",
            command: `${nodeBin} -e "console.log(process.env.GIT_TERMINAL_PROMPT, process.env.GCM_INTERACTIVE)"`,
          },
        ],
      });
      assert.equal(overrideRes.isError, false);
      assert.match(overrideRes.text, /\b1 auto\b/);
    } finally {
      if (prevPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = prevPrompt;
      if (prevGcm === undefined) delete process.env.GCM_INTERACTIVE;
      else process.env.GCM_INTERACTIVE = prevGcm;
    }
  });

  it("surfaces OOM/fatal exit codes and POSIX signal names in run_checks output", async () => {
    const compactRes = await runChecks({
      outputMode: "compact",
      commands: [
        {
          name: "oom-exit-137",
          command: `${nodeBin} -e "process.exit(137)"`,
        },
      ],
    });
    assert.equal(compactRes.isError, false);
    assert.match(compactRes.text, /FAIL \(exit 137 \/ SIGKILL - possible OOM\)/);
    assert.match(compactRes.text, /Terminated \(exit 137 \/ SIGKILL - possible OOM\)/);

    const fullRes = await runChecks({
      outputMode: "full",
      commands: [
        {
          name: "segv-exit-139",
          command: `${nodeBin} -e "process.exit(139)"`,
        },
      ],
    });
    assert.equal(fullRes.isError, false);
    assert.match(fullRes.text, /\[FAIL \(exit 139 \/ SIGSEGV - segmentation fault\)\]/);

    if (process.platform !== "win32") {
      const sigRes = await runChecks({
        outputMode: "compact",
        commands: [
          {
            name: "direct-sigkill",
            command: `exec ${nodeBin} -e "process.kill(process.pid, 'SIGKILL')"`,
          },
        ],
      });
      assert.equal(sigRes.isError, false);
      assert.match(sigRes.text, /FAIL \(SIGKILL - possible OOM\)/);
      assert.match(sigRes.text, /Terminated by SIGKILL - possible OOM/);
    }
  });
});
