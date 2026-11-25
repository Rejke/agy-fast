import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { isGitInternalPath, runApplyEdits, type FileEdit } from "../src/tools/apply-edits.js";

describe("apply_edits", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-edits-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies multiple non-contiguous hunks across multiple files atomically", async () => {
    const fileA = path.join(tmpDir, "a.ts");
    const fileB = path.join(tmpDir, "b.ts");
    await fs.writeFile(
      fileA,
      ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n"),
      "utf8",
    );
    await fs.writeFile(fileB, "export const flag = false;\n", "utf8");

    const res = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "a.ts",
          hunks: [
            { target: "const a = 1;", replacement: "const a = 10;" },
            { target: "const d = 4;", replacement: "const d = 40;" },
          ],
        },
        {
          path: "b.ts",
          hunks: [
            { target: "flag = false", replacement: "flag = true" },
          ],
        },
        {
          path: "nested/created.txt",
          create: "hello new file\n",
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.equal(
      await fs.readFile(fileA, "utf8"),
      ["const a = 10;", "const b = 2;", "const c = 3;", "const d = 40;"].join("\n"),
    );
    assert.equal(await fs.readFile(fileB, "utf8"), "export const flag = true;\n");
    assert.equal(
      await fs.readFile(path.join(tmpDir, "nested", "created.txt"), "utf8"),
      "hello new file\n",
    );
  });

  it("modifies zero files when any hunk fails across any file (all-or-nothing)", async () => {
    const goodFile = path.join(tmpDir, "good.txt");
    const badFile = path.join(tmpDir, "bad.txt");
    await fs.writeFile(goodFile, "original good\n", "utf8");
    await fs.writeFile(badFile, "original bad\n", "utf8");

    const res = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "good.txt",
          hunks: [{ target: "original good", replacement: "MODIFIED GOOD" }],
        },
        {
          path: "bad.txt",
          hunks: [{ target: "nonexistent text", replacement: "nope" }],
        },
      ],
    });

    assert.equal(res.isError, true);
    assert.match(res.text, /0 files modified/);
    assert.equal(await fs.readFile(goodFile, "utf8"), "original good\n");
    assert.equal(await fs.readFile(badFile, "utf8"), "original bad\n");
  });

  it("uses startLine/endLine to disambiguate duplicate text and rejects ambiguous matches", async () => {
    const dupFile = path.join(tmpDir, "dup.ts");
    await fs.writeFile(
      dupFile,
      [
        "function one() {",
        "  return value;",
        "}",
        "function two() {",
        "  return value;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const ambig = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "dup.ts",
          hunks: [{ target: "return value;", replacement: "return 2;" }],
        },
      ],
    });
    assert.equal(ambig.isError, true);
    assert.match(ambig.text, /matched 2 times \(lines: 2, 5\)/);

    const anchored = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "dup.ts",
          hunks: [
            {
              target: "return value;",
              replacement: "return 2;",
              startLine: 4,
              endLine: 6,
            },
          ],
        },
      ],
    });
    assert.equal(anchored.isError, false);
    const updated = await fs.readFile(dupFile, "utf8");
    assert.match(updated, /one\(\) \{\n  return value;/);
    assert.match(updated, /two\(\) \{\n  return 2;/);
  });

  it("supports replaceAll, merges duplicate file entries, and rejects overlapping hunks", async () => {
    const f = path.join(tmpDir, "merge.txt");
    await fs.writeFile(f, "alpha beta alpha gamma\n", "utf8");

    const overlap = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "merge.txt",
          hunks: [
            { target: "alpha beta", replacement: "X" },
            { target: "beta alpha", replacement: "Y" },
          ],
        },
      ],
    });
    assert.equal(overlap.isError, true);
    assert.match(overlap.text, /overlap/);

    const merged = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "merge.txt",
          hunks: [{ target: "alpha", replacement: "ALPHA", replaceAll: true }],
        },
        {
          path: "merge.txt",
          hunks: [{ target: "gamma", replacement: "GAMMA" }],
        },
      ],
    });
    assert.equal(merged.isError, false);
    assert.equal(await fs.readFile(f, "utf8"), "ALPHA beta ALPHA GAMMA\n");
  });

  it("preserves CRLF line endings and supports dryRun", async () => {
    const crlfFile = path.join(tmpDir, "win.txt");
    await fs.writeFile(crlfFile, "line1\r\nline2\r\nline3\r\n", "utf8");

    const dry = await runApplyEdits({
      cwd: tmpDir,
      dryRun: true,
      edits: [
        {
          path: "win.txt",
          hunks: [{ target: "line1\nline2", replacement: "LINE1\nLINE2" }],
        },
      ],
    });
    assert.equal(dry.isError, false);
    assert.match(dry.text, /Dry run/);
    assert.equal(await fs.readFile(crlfFile, "utf8"), "line1\r\nline2\r\nline3\r\n");

    const real = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "win.txt",
          hunks: [{ target: "line1\nline2", replacement: "LINE1\nLINE2" }],
        },
      ],
    });
    assert.equal(real.isError, false);
    assert.equal(await fs.readFile(crlfFile, "utf8"), "LINE1\r\nLINE2\r\nline3\r\n");
  });

  it("runs inline verify command on pass and fail", async () => {
    const f = path.join(tmpDir, "check.js");
    await fs.writeFile(f, "const x = 1;\n", "utf8");

    const passRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "check.js", hunks: [{ target: "x = 1", replacement: "x = 2" }] },
      ],
      verify: `${JSON.stringify(process.execPath)} -e "console.log('12 tests passed')"`,
    });
    assert.equal(passRes.isError, false);
    assert.match(passRes.text, /Verify \[PASS/);
    assert.match(passRes.text, /12 tests passed/);

    const failRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "check.js", hunks: [{ target: "x = 2", replacement: "x = 3" }] },
      ],
      verify: `${JSON.stringify(process.execPath)} -e "console.error('TypeError: bad value'); process.exit(1)"`,
    });
    assert.equal(failRes.isError, false);
    assert.match(failRes.text, /Verify \[FAIL \(exit 1\)/);
    assert.match(failRes.text, /TypeError: bad value/);
    assert.equal(await fs.readFile(f, "utf8"), "const x = 3;\n");
  });

  it("refuses overwriting existing file with create unless overwrite is true", async () => {
    const f = path.join(tmpDir, "exist.txt");
    await fs.writeFile(f, "keep me\n", "utf8");

    const blocked = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "exist.txt", create: "new\n" }],
    });
    assert.equal(blocked.isError, true);
    assert.equal(await fs.readFile(f, "utf8"), "keep me\n");

    const allowed = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "exist.txt", create: "replaced\n", overwrite: true }],
    });
    assert.equal(allowed.isError, false);
    assert.equal(await fs.readFile(f, "utf8"), "replaced\n");
  });

  it("preserves file permissions, follows symlinks, reports accurate line counts, and validates line bounds", async () => {
    const scriptPath = path.join(tmpDir, "tool.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\necho v1\n", "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(scriptPath, 0o755);
    }

    const realFile = path.join(tmpDir, "real-target.txt");
    const symFile = path.join(tmpDir, "sym-link.txt");
    await fs.writeFile(realFile, "hello link\n", "utf8");
    await fs.symlink(realFile, symFile);

    const editRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "tool.sh", hunks: [{ target: "v1", replacement: "v2" }] },
        { path: "sym-link.txt", hunks: [{ target: "hello", replacement: "updated" }] },
        { path: "real-target.txt", hunks: [{ target: "link", replacement: "target" }] },
        { path: "single-line.txt", create: "only one line\n" },
      ],
    });

    assert.equal(editRes.isError, false);
    assert.match(editRes.text, /single-line\.txt: created, lines \+1/);
    assert.equal(await fs.readFile(scriptPath, "utf8"), "#!/bin/sh\necho v2\n");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(scriptPath)).mode & 0o777, 0o755);
    }
    assert.equal((await fs.lstat(symFile)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(realFile, "utf8"), "updated target\n");

    const badLine = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "real-target.txt",
          hunks: [{ target: "updated", replacement: "x", startLine: Number.NaN }],
        },
      ],
    });
    assert.equal(badLine.isError, true);
    assert.match(badLine.text, /Invalid startLine/);
  });

  it("rolls back content and permissions if a later write fails in Phase 2", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const okPath = path.join(tmpDir, "rb-ok.sh");
    const lockedDir = path.join(tmpDir, "rb-locked");
    const lockedFile = path.join(lockedDir, "blocked.txt");
    await fs.mkdir(lockedDir, { recursive: true });
    await fs.writeFile(okPath, "#!/bin/sh\necho orig\n", "utf8");
    await fs.chmod(okPath, 0o755);
    await fs.writeFile(lockedFile, "locked orig\n", "utf8");
    await fs.chmod(lockedFile, 0o444);
    await fs.chmod(lockedDir, 0o555);

    try {
      const res = await runApplyEdits({
        cwd: tmpDir,
        edits: [
          { path: "rb-ok.sh", hunks: [{ target: "orig", replacement: "changed" }] },
          { path: "rb-locked/blocked.txt", hunks: [{ target: "orig", replacement: "changed" }] },
        ],
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /rolled back/);
      assert.equal(await fs.readFile(okPath, "utf8"), "#!/bin/sh\necho orig\n");
      assert.equal((await fs.stat(okPath)).mode & 0o777, 0o755);
    } finally {
      await fs.chmod(lockedDir, 0o755);
      await fs.chmod(lockedFile, 0o644);
    }
  });

  it("includes closest-match line snippets when target misses without startLine/endLine and supports bestEffort partial commits", async () => {
    const okFile = path.join(tmpDir, "be-ok.java");
    const missFile = path.join(tmpDir, "be-miss.java");
    await fs.writeFile(okFile, "public class Ok {\n  int value = 1;\n}\n", "utf8");
    await fs.writeFile(
      missFile,
      [
        "public class ShopIncome {",
        "  public static String label(String source) {",
        "    return switch (source) {",
        '      case "ERP" -> "实付";',
        '      case "EST" -> "估算";',
        '      default -> "未知";',
        "    };",
        "  }",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );

    // Without startLine/endLine, atomic mode still reports closest match snippet
    const atomicMiss = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "be-miss.java",
          hunks: [
            {
              target: '    return switch (source) {\n      case "ERP" -> "WRONG";\n    };',
              replacement: "    return source;",
            },
          ],
        },
      ],
    });
    assert.equal(atomicMiss.isError, true);
    assert.match(atomicMiss.text, /Closest match near line 3/);
    assert.match(atomicMiss.text, /case "ERP" -> "实付"/);

    // bestEffort: true writes valid files, keeps failed file intact with snippet, and skips verify
    const partial = await runApplyEdits({
      cwd: tmpDir,
      bestEffort: true,
      verify: `${JSON.stringify(process.execPath)} -e "console.log('SHOULD_NOT_RUN')"`,
      edits: [
        {
          path: "be-ok.java",
          hunks: [{ target: "int value = 1;", replacement: "int value = 2;" }],
        },
        {
          path: "be-miss.java",
          hunks: [
            {
              target: '    return switch (source) {\n      case "ERP" -> "WRONG";\n    };',
              replacement: "    return source;",
            },
          ],
        },
      ],
    });
    assert.equal(partial.isError, true);
    assert.match(partial.text, /Partial edit applied \(1\/2 file\(s\) written; 1 file\(s\) failed/);
    assert.match(partial.text, /be-ok\.java: updated/);
    assert.match(partial.text, /Closest match near line 3/);
    assert.match(partial.text, /Verify skipped/);
    assert.doesNotMatch(partial.text, /SHOULD_NOT_RUN/);
    assert.equal(await fs.readFile(okFile, "utf8"), "public class Ok {\n  int value = 2;\n}\n");
    assert.match(await fs.readFile(missFile, "utf8"), /case "ERP" -> "实付"/);
  });

  it("detects line-drifted exact matches, bounds wide-range failure snippets, and filters Spring/Pino verify noise", async () => {
    const bigPath = path.join(tmpDir, "drift.ts");
    const lines = [
      ...Array.from({ length: 85 }, (_, i) => `const filler_${i + 1} = ${i + 1};`),
      "function targetBlock() {",
      "  const answer = 42;",
      "  return answer;",
      "}",
    ];
    await fs.writeFile(bigPath, lines.join("\n") + "\n", "utf8");

    // 1. Exact target exists outside startLine..endLine -> reports exact drifted line
    const driftRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 40,
              target: "function targetBlock() {\n  const answer = 42;",
              replacement: "function targetBlock() {\n  const answer = 99;",
            },
          ],
        },
      ],
    });
    assert.equal(driftRes.isError, true);
    assert.match(driftRes.text, /Exact match found outside range at L86-L87/);

    // 2. Wide range (>26 lines) mismatch uses closest-region snippet instead of dumping 85 lines
    const wideRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 89,
              target: "function targetBlock() {\n  const answer = 999;",
              replacement: "function targetBlock() {\n  const answer = 100;",
            },
          ],
        },
      ],
    });
    assert.equal(wideRes.isError, true);
    assert.match(wideRes.text, /Closest match near line 86/);
    assert.ok(wideRes.text.length < 1500, `Expected compact hint, got ${wideRes.text.length} chars`);

    // 3. Verify compact output strips Pino level:30 JSON noise + Maven Help footer and preserves Spring Description + Caused by
    const noisyVerifyScript = [
      'for (let i = 0; i < 80; i++) console.log(JSON.stringify({ level: 30, msg: "incoming request", reqId: i, payload: "x".repeat(60) }));',
      'console.log("Description:");',
      'console.log("Parameter 1 of constructor in AfterSaleController required a bean of type AfterSaleQueryService.");',
      'console.log("Action:");',
      'console.log("Consider defining a bean of type AfterSaleQueryService.");',
      'for (let i = 0; i < 40; i++) console.log("    at com.example.Framework.invoke(Framework.java:" + i + ")");',
      'console.log("Caused by: java.sql.SQLSyntaxErrorException: Unknown column shop_avatar");',
      'console.log("[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.");',
      'console.log("[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException");',
      "process.exitCode = 1;",
    ].join(" ");
    const verifyRes = await runApplyEdits({
      cwd: tmpDir,
      maxVerifyChars: 20_000,
      verify: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(noisyVerifyScript)}`,
      edits: [
        {
          path: "drift.ts",
          hunks: [{ target: "const filler_1 = 1;", replacement: "const filler_1 = 10;" }],
        },
      ],
    });
    const verifyBody = verifyRes.text.split("`:\n")[1] ?? "";
    assert.equal(verifyRes.isError, false);
    assert.ok(Buffer.byteLength(verifyRes.text, "utf8") <= 8_800);
    assert.match(verifyBody, /AfterSaleQueryService/);
    assert.match(verifyBody, /Caused by: java\.sql\.SQLSyntaxErrorException/);
    assert.doesNotMatch(verifyBody, /incoming request/);
    assert.doesNotMatch(verifyBody, /\[Help 1\]/);
  });

  it("circuit-breaks corrupted call_mcp_tool nested edits (booleans/null) and accepts stringified JSON arrays", async () => {
    const file = path.join(tmpDir, "corrupt-test.ts");
    await fs.writeFile(file, "export const x = 1;\n", "utf8");

    // Client serialization bug: edits collapsed to [false, true] or [null]
    const boolRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [false, true] as unknown as never[],
    });
    assert.equal(boolRes.isError, true);
    assert.match(boolRes.text, /nested argument serialization corruption/i);
    assert.match(boolRes.text, /edits\[0\]: received boolean \(false\)/);
    assert.match(boolRes.text, /edits\[1\]: received boolean \(true\)/);
    assert.match(boolRes.text, /Do NOT retry the same apply_edits payload/);
    assert.match(boolRes.text, /edit_file/);

    const nullRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [null, null] as unknown as never[],
    });
    assert.equal(nullRes.isError, true);
    assert.match(nullRes.text, /edits\[0\]: received null/);

    // Nested hunks collapsed to boolean/null
    const hunkRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "corrupt-test.ts", hunks: [true] }] as unknown as never[],
    });
    assert.equal(hunkRes.isError, true);
    assert.match(hunkRes.text, /edits\[0\]\.hunks\[0\]: received boolean \(true\)/);

    const hunksBoolRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "corrupt-test.ts", hunks: true }] as unknown as never[],
    });
    assert.equal(hunksBoolRes.isError, true);
    assert.match(hunksBoolRes.text, /edits\[0\]\.hunks: received boolean \(true\)/);

    // Top-level edits collapsed to boolean
    const topBool = await runApplyEdits({
      cwd: tmpDir,
      edits: true as unknown as never[],
    });
    assert.equal(topBool.isError, true);
    assert.match(topBool.text, /edits: received boolean \(true\)/);

    // Verify file remained untouched
    assert.equal(await fs.readFile(file, "utf8"), "export const x = 1;\n");

    // Stringified JSON array tolerance works cleanly
    const stringifiedRes = await runApplyEdits({
      cwd: tmpDir,
      edits: JSON.stringify([
        {
          path: "corrupt-test.ts",
          hunks: [{ target: "export const x = 1;", replacement: "export const x = 42;" }],
        },
      ]) as unknown as never[],
    });
    assert.equal(stringifiedRes.isError, false);
    assert.equal(await fs.readFile(file, "utf8"), "export const x = 42;\n");
  });

  it("treats an empty edits array as lost arguments and reports invalid JSON strings", async () => {
    const file = path.join(tmpDir, "empty-edits.ts");
    await fs.writeFile(file, "export const y = 1;\n", "utf8");

    // agy CLI 1.5.x can deliver a long native edits array as [] (or stringified "[]", "true", "null").
    for (const emptyPayload of [[], "[]"]) {
      const emptyRes = await runApplyEdits({ cwd: tmpDir, edits: emptyPayload as unknown as never[] });
      assert.equal(emptyRes.isError, true);
      assert.match(emptyRes.text, /nested argument serialization corruption/i);
      assert.match(emptyRes.text, /edits: received array \(len=0\)/);
      assert.match(emptyRes.text, /Do NOT retry the same apply_edits payload/);
      assert.match(emptyRes.text, /edit_file/);
    }

    for (const [lit, expectedLabel] of [
      ["true", /boolean \(true\)/],
      ["false", /boolean \(false\)/],
      ["null", /received null/],
    ] as const) {
      const litRes = await runApplyEdits({ cwd: tmpDir, edits: lit });
      assert.equal(litRes.isError, true);
      assert.match(litRes.text, /nested argument serialization corruption/i);
      assert.match(litRes.text, expectedLabel);
    }

    // Truncated JSON, markdown-fenced JSON, and single-object JSON all surface invalid_json clearly
    for (const badPayload of [
      '[{"path": "empty-edits.ts", "hunks": [{"target": "1;", "replacement": "2;"}]',
      '```json\n[{"path": "empty-edits.ts"}]\n```',
      '{"path": "empty-edits.ts", "hunks": []}',
    ]) {
      const badJson = await runApplyEdits({ cwd: tmpDir, edits: badPayload });
      assert.equal(badJson.isError, true);
      assert.match(badJson.text, /^Error: 'edits' is not a valid JSON array \(0 files modified\): \S/);
    }

    const emptyStr = await runApplyEdits({ cwd: tmpDir, edits: "   " });
    assert.equal(emptyStr.isError, true);
    assert.match(emptyStr.text, /non-empty JSON array string \(or array\)/);
    assert.equal(await fs.readFile(file, "utf8"), "export const y = 1;\n");
  });

  function makeErrnoError(code: string, message: string): NodeJS.ErrnoException {
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it("does not fall back to direct write or leave tmp files when temp write fails in Phase 2", async () => {
    const subDir = path.join(tmpDir, "phase2-tmp-fail");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);
    const firstFile = path.join(realSubDir, "first.txt");
    const targetFile = path.join(realSubDir, "target.txt");
    await fs.writeFile(firstFile, "first orig\n", "utf8");
    await fs.writeFile(targetFile, "target orig\n", "utf8");

    const origWriteFile = fs.writeFile;
    let directWriteAttempted = false;
    fs.writeFile = (async (...args: Parameters<typeof origWriteFile>) => {
      const p = String(args[0]);
      if (path.basename(p).startsWith(".agy-tmp-") && String(args[1]).includes("target mod")) {
        await origWriteFile(p, "partial");
        throw makeErrnoError("ENOSPC", "ENOSPC: no space left on device");
      }
      if (p === targetFile) {
        directWriteAttempted = true;
        await origWriteFile(p, "");
        throw makeErrnoError("ENOSPC", "ENOSPC: no space left on device");
      }
      return origWriteFile(...args);
    }) as typeof fs.writeFile;

    try {
      const res = await runApplyEdits({
        cwd: realSubDir,
        edits: [
          { path: "first.txt", hunks: [{ target: "first orig", replacement: "first mod" }] },
          { path: "target.txt", hunks: [{ target: "target orig", replacement: "target mod" }] },
        ],
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /Write failed \(changes rolled back\)/);
      assert.match(res.text, /ENOSPC/);
      assert.equal(directWriteAttempted, false);
    } finally {
      fs.writeFile = origWriteFile;
    }

    assert.equal(await fs.readFile(firstFile, "utf8"), "first orig\n");
    assert.equal(await fs.readFile(targetFile, "utf8"), "target orig\n");
    assert.equal((await fs.readdir(realSubDir)).some((n) => n.startsWith(".agy-tmp-")), false);
  });

  it("rolls back target file and removes partial created file when rename and fallback direct write both fail", async () => {
    const subDir = path.join(tmpDir, "phase2-fallback-fail");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);
    const firstFile = path.join(realSubDir, "first.txt");
    const targetFile = path.join(realSubDir, "target.txt");
    const newFile = path.join(realSubDir, "created-fail.txt");
    await fs.writeFile(firstFile, "first orig\n", "utf8");
    await fs.writeFile(targetFile, "target orig\n", "utf8");

    const origRename = fs.rename;
    const origWriteFile = fs.writeFile;
    let targetWriteCalls = 0;

    fs.rename = (async (...args: Parameters<typeof origRename>) => {
      if (String(args[1]) === targetFile || String(args[1]) === newFile) {
        throw makeErrnoError("EXDEV", "EXDEV: cross-device link not permitted");
      }
      return origRename(...args);
    }) as typeof fs.rename;

    fs.writeFile = (async (...args: Parameters<typeof origWriteFile>) => {
      const p = String(args[0]);
      if (p === targetFile && ++targetWriteCalls === 1) {
        await origWriteFile(p, "");
        throw makeErrnoError("EIO", "EIO: i/o error");
      }
      if (p === newFile) {
        await origWriteFile(p, "");
        throw makeErrnoError("EIO", "EIO: i/o error");
      }
      return origWriteFile(...args);
    }) as typeof fs.writeFile;

    try {
      const existingRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [
          { path: "first.txt", hunks: [{ target: "first orig", replacement: "first mod" }] },
          { path: "target.txt", hunks: [{ target: "target orig", replacement: "target mod" }] },
        ],
      });
      assert.equal(existingRes.isError, true);
      assert.match(existingRes.text, /Write failed \(changes rolled back\)/);
      assert.match(existingRes.text, /EIO/);
      assert.equal(targetWriteCalls, 2);

      const createdRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "created-fail.txt", create: "new content\n" }],
      });
      assert.equal(createdRes.isError, true);
      assert.match(createdRes.text, /Write failed \(changes rolled back\)/);
      assert.match(createdRes.text, /EIO/);
    } finally {
      fs.rename = origRename;
      fs.writeFile = origWriteFile;
    }

    assert.equal(await fs.readFile(firstFile, "utf8"), "first orig\n");
    assert.equal(await fs.readFile(targetFile, "utf8"), "target orig\n");
    await assert.rejects(() => fs.stat(newFile), { code: "ENOENT" });
    assert.equal((await fs.readdir(realSubDir)).some((n) => n.startsWith(".agy-tmp-")), false);
  });

  it("fails fast on non-ENOENT errors in create without overwriting or deleting existing files", async () => {
    const subDir = path.join(tmpDir, "create-non-enoent");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);
    const statErrFile = path.join(realSubDir, "stat-err.txt");
    const busyFile = path.join(realSubDir, "busy.txt");
    const otherFile = path.join(realSubDir, "other.txt");
    await fs.writeFile(statErrFile, "keep stat-err\n", "utf8");
    await fs.writeFile(busyFile, "precious original\n", "utf8");
    await fs.writeFile(otherFile, "other orig\n", "utf8");

    const origStat = fs.stat;
    fs.stat = (async (...args: Parameters<typeof origStat>) => {
      if (String(args[0]) === statErrFile) {
        throw makeErrnoError("EACCES", `EACCES: permission denied, stat '${statErrFile}'`);
      }
      return origStat(...args);
    }) as typeof fs.stat;

    try {
      const statRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "stat-err.txt", create: "clobbered\n" }],
      });
      assert.equal(statRes.isError, true);
      assert.match(statRes.text, /0 files modified/);
      assert.match(statRes.text, /EACCES/);
    } finally {
      fs.stat = origStat;
    }
    assert.equal(await fs.readFile(statErrFile, "utf8"), "keep stat-err\n");

    const origReadFile = fs.readFile;
    fs.readFile = (async (...args: Parameters<typeof origReadFile>) => {
      if (String(args[0]) === busyFile) {
        throw makeErrnoError("EBUSY", `EBUSY: resource busy or locked, open '${busyFile}'`);
      }
      return origReadFile(...args);
    }) as typeof fs.readFile;

    try {
      const atomicRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [
          { path: "busy.txt", create: "replaced\n", overwrite: true },
          { path: "other.txt", hunks: [{ target: "other orig", replacement: "other mod" }] },
        ],
      });
      assert.equal(atomicRes.isError, true);
      assert.match(atomicRes.text, /0 files modified/);
      assert.match(atomicRes.text, /EBUSY/);

      const partialRes = await runApplyEdits({
        cwd: realSubDir,
        bestEffort: true,
        edits: [
          { path: "busy.txt", create: "replaced\n", overwrite: true },
          { path: "other.txt", hunks: [{ target: "other orig", replacement: "other mod" }] },
        ],
      });
      assert.equal(partialRes.isError, true);
      assert.match(partialRes.text, /Partial edit applied \(1\/2 file\(s\) written; 1 file\(s\) failed/);
      assert.match(partialRes.text, /EBUSY/);
    } finally {
      fs.readFile = origReadFile;
    }

    assert.equal(await fs.readFile(busyFile, "utf8"), "precious original\n");
    assert.equal(await fs.readFile(otherFile, "utf8"), "other mod\n");
  });

  it("protects dangling symlinks on create, preserves majority LF EOL, validates verify before writes, and avoids lone surrogates", async () => {
    const subDir = path.join(tmpDir, "hardening-edge");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);

    // 1. Dangling symlink protection (overwrite: false refuses; overwrite: true restores symlink on Phase-2 rollback)
    const danglingLink = path.join(realSubDir, "dangling.txt");
    let createdFileSymlink = false;
    try {
      await fs.symlink("missing-target.txt", danglingLink);
      createdFileSymlink = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "ENOTSUP")) {
        throw err;
      }
    }
    if (createdFileSymlink) {
      const blockedSym = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "dangling.txt", create: "clobbered\n", overwrite: false }],
      });
      assert.equal(blockedSym.isError, true);
      assert.match(blockedSym.text, /dangling symlink/);
      assert.equal((await fs.lstat(danglingLink)).isSymbolicLink(), true);

      const failTarget = path.join(realSubDir, "fail-after.txt");
      await fs.writeFile(failTarget, "orig\n", "utf8");
      const origRename = fs.rename;
      const origWriteFile = fs.writeFile;
      fs.rename = (async (...args: Parameters<typeof origRename>) => {
        if (String(args[1]) === failTarget) throw makeErrnoError("EXDEV", "EXDEV");
        return origRename(...args);
      }) as typeof fs.rename;
      fs.writeFile = (async (...args: Parameters<typeof origWriteFile>) => {
        if (String(args[0]) === failTarget) throw makeErrnoError("EIO", "EIO");
        return origWriteFile(...args);
      }) as typeof fs.writeFile;
      try {
        const rbSym = await runApplyEdits({
          cwd: realSubDir,
          edits: [
            { path: "dangling.txt", create: "replaced\n", overwrite: true },
            { path: "fail-after.txt", hunks: [{ target: "orig", replacement: "mod" }] },
          ],
        });
        assert.equal(rbSym.isError, true);
        assert.match(rbSym.text, /rolled back/);
      } finally {
        fs.rename = origRename;
        fs.writeFile = origWriteFile;
      }
      assert.equal((await fs.lstat(danglingLink)).isSymbolicLink(), true);
      assert.equal(await fs.readlink(danglingLink), "missing-target.txt");
    }

    // 2. Symlinked parent directory deduplication for new files
    const realChildDir = path.join(realSubDir, "real-dir");
    const symChildDir = path.join(realSubDir, "sym-dir");
    await fs.mkdir(realChildDir, { recursive: true });
    await fs.symlink(realChildDir, symChildDir, process.platform === "win32" ? "junction" : "dir");
    const dupCreate = await runApplyEdits({
      cwd: realSubDir,
      edits: [
        { path: "real-dir/new.ts", create: "a\n" },
        { path: "sym-dir/new.ts", create: "b\n" },
      ],
    });
    assert.equal(dupCreate.isError, true);
    assert.match(dupCreate.text, /duplicate entries cannot mix 'create'/);

    // 3. Single CRLF in an LF-majority script must NOT rewrite the whole file to CRLF,
    //    while preserving untouched lines' exact original line endings
    const scriptPath = path.join(realSubDir, "run.sh");
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\necho 1\r\necho 2\necho 3\n", "utf8");
    const lfRes = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "run.sh", hunks: [{ target: "echo 3", replacement: "echo 4" }] }],
    });
    assert.equal(lfRes.isError, false);
    const scriptAfter = await fs.readFile(scriptPath, "utf8");
    assert.ok(scriptAfter.startsWith("#!/usr/bin/env bash\n"));
    assert.equal(scriptAfter, "#!/usr/bin/env bash\necho 1\r\necho 2\necho 4\n");

    // 4. Malformed verify fails validation BEFORE writing files; non-finite verifyTimeoutSec/maxVerifyChars stay safe
    const verifyFile = path.join(realSubDir, "v.ts");
    await fs.writeFile(verifyFile, "export const v = 1;\n", "utf8");
    const badVerify = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "v.ts", hunks: [{ target: "v = 1", replacement: "v = 2" }] }],
      verify: { command: true as unknown as string },
    });
    assert.equal(badVerify.isError, true);
    assert.match(badVerify.text, /0 files modified/);
    assert.equal(await fs.readFile(verifyFile, "utf8"), "export const v = 1;\n");

    const nanVerify = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "v.ts", hunks: [{ target: "v = 1", replacement: "v = 2" }] }],
      verify: `${JSON.stringify(process.execPath)} -e "console.log('verify ok')"`,
      verifyTimeoutSec: Number.NaN,
      maxVerifyChars: Number.NaN,
    });
    assert.equal(nanVerify.isError, false);
    assert.match(nanVerify.text, /Verify \[PASS/);
    assert.match(nanVerify.text, /verify ok/);

    // 5. Long emoji line in mismatch snippet does not emit a lone surrogate
    const emojiFile = path.join(realSubDir, "emoji.ts");
    await fs.writeFile(emojiFile, `const token = "${"x".repeat(142)}${"🚀".repeat(30)}";\n`, "utf8");
    const emojiMiss = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "emoji.ts", hunks: [{ startLine: 1, endLine: 1, target: "nonexistent", replacement: "y" }] }],
    });
    assert.equal(emojiMiss.isError, true);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiMiss.text),
      false,
    );
  });

  it("folds green multi-package Vite build logs on verify failure and surfaces the TS error cleanly", async () => {
    const f = path.join(tmpDir, "vite-verify.ts");
    await fs.writeFile(f, "export const count = 1;\n", "utf8");

    const scriptFile = path.join(tmpDir, "mock-vite-monorepo-fail.mjs");
    await fs.writeFile(
      scriptFile,
      [
        "const lines = [",
        '  "> @demo/shared@1.0.0 build /repo/packages/shared",',
        '  "> vite build",',
        '  "",',
        '  "vite v5.4.1 building for production...",',
        '  "transforming...",',
        '  "✓ 34 modules transformed.",',
        '  "rendering chunks...",',
        '  "computing gzip size...",',
        '  "dist/shared.js          14.22 kB │ gzip: 4.88 kB",',
        '  "dist/shared.css          2.10 kB │ gzip: 0.72 kB",',
        '  "✓ built in 0.94s",',
        '  "",',
        '  "> @demo/ui@1.0.0 build /repo/packages/ui",',
        '  "> vite build",',
        '  "",',
        '  "vite v5.4.1 building for production...",',
        '  "transforming...",',
        '  "✓ 68 modules transformed.",',
        '  "rendering chunks...",',
        '  "computing gzip size...",',
        '  "dist/ui.js              42.15 kB │ gzip: 12.90 kB",',
        '  "✓ built in 1.41s",',
        '  "",',
        '  "> @demo/web@1.0.0 typecheck /repo/packages/web",',
        '  "src/Table.tsx(42,11): error TS2322: Type \'string\' is not assignable to type \'number\'.",',
        '  "  42 | const rows: number = \\"invalid\\";",',
        '  "     |       ~~~~",',
        '  "Found 1 error in src/Table.tsx:42",',
        "];",
        'console.log(lines.join("\\n"));',
        "process.exitCode = 2;",
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await runApplyEdits({
      cwd: tmpDir,
      maxVerifyChars: 4000,
      edits: [
        { path: "vite-verify.ts", hunks: [{ target: "count = 1", replacement: "count = 2" }] },
      ],
      verify: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)}`,
    });

    assert.equal(res.isError, false);
    assert.equal(await fs.readFile(f, "utf8"), "export const count = 2;\n");
    assert.match(res.text, /Verify \[FAIL \(exit 2\)/);
    assert.match(res.text, /\.\.\. \(collapsed \d+ build\/pass lines; last:/);
    assert.doesNotMatch(res.text, /dist\/shared\.js/);
    assert.match(res.text, /src\/Table\.tsx\(42,11\): error TS2322/);
    assert.match(res.text, /Found 1 error in src\/Table\.tsx:42/);
  });

  it("reports full Lstart-Lend ranges on drifted multi-line targets (with/without trailing LF) and single Lstart on single-line targets", async () => {
    const rangeFile = path.join(tmpDir, "drift-ranges.ts");
    const lines = [
      ...Array.from({ length: 9 }, (_, i) => `const pad_${i + 1} = ${i + 1};`),
      "const blockA = 1;", // L10
      "const blockB = 2;", // L11
      "const blockC = 3;", // L12
      ...Array.from({ length: 7 }, (_, i) => `const mid_${i + 1} = ${i + 1};`),
      "const blockA = 1;", // L20
      "const blockB = 2;", // L21
      "const blockC = 3;", // L22
    ];
    await fs.writeFile(rangeFile, lines.join("\n") + "\n", "utf8");

    // 1. Multi-line target WITHOUT trailing newline drifted outside window -> L10-L12, L20-L22
    const multiNoNl = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift-ranges.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 5,
              target: "const blockA = 1;\nconst blockB = 2;\nconst blockC = 3;",
              replacement: "const blockA = 10;",
            },
          ],
        },
      ],
    });
    assert.equal(multiNoNl.isError, true);
    assert.match(multiNoNl.text, /Exact match found outside range at L10-L12, L20-L22 —/);

    // 2. Multi-line target WITH trailing newline -> still L10-L12 (NOT L10-L13)
    const multiWithNl = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift-ranges.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 5,
              target: "const blockA = 1;\nconst blockB = 2;\nconst blockC = 3;\n",
              replacement: "const blockA = 10;\n",
            },
          ],
        },
      ],
    });
    assert.equal(multiWithNl.isError, true);
    assert.match(multiWithNl.text, /Exact match found outside range at L10-L12, L20-L22 —/);
    assert.doesNotMatch(multiWithNl.text, /L10-L13/);

    // 3. Single-line target WITHOUT trailing newline -> L10 (NOT L10-L10)
    const singleNoNl = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift-ranges.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 5,
              target: "const mid_1 = 1;",
              replacement: "const mid_1 = 99;",
            },
          ],
        },
      ],
    });
    assert.equal(singleNoNl.isError, true);
    assert.match(singleNoNl.text, /Exact match found outside range at L13 —/);
    assert.doesNotMatch(singleNoNl.text, /L13-L13/);

    // 4. Single-line target WITH trailing newline -> L13 (NOT L13-L14)
    const singleWithNl = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift-ranges.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 5,
              target: "const mid_1 = 1;\n",
              replacement: "const mid_1 = 99;\n",
            },
          ],
        },
      ],
    });
    assert.equal(singleWithNl.isError, true);
    assert.match(singleWithNl.text, /Exact match found outside range at L13 —/);
    assert.doesNotMatch(singleWithNl.text, /L13-L14/);

    // 5. Ambiguous multi-line match without startLine/endLine reports full ranges
    const ambigMulti = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift-ranges.ts",
          hunks: [
            {
              target: "const blockA = 1;\nconst blockB = 2;\nconst blockC = 3;",
              replacement: "const blockA = 10;",
            },
          ],
        },
      ],
    });
    assert.equal(ambigMulti.isError, true);
    assert.match(ambigMulti.text, /matched 2 times \(lines: 10-12, 20-22\)/);
  });

  it("prioritizes Failed diagnostics before Applied in bestEffort partial apply and keeps output <= 8800 bytes", async () => {
    const batchDir = path.join(tmpDir, "best-effort-many");
    await fs.mkdir(batchDir, { recursive: true });

    const longSegment = "packages/very-long-workspace-module-name/src/components/deeply-nested-feature-directory/sub-module-layer";
    const okCount = 48;
    const edits: Array<{ path: string; hunks: Array<{ target: string; replacement: string; startLine?: number; endLine?: number }> }> = [];
    const okAbsPaths: string[] = [];

    for (let i = 1; i <= okCount; i++) {
      const rel = `${longSegment}/feature_component_module_number_${String(i).padStart(2, "0")}_implementation_details_handler.ts`;
      const abs = path.join(batchDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, `export const item_${i} = 1;\n`, "utf8");
      okAbsPaths.push(abs);
      edits.push({
        path: rel,
        hunks: [{ target: `item_${i} = 1;`, replacement: `item_${i} = 2;` }],
      });
    }

    const failRel = `${longSegment}/failing_target_component.ts`;
    const failAbs = path.join(batchDir, failRel);
    const failLines = [
      ...Array.from({ length: 30 }, (_, i) => `const header_${i + 1} = ${i + 1};`),
      "export function criticalWidget() {",
      "  const mode = 'production';",
      "  return mode;",
      "}",
    ];
    await fs.writeFile(failAbs, failLines.join("\n") + "\n", "utf8");
    edits.push({
      path: failRel,
      hunks: [
        {
          startLine: 1,
          endLine: 10,
          target: "export function criticalWidget() {\n  const mode = 'production';\n  return mode;\n}",
          replacement: "export function criticalWidget() {\n  return 'updated';\n}",
        },
      ],
    });

    const res = await runApplyEdits({
      cwd: batchDir,
      bestEffort: true,
      verify: `${JSON.stringify(process.execPath)} -e "console.log('SHOULD_NOT_RUN')"`,
      edits,
    });

    assert.equal(res.isError, true);
    assert.ok(
      Buffer.byteLength(res.text, "utf8") <= 8_800,
      `Expected <= 8800 bytes, got ${Buffer.byteLength(res.text, "utf8")}`,
    );
    assert.match(res.text, /Partial edit applied \(48\/49 file\(s\) written; 1 file\(s\) failed/);
    assert.match(res.text, /Failed \(retry ONLY these failed file\(s\); do NOT re-send applied files\):/);
    assert.match(res.text, /Exact match found outside range at L31-L34/);
    assert.match(res.text, /\.\.\. \(\+\d+ more applied file\(s\) omitted; total 48 written\)/);
    assert.match(res.text, /Verify skipped/);
    assert.doesNotMatch(res.text, /SHOULD_NOT_RUN/);

    const failedIdx = res.text.indexOf("Failed (retry ONLY these failed file(s)");
    const appliedIdx = res.text.indexOf("\nApplied:");
    assert.ok(failedIdx > 0, "Expected Failed section");
    assert.ok(appliedIdx > failedIdx, `Expected Failed (${failedIdx}) before Applied (${appliedIdx})`);

    // Spot-check disk state: valid files updated, failed file untouched
    assert.equal(await fs.readFile(okAbsPaths[0]!, "utf8"), "export const item_1 = 2;\n");
    assert.equal(await fs.readFile(okAbsPaths[okCount - 1]!, "utf8"), `export const item_${okCount} = 2;\n`);
    assert.match(await fs.readFile(failAbs, "utf8"), /const mode = 'production';/);
  });

  it("ranks high-entropy longest anchors above boilerplate headers, preserves Verify [FAIL] tails on large batches, water-fills multi-file errors, and validates verify.cwd pre-write", async () => {
    const subDir = path.join(tmpDir, "precision-and-verify");
    await fs.mkdir(subDir, { recursive: true });

    // 1. Closest-match prefers high-entropy longestAnchor over generic boilerplate `if (errors.length > 0) {`
    const anchorFile = path.join(subDir, "anchor.ts");
    const anchorLines = [
      ...Array.from({ length: 10 }, (_, i) => `const top_${i} = ${i};`),
      "if (errors.length > 0) {",
      "  return earlyExit();",
      "}",
      ...Array.from({ length: 40 }, (_, i) => `const mid_${i} = ${i};`),
      "if (validationProblems.length > 0) {",
      "  const formatted = renderStructuredDiagnosticReport(validationProblems, DEFAULT_MAX_REPORT_BYTES);",
      "  return { ok: false, report: formatted };",
      "}",
    ];
    await fs.writeFile(anchorFile, anchorLines.join("\n") + "\n", "utf8");

    const missRes = await runApplyEdits({
      cwd: subDir,
      dryRun: true,
      edits: [
        {
          path: "anchor.ts",
          hunks: [
            {
              target: [
                "if (errors.length > 0) {",
                "  const formatted = renderStructuredDiagnosticReport(validationProblems, DEFAULT_MAX_REPORT_BYTES);",
                "  return { ok: false, report: formatted };",
                "}",
              ].join("\n"),
              replacement: "// replaced",
            },
          ],
        },
      ],
    });
    assert.equal(missRes.isError, true);
    assert.match(missRes.text, /Closest match near line 54/);
    assert.match(missRes.text, /54: if \(validationProblems\.length > 0\) \{/);
    assert.match(missRes.text, /55:   const formatted = renderStructuredDiagnosticReport/);

    // 2. Non-existent verify.cwd fails BEFORE modifying any files on disk
    const safeFile = path.join(subDir, "safe.ts");
    await fs.writeFile(safeFile, "export const safe = 1;\n", "utf8");
    const badVerifyCwd = await runApplyEdits({
      cwd: subDir,
      verify: { command: "echo hi", cwd: "does-not-exist-subdir" },
      edits: [{ path: "safe.ts", hunks: [{ target: "safe = 1;", replacement: "safe = 2;" }] }],
    });
    assert.equal(badVerifyCwd.isError, true);
    assert.match(badVerifyCwd.text, /'verify\.cwd' directory not found/);
    assert.equal(await fs.readFile(safeFile, "utf8"), "export const safe = 1;\n");

    // 3. Multi-file atomic abort water-fills errors so later failing files are not starved off the bottom
    const multiFailEdits: FileEdit[] = [];
    for (let i = 1; i <= 6; i++) {
      const f = path.join(subDir, `fail_${i}.ts`);
      const body = Array.from({ length: 25 }, (_, k) => `export const uniqueSymbolFile${i}_Line${k} = "${"x".repeat(90)}";`).join("\n") + "\n";
      await fs.writeFile(f, body, "utf8");
      multiFailEdits.push({
        path: `fail_${i}.ts`,
        hunks: [{ target: `export const uniqueSymbolFile${i}_Line12 = "MISMATCH";`, replacement: "y" }],
      });
    }
    const multiAbort = await runApplyEdits({ cwd: subDir, edits: multiFailEdits });
    assert.equal(multiAbort.isError, true);
    assert.ok(Buffer.byteLength(multiAbort.text, "utf8") <= 8_800);
    for (let i = 1; i <= 6; i++) {
      assert.match(multiAbort.text, new RegExp(`- fail_${i}\\.ts hunk #1:`));
    }

    // 4. Large 40-file edit + failing CJK/Vitest verify compacts Applied list instead of slicing off Verify [FAIL] tail
    const manyDir = path.join(subDir, "packages/deeply-nested-workspace-package-name/src/modules");
    await fs.mkdir(manyDir, { recursive: true });
    const manyEdits: FileEdit[] = [];
    for (let i = 1; i <= 40; i++) {
      const rel = `packages/deeply-nested-workspace-package-name/src/modules/component_handler_service_item_${String(i).padStart(2, "0")}.ts`;
      await fs.writeFile(path.join(subDir, rel), `export const v_${i} = 1;\n`, "utf8");
      manyEdits.push({
        path: rel,
        hunks: [{ target: `v_${i} = 1;`, replacement: `v_${i} = 2;` }],
      });
    }
    const verifyScript = [
      "console.error('error TS2322: 首条核心类型错误根因诊断');",
      "for (let i = 0; i < 60; i++) console.error('  at middleFrame_' + i + ' (中文路径模块文件_' + i + '.ts:' + i + ':5)');",
      "console.error('FINAL_SUMMARY_TAIL_MARKER: Found 1 error in 1 file.');",
      "process.exitCode = 1;",
    ].join(" ");
    const verifyFailRes = await runApplyEdits({
      cwd: subDir,
      maxVerifyChars: 6500,
      verify: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(verifyScript)}`,
      edits: manyEdits,
    });
    assert.equal(verifyFailRes.isError, false);
    assert.ok(Buffer.byteLength(verifyFailRes.text, "utf8") <= 8_800);
    assert.match(verifyFailRes.text, /more applied file\(s\) omitted; total 40 written/);
    assert.match(verifyFailRes.text, /Verify \[FAIL/);
    assert.match(verifyFailRes.text, /error TS2322: 首条核心类型错误根因诊断/);
    assert.match(verifyFailRes.text, /FINAL_SUMMARY_TAIL_MARKER: Found 1 error in 1 file\./);

    // 5. >10-line hunk matched via a trailing high-entropy anchor (idx >= 10) still scores and locates cleanly
    const longHunkFile = path.join(subDir, "long-hunk.ts");
    const longFileLines = [
      ...Array.from({ length: 20 }, (_, i) => `const filler_${i} = ${i};`),
      ...Array.from({ length: 12 }, (_, i) => `const mutatedLine_${i} = ${i * 10};`),
      "const exactTrailingAnchor = computeDeterministicDigest(payloadBytes, SHA256_CONTEXT);",
      "return exactTrailingAnchor;",
    ];
    await fs.writeFile(longHunkFile, longFileLines.join("\n") + "\n", "utf8");
    const longMiss = await runApplyEdits({
      cwd: subDir,
      dryRun: true,
      edits: [
        {
          path: "long-hunk.ts",
          hunks: [
            {
              target: [
                ...Array.from({ length: 12 }, (_, i) => `const completelyDifferent_${i} = 'x';`),
                "const exactTrailingAnchor = computeDeterministicDigest(payloadBytes, SHA256_CONTEXT);",
                "return exactTrailingAnchor;",
              ].join("\n"),
              replacement: "// replaced",
            },
          ],
        },
      ],
    });
    assert.equal(longMiss.isError, true);
    assert.match(longMiss.text, /Closest match near line 21/);
  });

  it("blocks accidental writes inside .git metadata paths (including symlinks) while allowing .gitignore/.github/.gitattributes", async () => {
    // Platform-specific and cross-platform segment matching checks
    assert.equal(isGitInternalPath("/repo/.git/config", "linux"), true);
    assert.equal(isGitInternalPath("/repo/.git/hooks/pre-commit", "linux"), true);
    assert.equal(isGitInternalPath("/repo/.git", "linux"), true);
    assert.equal(isGitInternalPath("/repo/.GIT/config", "linux"), true);
    assert.equal(isGitInternalPath("/repo/.GIT/config", "darwin"), true);
    assert.equal(isGitInternalPath("C:\\repo\\.GIT\\config", "win32"), true);
    assert.equal(isGitInternalPath("C:\\repo\\.git.\\config", "win32"), true);
    assert.equal(isGitInternalPath("C:\\repo\\.git::$INDEX_ALLOCATION\\hooks\\pre-commit", "win32"), true);
    assert.equal(isGitInternalPath("C:\\repo\\.git .:$DATA", "win32"), true);
    assert.equal(isGitInternalPath("/repo/.gitignore", "linux"), false);
    assert.equal(isGitInternalPath("/repo/.github/workflows/ci.yml", "linux"), false);
    assert.equal(isGitInternalPath("/repo/.gitattributes", "win32"), false);
    assert.equal(isGitInternalPath("/repo/.gitmodules", "darwin"), false);
    assert.equal(isGitInternalPath("/repo/.gitkeep", "linux"), false);
    assert.equal(isGitInternalPath("/repos/project.git/README.md", "linux"), false);

    const subDir = path.join(tmpDir, "git-protect");
    await fs.mkdir(path.join(subDir, ".git", "hooks"), { recursive: true });
    const gitConfigPath = path.join(subDir, ".git", "config");
    const gitHeadPath = path.join(subDir, ".git", "HEAD");
    await fs.writeFile(gitConfigPath, "[core]\n\tbare = false\n", "utf8");
    await fs.writeFile(gitHeadPath, "ref: refs/heads/main\n", "utf8");

    // 1. Direct edits/creates targeting .git/* are rejected with 0 files modified
    const directRes = await runApplyEdits({
      cwd: subDir,
      edits: [
        { path: ".git/config", hunks: [{ target: "bare = false", replacement: "bare = true" }] },
        { path: ".git/HEAD", create: "ref: refs/heads/pwn\n", overwrite: true },
        { path: ".git/hooks/pre-commit", create: "#!/bin/sh\necho hi\n" },
      ],
    });
    assert.equal(directRes.isError, true);
    assert.match(directRes.text, /\.git\/config: refusing to modify Git internal metadata path/);
    assert.match(directRes.text, /\.git\/HEAD: refusing to modify Git internal metadata path/);
    assert.match(directRes.text, /\.git\/hooks\/pre-commit: refusing to modify Git internal metadata path/);
    assert.equal(await fs.readFile(gitConfigPath, "utf8"), "[core]\n\tbare = false\n");
    assert.equal(await fs.readFile(gitHeadPath, "utf8"), "ref: refs/heads/main\n");

    // 2. Symlinks pointing into .git/ (file symlink and dir symlink with nested new file) are also blocked
    let symlinksSupported = true;
    const symConfig = path.join(subDir, "innocent-link.txt");
    const symGitDir = path.join(subDir, "git-dir-link");
    try {
      await fs.symlink(gitConfigPath, symConfig);
      await fs.symlink(path.join(subDir, ".git"), symGitDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      symlinksSupported = false;
    }
    if (symlinksSupported) {
      const symRes = await runApplyEdits({
        cwd: subDir,
        edits: [
          { path: "innocent-link.txt", hunks: [{ target: "bare = false", replacement: "bare = true" }] },
          { path: "git-dir-link/new-sub/hook.sh", create: "#!/bin/sh\n" },
        ],
      });
      assert.equal(symRes.isError, true);
      assert.match(symRes.text, /innocent-link\.txt: refusing to modify Git internal metadata path/);
      assert.match(symRes.text, /git-dir-link\/new-sub\/hook\.sh: refusing to modify Git internal metadata path/);
      assert.equal(await fs.readFile(gitConfigPath, "utf8"), "[core]\n\tbare = false\n");
    }

    // 3. Legitimate dot-git* config files work normally
    const legitRes = await runApplyEdits({
      cwd: subDir,
      edits: [
        { path: ".gitignore", create: "node_modules/\n" },
        { path: ".github/workflows/ci.yml", create: "name: CI\n" },
        { path: ".gitattributes", create: "* text=auto\n" },
      ],
    });
    assert.equal(legitRes.isError, false);
    assert.equal(await fs.readFile(path.join(subDir, ".gitignore"), "utf8"), "node_modules/\n");
    assert.equal(await fs.readFile(path.join(subDir, ".github/workflows/ci.yml"), "utf8"), "name: CI\n");
    assert.equal(await fs.readFile(path.join(subDir, ".gitattributes"), "utf8"), "* text=auto\n");

    // 4. Worktree / submodule regular `.git` file is also protected end-to-end
    const wtDir = path.join(tmpDir, "git-worktree-protect");
    await fs.mkdir(wtDir, { recursive: true });
    const wtGitFile = path.join(wtDir, ".git");
    await fs.writeFile(wtGitFile, "gitdir: /main-repo/.git/worktrees/wt1\n", "utf8");
    const wtRes = await runApplyEdits({
      cwd: wtDir,
      edits: [
        { path: ".git", hunks: [{ target: "wt1", replacement: "pwn" }] },
      ],
    });
    assert.equal(wtRes.isError, true);
    assert.match(wtRes.text, /\.git: refusing to modify Git internal metadata path/);
    assert.equal(await fs.readFile(wtGitFile, "utf8"), "gitdir: /main-repo/.git/worktrees/wt1\n");
  });

  it("rejects overwriting existing binary files on create with overwrite: true (atomic and bestEffort)", async () => {
    const subDir = path.join(tmpDir, "binary-overwrite");
    await fs.mkdir(subDir, { recursive: true });

    // Minimal PNG header + IHDR bytes containing NUL bytes
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const pngPath = path.join(subDir, "logo.png");
    const txtPath = path.join(subDir, "notes.txt");
    await fs.writeFile(pngPath, pngBytes);
    await fs.writeFile(txtPath, "original\n", "utf8");

    // 1. Atomic mode: binary overwrite fails and rolls back / aborts all files
    const atomicRes = await runApplyEdits({
      cwd: subDir,
      edits: [
        { path: "notes.txt", hunks: [{ target: "original", replacement: "changed" }] },
        { path: "logo.png", create: "not a png\n", overwrite: true },
      ],
    });
    assert.equal(atomicRes.isError, true);
    assert.match(atomicRes.text, /logo\.png: Cannot overwrite binary file with text content/);
    assert.deepEqual(await fs.readFile(pngPath), pngBytes);
    assert.equal(await fs.readFile(txtPath, "utf8"), "original\n");

    // 2. bestEffort mode: isolates the binary overwrite failure while committing valid text edits
    const bestEffortRes = await runApplyEdits({
      cwd: subDir,
      bestEffort: true,
      edits: [
        { path: "notes.txt", hunks: [{ target: "original", replacement: "updated" }] },
        { path: "logo.png", create: "corrupted\n", overwrite: true },
      ],
    });
    assert.equal(bestEffortRes.isError, true);
    assert.match(bestEffortRes.text, /Partial edit applied \(1\/2 file\(s\) written/);
    assert.match(bestEffortRes.text, /logo\.png: Cannot overwrite binary file with text content/);
    assert.deepEqual(await fs.readFile(pngPath), pngBytes);
    assert.equal(await fs.readFile(txtPath, "utf8"), "updated\n");
  });

  it("preserves UTF-8 BOM across hunk edits and overwrite: true, and reports clear UTF-16 errors", async () => {
    const subDir = path.join(tmpDir, "bom-utf16-edits");
    await fs.mkdir(subDir, { recursive: true });

    const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const bomHunkPath = path.join(subDir, "bom-hunk.ts");
    const bomOverwritePath = path.join(subDir, "bom-overwrite.ts");
    const bomExplicitPath = path.join(subDir, "bom-explicit.ts");
    const plainPath = path.join(subDir, "plain.ts");

    await fs.writeFile(
      bomHunkPath,
      Buffer.concat([utf8Bom, Buffer.from("export const a = 1;\r\nexport const b = 2;\r\n", "utf8")]),
    );
    await fs.writeFile(
      bomOverwritePath,
      Buffer.concat([utf8Bom, Buffer.from("old line\n", "utf8")]),
    );
    await fs.writeFile(
      bomExplicitPath,
      Buffer.concat([utf8Bom, Buffer.from("old explicit\n", "utf8")]),
    );
    await fs.writeFile(plainPath, "export const plain = 1;\n", "utf8");

    const editRes = await runApplyEdits({
      cwd: subDir,
      edits: [
        {
          path: "bom-hunk.ts",
          hunks: [{ target: "export const a = 1;", replacement: "export const a = 10;" }],
        },
        {
          path: "bom-overwrite.ts",
          create: "new line 1\nnew line 2\n",
          overwrite: true,
        },
        {
          path: "bom-explicit.ts",
          create: "\uFEFFalready has bom\n",
          overwrite: true,
        },
        {
          path: "plain.ts",
          hunks: [{ target: "plain = 1;", replacement: "plain = 2;" }],
        },
      ],
    });
    assert.equal(editRes.isError, false);

    // 1. Hunk edit on line 1 matched without needing \uFEFF and preserved both BOM and CRLF
    const rawHunk = await fs.readFile(bomHunkPath);
    assert.deepEqual(rawHunk.subarray(0, 3), utf8Bom);
    assert.equal(rawHunk.subarray(3).toString("utf8"), "export const a = 10;\r\nexport const b = 2;\r\n");

    // 2. create + overwrite: true preserved UTF-8 BOM on disk
    const rawOverwrite = await fs.readFile(bomOverwritePath);
    assert.deepEqual(rawOverwrite.subarray(0, 3), utf8Bom);
    assert.equal(rawOverwrite.subarray(3).toString("utf8"), "new line 1\nnew line 2\n");

    // 3. create + overwrite: true with explicit \uFEFF does NOT double-prepend BOM
    const rawExplicit = await fs.readFile(bomExplicitPath);
    assert.deepEqual(rawExplicit.subarray(0, 3), utf8Bom);
    assert.equal(rawExplicit.subarray(3).toString("utf8"), "already has bom\n");

    // 4. Plain non-BOM file remains without BOM
    const rawPlain = await fs.readFile(plainPath);
    assert.notDeepEqual(rawPlain.subarray(0, 3), utf8Bom);
    assert.equal(rawPlain.toString("utf8"), "export const plain = 2;\n");

    // 5. UTF-16 LE file fails with clear UTF-16 diagnostic and remains untouched
    const utf16Path = path.join(subDir, "settings.reg");
    const utf16Bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Windows Registry Editor Version 5.00\r\n", "utf16le"),
    ]);
    await fs.writeFile(utf16Path, utf16Bytes);

    const utf16Res = await runApplyEdits({
      cwd: subDir,
      edits: [{ path: "settings.reg", hunks: [{ target: "5.00", replacement: "6.00" }] }],
    });
    assert.equal(utf16Res.isError, true);
    assert.match(utf16Res.text, /UTF-16 encoded file is not supported \(convert to UTF-8 first\): .*\[UTF-16 LE\]/);
    assert.deepEqual(await fs.readFile(utf16Path), utf16Bytes);

    // 6. create + overwrite: true also rejects UTF-16 LE/BE (including zero-NUL CJK UTF-16) and peeks >8KB binaries without full readFile
    const cjkUtf16Le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("中文配置测试", "utf16le"),
    ]);
    assert.equal(cjkUtf16Le.includes(0x00), false, "CJK UTF-16 LE fixture must contain zero NUL bytes");
    const cjkUtf16Path = path.join(subDir, "cjk-utf16le.txt");
    await fs.writeFile(cjkUtf16Path, cjkUtf16Le);

    const utf16BePayload = Buffer.from("中文配置", "utf16le");
    utf16BePayload.swap16();
    const cjkUtf16Be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BePayload]);
    assert.equal(cjkUtf16Be.includes(0x00), false, "CJK UTF-16 BE fixture must contain zero NUL bytes");
    const cjkUtf16BePath = path.join(subDir, "cjk-utf16be.txt");
    await fs.writeFile(cjkUtf16BePath, cjkUtf16Be);

    const overwriteUtf16Res = await runApplyEdits({
      cwd: subDir,
      bestEffort: true,
      edits: [
        { path: "settings.reg", create: "clobbered\n", overwrite: true },
        { path: "cjk-utf16le.txt", create: "clobbered\n", overwrite: true },
        { path: "cjk-utf16be.txt", create: "clobbered\n", overwrite: true },
        { path: "plain.ts", hunks: [{ target: "plain = 2;", replacement: "plain = 3;" }] },
      ],
    });
    assert.equal(overwriteUtf16Res.isError, true);
    assert.match(overwriteUtf16Res.text, /Partial edit applied \(1\/4 file\(s\) written/);
    assert.match(overwriteUtf16Res.text, /settings\.reg: UTF-16 encoded file is not supported \(convert to UTF-8 first\) \[UTF-16 LE\]/);
    assert.match(overwriteUtf16Res.text, /cjk-utf16le\.txt: UTF-16 encoded file is not supported \(convert to UTF-8 first\) \[UTF-16 LE\]/);
    assert.match(overwriteUtf16Res.text, /cjk-utf16be\.txt: UTF-16 encoded file is not supported \(convert to UTF-8 first\) \[UTF-16 BE\]/);
    assert.deepEqual(await fs.readFile(utf16Path), utf16Bytes);
    assert.deepEqual(await fs.readFile(cjkUtf16Path), cjkUtf16Le);
    assert.deepEqual(await fs.readFile(cjkUtf16BePath), cjkUtf16Be);
    assert.equal(await fs.readFile(plainPath, "utf8"), "export const plain = 3;\n");

    // >8KB binary file is rejected via header peek without invoking full fs.readFile on the target
    const largeBinPath = path.join(subDir, "large.bin");
    const largeBinBytes = Buffer.alloc(16 * 1024, 0x41);
    largeBinBytes[12] = 0x00;
    await fs.writeFile(largeBinPath, largeBinBytes);

    const origReadFile = fs.readFile;
    let fullReadAttempted = false;
    fs.readFile = (async (...args: Parameters<typeof origReadFile>) => {
      if (path.resolve(String(args[0])) === path.resolve(largeBinPath)) {
        fullReadAttempted = true;
      }
      return origReadFile(...args);
    }) as typeof fs.readFile;
    try {
      const largeBinRes = await runApplyEdits({
        cwd: subDir,
        edits: [{ path: "large.bin", create: "text\n", overwrite: true }],
      });
      assert.equal(largeBinRes.isError, true);
      assert.match(largeBinRes.text, /large\.bin: Cannot overwrite binary file with text content/);
      assert.equal(fullReadAttempted, false, "Expected >8KB binary overwrite rejection via header peek without full fs.readFile");
    } finally {
      fs.readFile = origReadFile;
    }
    assert.deepEqual(await fs.readFile(largeBinPath), largeBinBytes);
  });

  it("edits long 228-byte CJK filenames without ENAMETOOLONG and removes orphaned parent dirs on rollback", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "af-tmp-"));
    try {
      // 1. 75 CJK chars + ".ts" = 228 UTF-8 bytes (previously failed ENAMETOOLONG with target-prefixed temp name)
      const longCjkName = `${"测".repeat(75)}.ts`;
      const longCjkPath = path.join(workDir, longCjkName);
      await fs.writeFile(longCjkPath, "export const count = 1;\n", "utf8");

      const editRes = await runApplyEdits({
        cwd: workDir,
        edits: [
          {
            path: longCjkName,
            hunks: [{ target: "count = 1;", replacement: "count = 2;" }],
          },
        ],
      });
      assert.equal(editRes.isError, false, `Expected long CJK edit to succeed, got:\n${editRes.text}`);
      assert.equal(await fs.readFile(longCjkPath, "utf8"), "export const count = 2;\n");

      // 2. Atomic rollback cleans up newly created nested directories while preserving pre-existing ancestors
      const keepDir = path.join(workDir, "existing-root");
      await fs.mkdir(keepDir, { recursive: true });
      await fs.writeFile(path.join(keepDir, "keep.txt"), "stay\n", "utf8");

      const rollbackRes = await runApplyEdits({
        cwd: keepDir,
        edits: [
          { path: "nested/deep/dir/a.ts", create: "export const a = 1;\n" },
          // After plan #1 creates nested/deep/dir/, writing a regular file at that exact directory path fails in Phase 2
          { path: "nested/deep/dir", create: "should fail as EISDIR\n" },
        ],
      });
      assert.equal(rollbackRes.isError, true);
      assert.match(rollbackRes.text, /Write failed \(changes rolled back\)/);

      const nestedExists = await fs
        .lstat(path.join(keepDir, "nested"))
        .then(() => true, () => false);
      assert.equal(nestedExists, false, "Expected orphaned nested/deep/dir directories to be removed on rollback");
      assert.equal(await fs.readFile(path.join(keepDir, "keep.txt"), "utf8"), "stay\n");
      const remainingEntries = await fs.readdir(keepDir);
      assert.deepEqual(remainingEntries, ["keep.txt"]);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  it("preserves mixed CRLF/LF line endings on untouched lines and matches local span EOL", async () => {
    // 1. Editing a single LF line in a mixed CRLF+LF file preserves all untouched CRLF lines verbatim
    const mixedLfEdit = path.join(tmpDir, "mixed-lf-edit.txt");
    await fs.writeFile(
      mixedLfEdit,
      "win1\r\nwin2\r\nunix3\nwin4\r\n",
      "utf8",
    );
    const r1 = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "mixed-lf-edit.txt",
          hunks: [{ target: "unix3", replacement: "unix3a\nunix3b" }],
        },
      ],
    });
    assert.equal(r1.isError, false);
    assert.equal(
      await fs.readFile(mixedLfEdit, "utf8"),
      "win1\r\nwin2\r\nunix3a\nunix3b\nwin4\r\n",
    );

    // 2. Editing a single CRLF line in a mostly-LF file preserves untouched LF lines verbatim
    //    and uses CRLF for newly inserted lines inside that span
    const mixedCrlfEdit = path.join(tmpDir, "mixed-crlf-edit.txt");
    await fs.writeFile(
      mixedCrlfEdit,
      "unix1\nunix2\nwin3\r\nunix4\nunix5\n",
      "utf8",
    );
    const r2 = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "mixed-crlf-edit.txt",
          hunks: [{ target: "win3", replacement: "win3a\nwin3b" }],
        },
      ],
    });
    assert.equal(r2.isError, false);
    assert.equal(
      await fs.readFile(mixedCrlfEdit, "utf8"),
      "unix1\nunix2\nwin3a\r\nwin3b\r\nunix4\nunix5\n",
    );

    // 3. Multi-hunk edit on a mixed-EOL file keeps every untouched line byte-for-byte identical
    const mixedMulti = path.join(tmpDir, "mixed-multi.txt");
    await fs.writeFile(
      mixedMulti,
      "header\r\nkeep-lf-1\nedit-crlf\r\nkeep-crlf-2\r\nedit-lf\nkeep-crlf-3\r\nfooter-no-eol",
      "utf8",
    );
    const r3 = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "mixed-multi.txt",
          hunks: [
            { target: "edit-crlf", replacement: "EDITED-CRLF-1\nEDITED-CRLF-2" },
            { target: "edit-lf", replacement: "EDITED-LF-1\nEDITED-LF-2" },
            { target: "footer-no-eol", replacement: "FOOTER-1\nFOOTER-2" },
          ],
        },
      ],
    });
    assert.equal(r3.isError, false);
    assert.equal(
      await fs.readFile(mixedMulti, "utf8"),
      "header\r\nkeep-lf-1\nEDITED-CRLF-1\r\nEDITED-CRLF-2\r\nkeep-crlf-2\r\nEDITED-LF-1\nEDITED-LF-2\nkeep-crlf-3\r\nFOOTER-1\r\nFOOTER-2",
    );

    // 4. UTF-8 BOM + mixed CRLF/LF: BOM stays at index 0 before line 1 and mixed EOLs are preserved
    const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const bomMixed = path.join(tmpDir, "bom-mixed.txt");
    await fs.writeFile(
      bomMixed,
      Buffer.concat([utf8Bom, Buffer.from("line1-crlf\r\nline2-lf\nline3-crlf\r\n", "utf8")]),
    );
    const r4 = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "bom-mixed.txt",
          hunks: [
            { target: "line1-crlf", replacement: "line1a\nline1b" },
            { target: "line2-lf", replacement: "line2a\nline2b" },
          ],
        },
      ],
    });
    assert.equal(r4.isError, false);
    const bomMixedAfter = await fs.readFile(bomMixed);
    assert.deepEqual(bomMixedAfter.subarray(0, 3), utf8Bom);
    assert.equal(
      bomMixedAfter.subarray(3).toString("utf8"),
      "line1a\r\nline1b\r\nline2a\nline2b\nline3-crlf\r\n",
    );

    // 5. create(overwrite: true) on a UTF-8 BOM mixed-EOL file keeps BOM at byte 0 without duplicating it
    const r5 = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "bom-mixed.txt",
          create: "over1\r\nover2\n",
          overwrite: true,
        },
      ],
    });
    assert.equal(r5.isError, false);
    const bomOverwriteAfter = await fs.readFile(bomMixed);
    assert.deepEqual(bomOverwriteAfter.subarray(0, 3), utf8Bom);
    assert.equal(bomOverwriteAfter.subarray(3).toString("utf8"), "over1\r\nover2\n");
  });

  it("skips disk writes for no-op hunks, preserves mtime/inode, and reports unchanged status", async () => {
    const noopFile = path.join(tmpDir, "noop-only.ts");
    const realFile = path.join(tmpDir, "real-edit.ts");
    await fs.writeFile(noopFile, "export const value = 1;\n", "utf8");
    await fs.writeFile(realFile, "export const count = 1;\n", "utf8");

    const past = new Date(Date.now() - 60_000);
    await fs.utimes(noopFile, past, past);
    await fs.utimes(realFile, past, past);
    const noopBefore = await fs.stat(noopFile);
    const realBefore = await fs.stat(realFile);

    // 1. Single no-op hunk in dryRun and real mode -> reports unchanged and skips disk write
    const dryRes = await runApplyEdits({
      cwd: tmpDir,
      dryRun: true,
      edits: [
        {
          path: "noop-only.ts",
          hunks: [{ target: "value = 1", replacement: "value = 1" }],
        },
      ],
    });
    assert.equal(dryRes.isError, false);
    assert.match(
      dryRes.text,
      /- noop-only\.ts: unchanged \(no-op: replacement identical to target\)/,
    );

    const singleRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "noop-only.ts",
          hunks: [{ target: "value = 1", replacement: "value = 1" }],
        },
      ],
    });
    assert.equal(singleRes.isError, false);
    assert.match(singleRes.text, /Applied edits to 0 file\(s\) \(1 unchanged\):/);
    assert.match(
      singleRes.text,
      /- noop-only\.ts: unchanged \(no-op: replacement identical to target\)/,
    );
    const noopAfterSingle = await fs.stat(noopFile);
    assert.equal(noopAfterSingle.mtimeMs, noopBefore.mtimeMs);
    if (process.platform !== "win32") {
      assert.equal(noopAfterSingle.ino, noopBefore.ino);
    }

    // 2. Mixed multi-file batch (1 real edit + 1 no-op hunk) writes only the real edit
    const mixedRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "real-edit.ts",
          hunks: [{ target: "count = 1", replacement: "count = 2" }],
        },
        {
          path: "noop-only.ts",
          hunks: [{ target: "value = 1", replacement: "value = 1" }],
        },
      ],
    });
    assert.equal(mixedRes.isError, false);
    assert.match(mixedRes.text, /Applied edits to 1 file\(s\) \(1 unchanged\):/);
    assert.match(mixedRes.text, /- real-edit\.ts: updated \(1 match\), lines \+0/);
    assert.match(
      mixedRes.text,
      /- noop-only\.ts: unchanged \(no-op: replacement identical to target\)/,
    );
    assert.equal(await fs.readFile(realFile, "utf8"), "export const count = 2;\n");

    const noopAfterMixed = await fs.stat(noopFile);
    const realAfterMixed = await fs.stat(realFile);
    assert.equal(noopAfterMixed.mtimeMs, noopBefore.mtimeMs);
    assert.ok(
      realAfterMixed.mtimeMs > realBefore.mtimeMs,
      `expected realFile mtime to advance (${realAfterMixed.mtimeMs} <= ${realBefore.mtimeMs})`,
    );
    if (process.platform !== "win32") {
      assert.equal(noopAfterMixed.ino, noopBefore.ino);
    }

    // 3. UTF-8 BOM file: no-op hunk skips write (preserving BOM + mtime/inode), real edit writes with BOM intact
    const bomNoopFile = path.join(tmpDir, "bom-noop.ts");
    const bomInitial = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("export const bomVal = 1;\n", "utf8"),
    ]);
    await fs.writeFile(bomNoopFile, bomInitial);
    await fs.utimes(bomNoopFile, past, past);
    const bomBefore = await fs.stat(bomNoopFile);

    const bomNoopRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "bom-noop.ts",
          hunks: [{ target: "bomVal = 1", replacement: "bomVal = 1" }],
        },
      ],
    });
    assert.equal(bomNoopRes.isError, false);
    assert.match(bomNoopRes.text, /Applied edits to 0 file\(s\) \(1 unchanged\):/);
    const bomAfterNoop = await fs.stat(bomNoopFile);
    assert.equal(bomAfterNoop.mtimeMs, bomBefore.mtimeMs);
    if (process.platform !== "win32") {
      assert.equal(bomAfterNoop.ino, bomBefore.ino);
    }
    assert.deepEqual(await fs.readFile(bomNoopFile), bomInitial);

    const bomEditRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "bom-noop.ts",
          hunks: [{ target: "bomVal = 1", replacement: "bomVal = 2" }],
        },
      ],
    });
    assert.equal(bomEditRes.isError, false);
    assert.match(bomEditRes.text, /Applied edits to 1 file\(s\):/);
    assert.deepEqual(
      await fs.readFile(bomNoopFile),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("export const bomVal = 2;\n", "utf8"),
      ]),
    );

    // 4. Mixed CRLF/LF spanning no-op preserves raw bytes & mtime and still runs verify (including OOM exit-137 diagnostics)
    const mixedNoop = path.join(tmpDir, "mixed-noop.txt");
    const mixedInitial = "line1\r\nline2\nline3\r\n";
    await fs.writeFile(mixedNoop, mixedInitial, "utf8");
    await fs.utimes(mixedNoop, past, past);
    const mixedBefore = await fs.stat(mixedNoop);
    const verifyOomRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "mixed-noop.txt",
          hunks: [{ target: "line1\nline2\nline3", replacement: "line1\nline2\nline3" }],
        },
      ],
      verify: `"${process.execPath}" -e "process.exit(137)"`,
    });
    assert.equal(verifyOomRes.isError, false);
    assert.match(verifyOomRes.text, /Applied edits to 0 file\(s\) \(1 unchanged\):/);
    assert.match(verifyOomRes.text, /Verify \[FAIL \(exit 137 \/ SIGKILL - possible OOM\) in \d+ms\]/);
    assert.match(verifyOomRes.text, /Terminated \(exit 137 \/ SIGKILL - possible OOM\)/);
    assert.equal(await fs.readFile(mixedNoop, "utf8"), mixedInitial);
    assert.equal((await fs.stat(mixedNoop)).mtimeMs, mixedBefore.mtimeMs);

    // 5. bestEffort byte-budget truncation footer accurately reports written vs unchanged counts
    const bulkDir = path.join(tmpDir, "noop-bulk-trunc");
    await fs.mkdir(bulkDir, { recursive: true });
    const bulkEdits: FileEdit[] = [];
    for (let i = 0; i < 48; i++) {
      const name = `unchanged-very-long-module-filename-segment-${String(i).padStart(2, "0")}-${"x".repeat(100)}.ts`;
      await fs.writeFile(path.join(bulkDir, name), "export const same = 1;\n", "utf8");
      bulkEdits.push({
        path: name,
        hunks: [{ target: "same = 1", replacement: "same = 1" }],
      });
    }
    await fs.writeFile(path.join(bulkDir, "fail-target.ts"), "export const other = 1;\n", "utf8");
    bulkEdits.push({
      path: "fail-target.ts",
      hunks: [{ target: "missing_symbol_xyz", replacement: "found" }],
    });
    const bulkRes = await runApplyEdits({
      cwd: bulkDir,
      bestEffort: true,
      edits: bulkEdits,
    });
    assert.equal(bulkRes.isError, true);
    assert.match(bulkRes.text, /Partial edit applied \(0\/49 file\(s\) written, 48 unchanged; 1 file\(s\) failed/);
    assert.match(bulkRes.text, /total 0 written, 48 unchanged\)/);
  });
});
