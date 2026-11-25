import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runAgyFastCli, shouldCliExitNonZero } from "../src/cli-runner.js";

const MCP_SERVER_SCRIPT = path.resolve(process.cwd(), "dist", "mcp-server.mjs");

function runCliSubprocess(
  args: string[],
  options: { cwd: string; stdin?: string; closeStdin?: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER_SCRIPT, "--cli", ...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    if (options.closeStdin !== false) {
      child.stdin.end();
    }
  });
}

describe("agy-fast --cli direct runner", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-cli-test-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "math.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function multiply(a: number, b: number): number {",
        "  return a * b;",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "greet.ts"),
      [
        "export function greet(name: string): string {",
        "  return `hello ${name}`;",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("supports outline, slice, search, check, and edit via built dist/mcp-server.mjs --cli", async () => {
    // 1. Help
    const helpRes = await runCliSubprocess(["--help"], { cwd: tmpDir });
    assert.equal(helpRes.code, 0);
    assert.match(helpRes.stdout, /agy-fast direct CLI mode/);

    // 2. Positional outline (even when stdin is left open, must NOT hang!)
    const outlineRes = await runCliSubprocess(["outline", "src/math.ts", "src/greet.ts"], {
      cwd: tmpDir,
      closeStdin: false,
    });
    assert.equal(outlineRes.code, 0, outlineRes.stderr);
    assert.match(outlineRes.stdout, /\[function\] add/);
    assert.match(outlineRes.stdout, /\[function\] multiply/);
    assert.match(outlineRes.stdout, /\[function\] greet/);
    assert.ok(Buffer.byteLength(outlineRes.stdout, "utf8") <= 8800);

    // 3. Slice with positional lineRanges + --outline
    const sliceRes = await runCliSubprocess(
      ["slice", "src/math.ts:1-3", "--outline", "src/greet.ts"],
      { cwd: tmpDir },
    );
    assert.equal(sliceRes.code, 0, sliceRes.stderr);
    assert.match(sliceRes.stdout, /return a \+ b/);
    assert.match(sliceRes.stdout, /\[function\] greet/);

    // 4. Search via shorthand flags (multiple queries in one call)
    const searchFlagsRes = await runCliSubprocess(
      ["search", "--text", "multiply", "--glob", "src/*.ts"],
      { cwd: tmpDir },
    );
    assert.equal(searchFlagsRes.code, 0, searchFlagsRes.stderr);
    assert.match(searchFlagsRes.stdout, /Query 1 \[text\] multiply/);
    assert.match(searchFlagsRes.stdout, /Query 2 \[glob\] src\/\*\.ts/);
    assert.match(searchFlagsRes.stdout, /src\/greet\.ts/);

    // 5. Search via piped JSON shorthand array
    const searchPipeRes = await runCliSubprocess(["search"], {
      cwd: tmpDir,
      stdin: JSON.stringify([{ type: "text", pattern: "hello", path: "src" }]),
    });
    assert.equal(searchPipeRes.code, 0, searchPipeRes.stderr);
    assert.match(searchPipeRes.stdout, /src\/greet\.ts/);

    // 6. Check concurrent commands in compact & full modes
    const checkRes = await runCliSubprocess(
      ["check", "--full", "node -e \"console.log('ALPHA_OK')\"", "node -e \"console.log('BETA_OK')\""],
      { cwd: tmpDir },
    );
    assert.equal(checkRes.code, 0, checkRes.stderr);
    assert.match(checkRes.stdout, /Checks: 2\/2 passed/);
    assert.match(checkRes.stdout, /ALPHA_OK/);
    assert.match(checkRes.stdout, /BETA_OK/);

    // 7. Edit via piped stdin JSON + --verify override
    const editPayload = JSON.stringify({
      edits: [
        {
          path: "src/greet.ts",
          hunks: [{ target: "hello ${name}", replacement: "hi ${name}" }],
        },
      ],
    });
    const editRes = await runCliSubprocess(
      ["edit", "--verify", "node -e \"console.log('VERIFIED')\""],
      { cwd: tmpDir, stdin: editPayload },
    );
    assert.equal(editRes.code, 0, editRes.stderr);
    assert.match(editRes.stdout, /Applied edits to 1 file/);
    assert.match(editRes.stdout, /Verify \[PASS/);
    const updated = await fs.readFile(path.join(tmpDir, "src", "greet.ts"), "utf8");
    assert.match(updated, /hi \$\{name\}/);
  });

  it("handles errors cleanly and never hangs on open empty stdin", async () => {
    const unknownRes = await runCliSubprocess(["bogus"], { cwd: tmpDir });
    assert.equal(unknownRes.code, 1);
    assert.match(unknownRes.stderr, /unknown --cli command/);

    const badJsonRes = await runCliSubprocess(["edit", "--json", "{bad"], { cwd: tmpDir });
    assert.equal(badJsonRes.code, 1);
    assert.match(badJsonRes.stderr, /Invalid JSON input/);

    // Simulate non-TTY open pipe with no bytes sent and no positional args
    const openStdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    openStdin.isTTY = false;
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const out = new PassThrough();
    const err = new PassThrough();
    out.on("data", (d) => stdoutBuf.push(d.toString("utf8")));
    err.on("data", (d) => stderrBuf.push(d.toString("utf8")));

    const startedAt = Date.now();
    const code = await runAgyFastCli(["search"], {
      stdin: openStdin,
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(code, 1);
    assert.match(stderrBuf.join(""), /requires at least one query/);
    assert.ok(elapsed < 2000, `Expected non-hanging open stdin guard, took ${elapsed}ms`);

    // Failed edit returns exit code 1 with diagnostic text on stdout
    const failEdit = await runCliSubprocess(
      [
        "edit",
        "--json",
        JSON.stringify({
          edits: [{ path: "src/math.ts", hunks: [{ target: "DOES_NOT_EXIST", replacement: "x" }] }],
        }),
      ],
      { cwd: tmpDir },
    );
    assert.equal(failEdit.code, 1);
    assert.match(failEdit.stdout, /target text not found/);
  });

  it("exits non-zero on failed checks or verify, scopes per-query --path, and searches literal --help/-h", async () => {
    const subA = path.join(tmpDir, "pkg-a");
    const subB = path.join(tmpDir, "pkg-b");
    await fs.mkdir(subA, { recursive: true });
    await fs.mkdir(subB, { recursive: true });
    await fs.writeFile(path.join(subA, "cli.ts"), "export const flag = '--help';\nexport const tokenA = 'ONLY_IN_A';\n", "utf8");
    await fs.writeFile(path.join(subB, "cli.ts"), "export const tokenB = 'ONLY_IN_B';\n", "utf8");

    // 1. Literal --help / -h after --text or -- must search, NOT print CLI usage
    const literalHelp = await runCliSubprocess(
      ["search", "--path=pkg-a", "--text", "--help"],
      { cwd: tmpDir },
    );
    assert.equal(literalHelp.code, 0, literalHelp.stderr);
    assert.doesNotMatch(literalHelp.stdout, /agy-fast direct CLI mode/);
    assert.match(literalHelp.stdout, /flag = '--help'/);

    const dashDashHelp = await runCliSubprocess(
      ["search", "--path", "pkg-a", "--", "--help"],
      { cwd: tmpDir },
    );
    assert.equal(dashDashHelp.code, 0, dashDashHelp.stderr);
    assert.match(dashDashHelp.stdout, /flag = '--help'/);

    // Subcommand --help (not consumed by a value flag) still shows usage and exits 0
    const subHelp = await runCliSubprocess(["search", "--help"], { cwd: tmpDir });
    assert.equal(subHelp.code, 0);
    assert.match(subHelp.stdout, /agy-fast direct CLI mode/);

    // 2. Per-query --path scoping must not overwrite earlier queries
    const multiScoped = await runCliSubprocess(
      ["search", "--path", "pkg-a", "--text", "ONLY_IN_A", "--path", "pkg-b", "--text", "ONLY_IN_B"],
      { cwd: tmpDir },
    );
    assert.equal(multiScoped.code, 0, multiScoped.stderr);
    assert.match(multiScoped.stdout, /Query 1 \[text\] ONLY_IN_A \(in pkg-a\)/);
    assert.match(multiScoped.stdout, /pkg-a\/cli\.ts/);
    assert.match(multiScoped.stdout, /Query 2 \[text\] ONLY_IN_B \(in pkg-b\)/);
    assert.match(multiScoped.stdout, /pkg-b\/cli\.ts/);

    // 3. --cli check MUST return exit code 1 when any command fails
    const failedCheck = await runCliSubprocess(
      ["check", 'node -e "process.exit(0)"', 'node -e "console.error(\'BOOM\'); process.exit(2)"'],
      { cwd: tmpDir },
    );
    assert.equal(failedCheck.code, 1);
    assert.match(failedCheck.stdout, /Checks: 1\/2 passed, 1 failed/);
    assert.match(failedCheck.stdout, /BOOM/);

    // 4. --cli edit --verify MUST return exit code 1 when edits succeed but verify fails
    const failedVerifyEdit = await runCliSubprocess(
      ["edit", "--verify=node -e \"console.error('TYPE_ERR'); process.exit(1)\""],
      {
        cwd: tmpDir,
        stdin: JSON.stringify({
          edits: [{ path: "pkg-b/cli.ts", hunks: [{ target: "ONLY_IN_B", replacement: "ONLY_IN_B_V2" }] }],
        }),
      },
    );
    assert.equal(failedVerifyEdit.code, 1);
    assert.match(failedVerifyEdit.stdout, /Verify \[FAIL/);
    assert.match(failedVerifyEdit.stdout, /TYPE_ERR/);

    // 5. shouldCliExitNonZero must flag `not run` even when failedCount === 0 (no "0 failed," segment)
    assert.equal(
      shouldCliExitNonZero("run_checks", {
        text: "Checks: 1/2 passed, 1 not run (call time budget of 170s used up) (wall: 170000ms)",
        isError: false,
      }),
      true,
    );
    assert.equal(
      shouldCliExitNonZero("run_checks", {
        text: "Checks: 1/2 passed, 1 failed (wall: 50ms)",
        isError: false,
      }),
      true,
    );
    assert.equal(
      shouldCliExitNonZero("run_checks", {
        text: "Checks: 2/2 passed (wall: 50ms)",
        isError: false,
      }),
      false,
    );
    assert.equal(
      shouldCliExitNonZero("apply_edits", {
        text: "Applied edits to 1 file(s):\n- a.ts\n\nVerify [PASS in 10ms] `npm test`:\nOK",
        isError: false,
      }),
      false,
    );
  });

  it("preserves option values matching --flag=val or '--' and scopes modifiers for positional search queries", async () => {
    const scopeA = path.join(tmpDir, "scope-a");
    const scopeB = path.join(tmpDir, "scope-b");
    await fs.mkdir(scopeA, { recursive: true });
    await fs.mkdir(scopeB, { recursive: true });
    await fs.writeFile(
      path.join(scopeA, "flags.ts"),
      "export const cliSample = '--max-chars=100';\nexport const sep = '--';\nexport const alpha = 'SCOPE_A_ONLY';\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(scopeB, "flags.ts"),
      "export const beta = 'SCOPE_B_ONLY';\n",
      "utf8",
    );

    // 1. Value matching --<known-flag>=val after --text must NOT be split into extra queries
    const flagValRes = await runCliSubprocess(
      ["search", "--path=scope-a", "--text", "--max-chars=100"],
      { cwd: tmpDir },
    );
    assert.equal(flagValRes.code, 0, flagValRes.stderr);
    assert.match(flagValRes.stdout, /Query 1 \[text\] --max-chars=100 \(in scope-a\)/);
    assert.doesNotMatch(flagValRes.stdout, /Query 2/);
    assert.match(flagValRes.stdout, /cliSample = '--max-chars=100'/);

    // 2. Value '--' after --text must NOT disable --flag=val parsing for subsequent options
    const dashValRes = await runCliSubprocess(
      ["search", "--text", "--", "--path=scope-a"],
      { cwd: tmpDir },
    );
    assert.equal(dashValRes.code, 0, dashValRes.stderr);
    assert.match(dashValRes.stdout, /Query 1 \[text\] -- \(in scope-a\)/);
    assert.match(dashValRes.stdout, /sep = '--'/);

    // 3. Positional search queries consume preceding modifiers and inherit trailing modifiers
    const posScopedRes = await runCliSubprocess(
      ["search", "--path", "scope-a", "scope_a_only", "--path", "scope-b", "scope_b_only", "--ignore-case"],
      { cwd: tmpDir },
    );
    assert.equal(posScopedRes.code, 0, posScopedRes.stderr);
    assert.match(posScopedRes.stdout, /Query 1 \[text\] scope_a_only \(in scope-a\)/);
    assert.match(posScopedRes.stdout, /SCOPE_A_ONLY/);
    assert.match(posScopedRes.stdout, /Query 2 \[text\] scope_b_only \(in scope-b\)/);
    assert.match(posScopedRes.stdout, /SCOPE_B_ONLY/);

    // 4. Unknown long flag with '=val' for another tool reports the full unknown option cleanly
    const badFlagRes = await runCliSubprocess(["outline", "--text=foo"], { cwd: tmpDir });
    assert.equal(badFlagRes.code, 1);
    assert.match(badFlagRes.stderr, /Unknown option '--text=foo' for 'quick_outline'/);
  });

  it("supports --pattern and --type (preceding, trailing, and inline) for --cli search", async () => {
    // 1. --pattern defaults to text search and inherits trailing modifiers
    const defaultPat = await runCliSubprocess(
      ["search", "--pattern", "multiply", "--path", "src"],
      { cwd: tmpDir },
    );
    assert.equal(defaultPat.code, 0, defaultPat.stderr);
    assert.match(defaultPat.stdout, /Query 1 \[text\] multiply \(in src\)/);
    assert.match(defaultPat.stdout, /src\/math\.ts/);

    // 2. Preceding --type scopes only to the next --pattern; subsequent --pattern defaults to text
    const preTyped = await runCliSubprocess(
      ["search", "--type", "regex", "--pattern", "add|multiply", "--pattern=greet", "--path=src"],
      { cwd: tmpDir },
    );
    assert.equal(preTyped.code, 0, preTyped.stderr);
    assert.match(preTyped.stdout, /Query 1 \[regex\] add\|multiply \(in src\)/);
    assert.match(preTyped.stdout, /Query 2 \[text\] greet \(in src\)/);
    assert.match(preTyped.stdout, /src\/greet\.ts/);

    // 3. Trailing --type applies to implicit --pattern queries without overwriting explicit --glob
    const trailTyped = await runCliSubprocess(
      ["search", "--pattern=add|multiply", "--glob", "src/*.ts", "--type=regex"],
      { cwd: tmpDir },
    );
    assert.equal(trailTyped.code, 0, trailTyped.stderr);
    assert.match(trailTyped.stdout, /Query 1 \[regex\] add\|multiply/);
    assert.match(trailTyped.stdout, /Query 2 \[glob\] src\/\*\.ts/);

    // 4. Literal --help value after --pattern must search, NOT print usage
    const litHelpPat = await runCliSubprocess(
      ["search", "--pattern", "--help", "--path", "pkg-a"],
      { cwd: tmpDir },
    );
    assert.equal(litHelpPat.code, 0, litHelpPat.stderr);
    assert.doesNotMatch(litHelpPat.stdout, /agy-fast direct CLI mode/);
    assert.match(litHelpPat.stdout, /flag = '--help'/);

    // 5. '--type' before '--' scopes only to the post-'--' query without retroactively retyping earlier '--pattern' queries
    const dashDashTyped = await runCliSubprocess(
      ["search", "--path=src", "--pattern", "add", "--path=pkg-a", "--type", "regex", "--", "--help|ONLY_IN_A"],
      { cwd: tmpDir },
    );
    assert.equal(dashDashTyped.code, 0, dashDashTyped.stderr);
    assert.match(dashDashTyped.stdout, /Query 1 \[text\] add \(in src\)/);
    assert.match(dashDashTyped.stdout, /Query 2 \[regex\] --help\|ONLY_IN_A \(in pkg-a\)/);
    assert.match(dashDashTyped.stdout, /flag = '--help'/);

    // 6. Invalid --type and --pattern on non-search subcommand fail cleanly
    const badType = await runCliSubprocess(
      ["search", "--type", "bogus", "--pattern", "add"],
      { cwd: tmpDir },
    );
    assert.equal(badType.code, 1);
    assert.match(badType.stderr, /Invalid --type: bogus/);

    const badOutlineFlag = await runCliSubprocess(["outline", "--pattern=foo"], { cwd: tmpDir });
    assert.equal(badOutlineFlag.code, 1);
    assert.match(badOutlineFlag.stderr, /Unknown option '--pattern=foo' for 'quick_outline'/);
  });
});
