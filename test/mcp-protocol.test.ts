import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { MAX_FRAME_BYTES, McpStdioServer } from "../src/protocol/mcp.js";

const MCP_SERVER_SCRIPT = path.resolve(process.cwd(), "dist", "mcp-server.mjs");

function buildCleanServerEnv(
  extraEnv: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTIGRAVITY_LS_VERSION;
  delete env.ANTIGRAVITY_APP_DATA_DIR;
  delete env.AGY_FAST_HOST;
  delete env.AGY_FAST_EDITS_FORMAT;
  delete env.AGY_FAST_CACHE_DIR;
  delete env.PLUGIN_ROOT;
  delete env.AGY_PLUGIN_ROOT;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function sendMessagesToServer(
  rawChunks: Array<string | Buffer>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildCleanServerEnv(extraEnv),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MCP server test timed out"));
    }, 10_000);
    timer.unref();

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    (async () => {
      for (const chunk of rawChunks) {
        child.stdin.write(chunk);
        await new Promise((r) => setTimeout(r, 10));
      }
      child.stdin.end();
    })();
  });
}

function hasDisallowedSchemaKeyword(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return obj.some(hasDisallowedSchemaKeyword);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "oneOf" || k === "anyOf" || k === "allOf") return true;
    if (hasDisallowedSchemaKeyword(v)) return true;
  }
  return false;
}

describe("MCP Stdio Server end-to-end", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-mcp-"));
    await fs.writeFile(
      path.join(tmpDir, "demo.ts"),
      "export function greet(name: string) {\n  return `hi ${name}`;\n}\n",
      "utf8",
    );
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handles initialize, notifications, ping, tools/list, and all 5 tools over stdio", async () => {
    const msgs = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "batch_search",
          arguments: {
            cwd: tmpDir,
            queries: [{ type: "text", pattern: "greet" }],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: tmpDir,
            outlines: ["demo.ts"],
            slices: [{ path: "demo.ts", ranges: [[1, 3]] }],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "apply_edits",
          arguments: {
            cwd: tmpDir,
            edits: [
              {
                path: "demo.ts",
                hunks: [{ target: "hi ${name}", replacement: "hello ${name}" }],
              },
            ],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "run_checks",
          arguments: {
            cwd: tmpDir,
            commands: [
              {
                name: "ok",
                command: `${JSON.stringify(process.execPath)} -e "console.log('ok')"`,
              },
            ],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "quick_outline",
          arguments: {
            cwd: tmpDir,
            paths: ["demo.ts"],
          },
        },
      },
    ];

    const res = await sendMessagesToServer(
      msgs.map((m) => `${JSON.stringify(m)}\n`),
    );

    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");

    const responses = res.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Notification must not emit a response -> 8 responses for ids 1..8
    assert.equal(responses.length, 8);

    const byId = new Map<number, Record<string, unknown>>(
      responses.map((r) => [r.id as number, r]),
    );

    const init = byId.get(1)?.result as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    assert.equal(init.protocolVersion, "2025-03-26");
    assert.equal(init.serverInfo.name, "agy-fast");

    assert.deepEqual(byId.get(2)?.result, {});

    const toolList = (
      byId.get(3)?.result as {
        tools: Array<{ name: string; description: string; inputSchema: unknown }>;
      }
    ).tools;
    assert.deepEqual(
      toolList.map((t) => t.name),
      ["batch_search", "apply_edits", "read_slices", "quick_outline", "run_checks"],
    );
    // Default (unknown/third-party host) uses token-saving native array schema
    const applySchema = toolList.find((t) => t.name === "apply_edits")?.inputSchema as {
      properties: { edits: { type: string } };
    };
    assert.equal(applySchema.properties.edits.type, "array");
    // Ensure schemas avoid oneOf/anyOf/allOf and stay well under Antigravity ACP's
    // ~2000-2048B eager tool declaration cutoff (which silently drops >2KB tool schemas).
    for (const tool of toolList) {
      assert.equal(
        hasDisallowedSchemaKeyword(tool.inputSchema),
        false,
        `Tool ${tool.name} schema should not contain oneOf/anyOf/allOf`,
      );
      const declBytes = Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        }),
        "utf8",
      );
      assert.ok(
        declBytes <= 1800,
        `Tool ${tool.name} declaration JSON is ${declBytes} bytes (>1800B limit for Antigravity ACP eager loading)`,
      );
    }

    const searchText = (
      byId.get(4)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(searchText ?? "", /demo\.ts/);

    const sliceText = (
      byId.get(5)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(sliceText ?? "", /\[function\] greet/);

    const editText = (
      byId.get(6)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(editText ?? "", /Applied edits to 1 file/);
    assert.match(await fs.readFile(path.join(tmpDir, "demo.ts"), "utf8"), /hello \$\{name\}/);

    const checkText = (
      byId.get(7)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(checkText ?? "", /Checks: 1\/1 passed/);

    const outlineText = (
      byId.get(8)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(outlineText ?? "", /## Outline: demo\.ts/);
    assert.match(outlineText ?? "", /\[function\] greet/);
  });

  it("adapts apply_edits inputSchema dynamically by Antigravity surface/version and honors overrides", async () => {
    const probeSchema = async (
      clientInfo: { name: string; version: string },
      extraEnv: Record<string, string | undefined> = {},
    ) => {
      const res = await sendMessagesToServer(
        [
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo },
          }) + "\n",
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
        ],
        extraEnv,
      );
      assert.equal(res.code, 0);
      assert.equal(res.stderr, "");
      const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
      const tools = lines.find((l) => l.id === 2)?.result?.tools as Array<{
        name: string;
        inputSchema: { properties: { edits: { type: string } } };
      }>;
      for (const tool of tools) {
        assert.equal(hasDisallowedSchemaKeyword(tool.inputSchema), false);
      }
      return tools.find((t) => t.name === "apply_edits")!.inputSchema.properties.edits.type;
    };

    // Pre-eager Antigravity CLI 1.5.0-1.5.7 switches edits schema to "string" (via clientInfo or LS env)
    assert.equal(await probeSchema({ name: "antigravity-cli", version: "1.5.7" }), "string");
    assert.equal(
      await probeSchema({ name: "mcp-client", version: "1.0.0" }, { ANTIGRAVITY_LS_VERSION: "cli-1.5.6" }),
      "string",
    );
    assert.equal(
      await probeSchema({ name: "antigravity-cli", version: "1.5.7.4" }),
      "string",
    );

    // Eager-capable CLI >=1.5.8, Desktop 2.0, IDE, older CLI <1.5.0, and third-party clients keep token-saving "array" schema
    assert.equal(await probeSchema({ name: "antigravity-cli", version: "1.5.8" }), "array");
    assert.equal(await probeSchema({ name: "antigravity-cli", version: "1.5.13" }), "array");
    assert.equal(
      await probeSchema({ name: "mcp-client", version: "1.0.0" }, { ANTIGRAVITY_LS_VERSION: "cli-1.5.13" }),
      "array",
    );
    assert.equal(await probeSchema({ name: "Antigravity 2.0", version: "2.34.0" }), "array");
    assert.equal(await probeSchema({ name: "antigravity-ide", version: "2.7.0" }), "array");
    assert.equal(await probeSchema({ name: "antigravity-cli", version: "1.4.9" }), "array");
    // Third-party clients launched inside a pre-eager agy shell must NOT inherit ambient CLI LS version
    assert.equal(
      await probeSchema({ name: "claude-code", version: "1.5.7" }, { ANTIGRAVITY_LS_VERSION: "cli-1.5.7" }),
      "array",
    );
    assert.equal(
      await probeSchema({ name: "cursor", version: "0.49.0" }, { ANTIGRAVITY_LS_VERSION: "cli-1.5.7" }),
      "array",
    );

    // Explicit AGY_FAST_EDITS_FORMAT override works in both directions
    assert.equal(
      await probeSchema(
        { name: "antigravity-cli", version: "1.5.7" },
        { AGY_FAST_EDITS_FORMAT: "array" },
      ),
      "array",
    );
    assert.equal(
      await probeSchema(
        { name: "antigravity-cli", version: "1.5.13" },
        { AGY_FAST_EDITS_FORMAT: "string" },
      ),
      "string",
    );
    assert.equal(
      await probeSchema(
        { name: "antigravity-ide", version: "2.7.0" },
        { AGY_FAST_EDITS_FORMAT: "string" },
      ),
      "string",
    );
  });

  it("keeps every serialized tools/list entry <= 1280 UTF-8 bytes in both array and string modes", async () => {
    const MAX_TOOL_SCHEMA_BYTES = 1280;
    for (const mode of ["array", "string"] as const) {
      const res = await sendMessagesToServer(
        [
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "test", version: "1.0.0" },
            },
          }) + "\n",
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
        ],
        { AGY_FAST_EDITS_FORMAT: mode },
      );
      assert.equal(res.code, 0);
      assert.equal(res.stderr, "");
      const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
      const tools = lines.find((l) => l.id === 2)?.result?.tools as Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
      assert.equal(tools.length, 5);
      for (const tool of tools) {
        const bytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
        assert.ok(
          bytes <= MAX_TOOL_SCHEMA_BYTES,
          `tool ${tool.name} (${mode} mode) is ${bytes} UTF-8 bytes, exceeding ${MAX_TOOL_SCHEMA_BYTES}B budget`,
        );
      }
      const applyTool = tools.find((t) => t.name === "apply_edits")!;
      if (mode === "array") {
        assert.doesNotMatch(
          applyTool.description,
          /JSON array string/i,
          "array-mode apply_edits must not bait strict JSON Schema hosts into sending stringified edits",
        );
      }
    }
  });

  it("resolves tool paths against the client's workspace root instead of its own cwd", async () => {
    const msgs = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "test", version: "1.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      // Sent before the roots answer: the call must wait for it.
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_slices", arguments: { outlines: ["demo.ts"] } },
      },
      {
        jsonrpc: "2.0",
        id: "agy-fast-roots-1",
        result: { roots: [{ uri: pathToFileURL(tmpDir).href }] },
      },
    ];

    const res = await sendMessagesToServer(msgs.map((m) => `${JSON.stringify(m)}\n`));
    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");
    const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.find((l) => l.method === "roots/list"),
      { jsonrpc: "2.0", id: "agy-fast-roots-1", method: "roots/list" },
    );
    const call = lines.find((l) => l.id === 2);
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0].text, /greet/);
    // The roots answer is consumed, not treated as an invalid request.
    assert.equal(lines.filter((l) => l.error).length, 0);
    // initialize response is emitted before the server-initiated roots/list request.
    const initIdx = lines.findIndex((l) => l.id === 1);
    const rootsIdx = lines.findIndex((l) => l.method === "roots/list");
    assert.ok(initIdx !== -1 && rootsIdx !== -1 && initIdx < rootsIdx);

    // Startup handshake (initialize -> notifications/initialized -> tools/list) must be strictly
    // unidirectional (0 server-initiated roots/list frames) so it cannot wedge client Connect().
    const handshakeRes = await sendMessagesToServer(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: "test", version: "1.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        // Explicit absolute cwd also skips lazy roots/list completely
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "read_slices", arguments: { cwd: tmpDir, outlines: ["demo.ts"] } },
        },
      ].map((m) => `${JSON.stringify(m)}\n`),
    );
    assert.equal(handshakeRes.code, 0);
    assert.equal(handshakeRes.stderr, "");
    const handshakeLines = handshakeRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(handshakeLines.filter((l) => l.method === "roots/list").length, 0);
    const hsCall = handshakeLines.find((l) => l.id === 3);
    assert.equal(hsCall?.result?.isError, false);
    assert.match(hsCall?.result?.content?.[0]?.text ?? "", /greet/);

    // Relative cwd resolves against the lazily fetched workspace root without mutating process.cwd().
    const subDir = path.join(tmpDir, "sub-root-check");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "nested.ts"), "export function nestedFn() { return 42; }\n", "utf8");
    const relRes = await sendMessagesToServer(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: "test", version: "1.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "read_slices", arguments: { cwd: "sub-root-check", outlines: ["nested.ts"] } },
        },
        {
          jsonrpc: "2.0",
          id: "agy-fast-roots-1",
          result: { roots: [{ uri: "file:///nonexistent-agy-fast-root-xyz" }, { uri: pathToFileURL(tmpDir).href }] },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "quick_outline", arguments: { cwd: "sub-root-check", paths: ["nested.ts"] } },
        },
      ].map((m) => `${JSON.stringify(m)}\n`),
    );
    assert.equal(relRes.code, 0);
    assert.equal(relRes.stderr, "");
    const relLines = relRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(relLines.filter((l) => l.method === "roots/list").length, 1);
    const relCall = relLines.find((l) => l.id === 2);
    assert.equal(relCall.result.isError, false);
    assert.match(relCall.result.content[0].text, /nestedFn/);
    const relQuickCall = relLines.find((l) => l.id === 3);
    assert.equal(relQuickCall.result.isError, false);
    assert.match(relQuickCall.result.content[0].text, /nestedFn/);

    // Overlapped list_changed + out-of-order replies + malformed roots + unanswered roots must never deadlock or crash
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-root2-"));
    try {
      await fs.writeFile(path.join(otherRoot, "root2.ts"), "export function fromRoot2() { return 2; }\n", "utf8");
      const overlapRes = await sendMessagesToServer(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } } },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "read_slices", arguments: { outlines: ["root2.ts"] } },
          },
          { jsonrpc: "2.0", method: "notifications/roots/list_changed" },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "read_slices", arguments: { outlines: ["root2.ts"] } },
          },
          // Newer roots-2 arrives first, stale roots-1 arrives later (must not revert root or emit -32600)
          {
            jsonrpc: "2.0",
            id: "agy-fast-roots-2",
            result: { roots: [{ uri: pathToFileURL(otherRoot).href }] },
          },
          {
            jsonrpc: "2.0",
            id: "agy-fast-roots-1",
            result: { roots: [{ uri: pathToFileURL(tmpDir).href }] },
          },
        ].map((m) => `${JSON.stringify(m)}\n`),
      );
      assert.equal(overlapRes.code, 0);
      assert.equal(overlapRes.stderr, "");
      const ovLines = overlapRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(ovLines.filter((l) => l.error).length, 0);
      const ovCall = ovLines.find((l) => l.id === 3);
      assert.equal(ovCall?.result?.isError, false);
      assert.match(ovCall?.result?.content?.[0]?.text ?? "", /fromRoot2/);

      // Malformed/nonexistent/null roots and unanswered roots on EOF must never crash or drop responses
      const badRootsRes = await sendMessagesToServer(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } } },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "read_slices", arguments: { outlines: ["nonexistent-probe.ts"] } },
          },
          {
            jsonrpc: "2.0",
            id: "agy-fast-roots-1",
            result: { roots: [null, { uri: "file:not a valid url" }, { uri: "file:///nonexistent-agy-fast-99999" }] },
          },
          { jsonrpc: "2.0", method: "notifications/roots/list_changed" },
          // Deliberately leave lazy roots-2 unanswered before EOF on next call
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "read_slices", arguments: { cwd: tmpDir, outlines: ["demo.ts"] } },
          },
        ].map((m) => `${JSON.stringify(m)}\n`),
      );
      assert.equal(badRootsRes.code, 0);
      assert.equal(badRootsRes.stderr, "");
      const badLines = badRootsRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(badLines.filter((l) => l.error).length, 0);
      const badCall = badLines.find((l) => l.id === 3);
      assert.equal(badCall?.result?.isError, false);
      assert.match(badCall?.result?.content?.[0]?.text ?? "", /greet/);

      // Batched [initialize, notifications/initialized] emits ONLY the initialize response (no eager roots/list);
      // lazy roots/list triggers on tools/call; "error": null and uppercase FILE: URI still apply roots; non-string cwd returns clean error.
      const batchRes = await sendMessagesToServer([
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: { roots: {} } },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
        ]) + "\n",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "read_slices", arguments: { outlines: ["demo.ts"] } },
        }) + "\n",
        JSON.stringify({
          jsonrpc: "2.0",
          id: "agy-fast-roots-1",
          error: null,
          result: { roots: [{ uri: pathToFileURL(tmpDir).href.replace(/^file:/, "FILE:") }] },
        }) + "\n",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "read_slices", arguments: { cwd: 123, outlines: ["demo.ts"] } },
        }) + "\n",
      ]);
      assert.equal(batchRes.code, 0);
      assert.equal(batchRes.stderr, "");
      const bLines = batchRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(Array.isArray(bLines[0]) && bLines[0][0]?.id === 1);
      assert.equal(bLines[1]?.method, "roots/list");
      const bCall4 = bLines.find((l) => !Array.isArray(l) && l.id === 4);
      assert.equal(bCall4?.result?.isError, false);
      assert.match(bCall4?.result?.content?.[0]?.text ?? "", /greet/);
      const bCall5 = bLines.find((l) => !Array.isArray(l) && l.id === 5);
      assert.equal(bCall5?.result?.isError, true);
      assert.match(bCall5?.result?.content?.[0]?.text ?? "", /'cwd' must be a string/);

      // Mixed LF+CRLF (\n\r\n) Content-Length header separator must not hang or desync next frame
      const mp1 = JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" });
      const mp2 = JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" });
      const mixedSepRes = await sendMessagesToServer([
        `Content-Length: ${Buffer.byteLength(mp1, "utf8")}\n\r\n${mp1}` +
          `Content-Length: ${Buffer.byteLength(mp2, "utf8")}\r\n\r\n${mp2}`,
      ]);
      assert.equal(mixedSepRes.code, 0);
      const mixedBodies = [
        ...mixedSepRes.stdout.matchAll(/Content-Length: \d+\r\n\r\n(\{[^\n]*\})/g),
      ].map((m) => JSON.parse(m[1]!));
      assert.deepEqual(
        mixedBodies.map((b) => b.id).sort((a, b) => a - b),
        [10, 11],
      );

      // Interactive batch [initialize, notifications/initialized, tools/call] and
      // [notifications/roots/list_changed, tools/call] must flush roots/list immediately
      // (no 1500ms self-deadlock) and resolve tools/call in the updated workspace root.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [MCP_SERVER_SCRIPT], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let buf = "";
        let stderr = "";
        const responses: unknown[] = [];
        const startedAt = Date.now();
        let stage = 0;
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Interactive batch roots test timed out"));
        }, 5000);
        killTimer.unref();

        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.stdout.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            if (!Array.isArray(msg) && msg.method === "roots/list") {
              const targetRoot = stage === 0 ? tmpDir : otherRoot;
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { roots: [{ uri: pathToFileURL(targetRoot).href }] },
                }) + "\n",
              );
              continue;
            }
            responses.push(msg);
            if (stage === 0) {
              stage = 1;
              child.stdin.write(
                JSON.stringify([
                  { jsonrpc: "2.0", method: "notifications/roots/list_changed" },
                  {
                    jsonrpc: "2.0",
                    id: 22,
                    method: "tools/call",
                    params: { name: "read_slices", arguments: { outlines: ["root2.ts"] } },
                  },
                ]) + "\n",
              );
            } else {
              child.stdin.end();
            }
          }
        });
        child.on("close", (code) => {
          clearTimeout(killTimer);
          try {
            const elapsed = Date.now() - startedAt;
            assert.equal(code, 0);
            assert.equal(stderr, "");
            assert.ok(elapsed < 1200, `Batch roots self-deadlocked (${elapsed}ms)`);
            assert.equal(responses.length, 2);
            const batch1 = responses[0] as Array<{ id: number; result?: { isError?: boolean; content?: Array<{ text: string }> } }>;
            const call21 = batch1.find((r) => r.id === 21);
            assert.equal(call21?.result?.isError, false);
            assert.match(call21?.result?.content?.[0]?.text ?? "", /greet/);
            const batch2 = responses[1] as Array<{ id: number; result?: { isError?: boolean; content?: Array<{ text: string }> } }>;
            const call22 = batch2.find((r) => r.id === 22);
            assert.equal(call22?.result?.isError, false);
            assert.match(call22?.result?.content?.[0]?.text ?? "", /fromRoot2/);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        child.stdin.write(
          JSON.stringify([
            {
              jsonrpc: "2.0",
              id: 20,
              method: "initialize",
              params: { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } } },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            {
              jsonrpc: "2.0",
              id: 21,
              method: "tools/call",
              params: { name: "read_slices", arguments: { outlines: ["demo.ts"] } },
            },
          ]) + "\n",
        );
      });

      // Trailing unterminated notifications/initialized right at EOF must not emit spurious roots/list
      const eofRes = await sendMessagesToServer([
        JSON.stringify({
          jsonrpc: "2.0",
          id: 30,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: { roots: {} } },
        }) + "\n",
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ]);
      assert.equal(eofRes.code, 0);
      const eofLines = eofRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(eofLines.filter((l) => l.method === "roots/list").length, 0);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("handles JSON-RPC error codes, chunked UTF-8 input, and Content-Length framing", async () => {
    const brokenAndErrors = [
      "{malformed json\n",
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "no/such/method" }) + "\n",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "missing_tool", arguments: {} },
      }) + "\n",
    ];
    // Split a single request mid-UTF8 byte across chunks
    const pingJson = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: "中文-12", method: "ping" }) + "\n",
      "utf8",
    );
    const part1 = pingJson.subarray(0, 20);
    const part2 = pingJson.subarray(20);

    const res = await sendMessagesToServer([...brokenAndErrors, part1, part2]);
    assert.equal(res.code, 0);
    const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 4);
    assert.equal(lines[0].error.code, -32700);
    assert.equal(lines[1].error.code, -32601);
    assert.equal(lines[2].error.code, -32602);
    assert.equal(lines[3].id, "中文-12");
    assert.deepEqual(lines[3].result, {});

    // Test Content-Length framing (including preceding Content-Type header)
    const clBody = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" });
    const clFrame = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(clBody, "utf8")}\r\n\r\n${clBody}`;
    const clRes = await sendMessagesToServer([clFrame]);
    assert.equal(clRes.code, 0);
    assert.match(clRes.stdout, /^Content-Length: \d+\r\n\r\n/);
    const jsonPart = clRes.stdout.split("\r\n\r\n")[1]!;
    assert.equal(JSON.parse(jsonPart).id, 99);
  });

  it("flushes large (>64KB) pipelined stdout responses completely on stdin EOF and enforces 8.8KB inline cap per tool call", async () => {
    const bigFile = path.join(tmpDir, "large.txt");
    const bigLines = Array.from(
      { length: 1200 },
      (_, i) => `line_${String(i + 1).padStart(4, "0")}: ${"abcdefghij".repeat(6)}`,
    );
    await fs.writeFile(bigFile, bigLines.join("\n"), "utf8");

    // Pipeline 10 calls totaling >75KB stdout while verifying each response stays <= 8,800 UTF-8 bytes even if caller passes maxChars: 80000
    const reqs = Array.from({ length: 10 }, (_, idx) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 200 + idx,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: tmpDir,
            slices: [{ path: "large.txt", ranges: [[idx * 100 + 1, idx * 100 + 200]] }],
            maxChars: 80_000,
          },
        },
      }) + "\n",
    );

    const res = await sendMessagesToServer([reqs.join("")]);
    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");
    assert.ok(res.stdout.length > 75_000, `Expected >75KB pipelined stdout, got ${res.stdout.length}`);
    const parsed = res.stdout
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            id: number;
            result: { content: Array<{ text: string }> };
          },
      );
    assert.equal(parsed.length, 10);
    const ids = parsed.map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [200, 201, 202, 203, 204, 205, 206, 207, 208, 209]);
    for (const item of parsed) {
      const text = item.result.content[0]?.text ?? "";
      assert.ok(
        Buffer.byteLength(text, "utf8") <= 8_800,
        `Expected per-call inline cap <= 8800B, got ${Buffer.byteLength(text, "utf8")}`,
      );
      assert.match(text, /use parallel read_file/);
    }
  });

  it("handles pipelined LF+CRLF Content-Length frames, rejects empty {} requests, and surfaces non-object tool arguments", async () => {
    const p1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const p2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const mixedFrames =
      `Content-Length: ${Buffer.byteLength(p1, "utf8")}\n\n${p1}` +
      `Content-Length: ${Buffer.byteLength(p2, "utf8")}\r\n\r\n${p2}`;
    const clRes = await sendMessagesToServer([mixedFrames]);
    assert.equal(clRes.code, 0);
    const frameBodies = [...clRes.stdout.matchAll(/Content-Length: \d+\r\n\r\n(\{[^\n]*\})/g)].map(
      (m) => JSON.parse(m[1]!),
    );
    assert.deepEqual(
      frameBodies.map((b) => b.id).sort((a, b) => a - b),
      [1, 2],
    );

    const protoRes = await sendMessagesToServer([
      "{}\n",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 301,
        method: "tools/call",
        params: { name: "batch_search", arguments: true },
      }) + "\n",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 302,
        method: "tools/call",
        params: {
          name: "batch_search",
          arguments: JSON.stringify({ cwd: tmpDir, queries: [{ type: "text", pattern: "greet" }] }),
        },
      }) + "\n",
    ]);
    assert.equal(protoRes.code, 0);
    const lines = protoRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].error.code, -32600);
    assert.equal(lines[1].id, 301);
    assert.equal(lines[1].error.code, -32602);
    assert.equal(lines[2].id, 302);
    assert.match(lines[2].result.content[0].text, /demo\.ts/);

    // Duplicate or overflowing Content-Length headers fail cleanly with -32600 instead of wedging
    const badClRes = await sendMessagesToServer([
      `Content-Type: application/json; content-length: 5\r\nContent-Length: ${Buffer.byteLength(p1, "utf8")}\r\n\r\n${p1}`,
      `Content-Length: 5\r\nContent-Length: 5\r\n\r\n`,
      `Content-Length: 99999999999999999999\r\n\r\n`,
    ]);
    assert.equal(badClRes.code, 0);
    const badFrameBodies = [...badClRes.stdout.matchAll(/Content-Length: \d+\r\n\r\n(\{[^\n]*\})/g)].map(
      (m) => JSON.parse(m[1]!),
    );
    assert.equal(badFrameBodies.length, 3);
    assert.equal(badFrameBodies.filter((b) => b.id === 1).length, 1);
    assert.equal(badFrameBodies.filter((b) => b.error?.code === -32600).length, 2);
  });

  it("refuses to silently fall back to PLUGIN_ROOT when cwd is omitted or relative without MCP roots/list (Issue #22)", async () => {
    const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hub-cwd-"));
    const fakePluginDir = path.join(fakeRoot, ".gemini", "config", "plugins", "agy-fast");
    const realWorkspace = path.join(fakeRoot, "real-workspace");
    try {
      await fs.mkdir(path.join(fakePluginDir, "dist"), { recursive: true });
      await fs.mkdir(realWorkspace, { recursive: true });
      await fs.copyFile(path.resolve(process.cwd(), "plugin.json"), path.join(fakePluginDir, "plugin.json"));
      await fs.copyFile(MCP_SERVER_SCRIPT, path.join(fakePluginDir, "dist", "mcp-server.mjs"));
      await fs.writeFile(path.join(realWorkspace, "app.ts"), "export function hubApp() { return 1; }\n", "utf8");

      const runInPluginDir = (
        msgs: unknown[],
        extraEnv: Record<string, string | undefined> = {},
      ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [path.join(fakePluginDir, "dist", "mcp-server.mjs")],
            {
              cwd: fakePluginDir,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
              env: buildCleanServerEnv(extraEnv),
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
          for (const m of msgs) {
            child.stdin.write(`${JSON.stringify(m)}\n`);
          }
          child.stdin.end();
        });

      // 1. Desktop 2.0 Hub without capabilities.roots: omitted/relative cwd MUST fail fast across all 5 tools,
      //    while explicit absolute cwd works normally (even when PLUGIN_ROOT env var is not set).
      const noRootsRes = await runInPluginDir([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "hub", version: "2.34.0" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "batch_search", arguments: { queries: [{ type: "glob", pattern: "**/*" }] } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_checks", arguments: { commands: [{ command: "echo hi" }] } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "quick_outline", arguments: { paths: ["app.ts"] } } },
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_slices", arguments: { cwd: "dist", outlines: ["mcp-server.mjs"] } } },
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "apply_edits", arguments: { edits: [{ path: "rogue.txt", create: "nope" }] } } },
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "quick_outline", arguments: { cwd: realWorkspace, paths: ["app.ts"] } } },
      ]);
      assert.equal(noRootsRes.code, 0);
      assert.equal(noRootsRes.stderr, "");
      const noRootsLines = noRootsRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
      for (const id of [2, 3, 4, 6]) {
        const resp = noRootsLines.find((l) => l.id === id);
        assert.equal(resp?.result?.isError, true, `Expected fail-fast error for call id=${id}`);
        assert.match(resp?.result?.content?.[0]?.text ?? "", /'cwd' is required.*plugin directory/i);
      }
      const relResp = noRootsLines.find((l) => l.id === 5);
      assert.equal(relResp?.result?.isError, true);
      assert.match(relResp?.result?.content?.[0]?.text ?? "", /'cwd' must be an absolute workspace path/i);
      // Confirm rogue.txt was never created inside the plugin directory
      await assert.rejects(fs.access(path.join(fakePluginDir, "rogue.txt")));
      // Explicit absolute cwd works cleanly
      const explicitResp = noRootsLines.find((l) => l.id === 7);
      assert.equal(explicitResp?.result?.isError, false);
      assert.match(explicitResp?.result?.content?.[0]?.text ?? "", /hubApp/);

      // 2. Host that DOES provide MCP roots/list resolves omitted cwd against realWorkspace normally
      const withRootsRes = await runInPluginDir(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "agy", version: "1.6.0" } },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quick_outline", arguments: { paths: ["app.ts"] } } },
          { jsonrpc: "2.0", id: "agy-fast-roots-1", result: { roots: [{ uri: pathToFileURL(realWorkspace).href }] } },
        ],
        { PLUGIN_ROOT: fakePluginDir },
      );
      assert.equal(withRootsRes.code, 0);
      const withRootsLines = withRootsRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
      const rootCall = withRootsLines.find((l) => l.id === 2);
      assert.equal(rootCall?.result?.isError, false);
      assert.match(rootCall?.result?.content?.[0]?.text ?? "", /hubApp/);

      // 3. Host with PLUGIN_ROOT env var set and empty roots: [] still fails fast
      const emptyRootsRes = await runInPluginDir(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "hub", version: "2.34.0" } },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "batch_search", arguments: { queries: [{ type: "glob", pattern: "**/*" }] } } },
          { jsonrpc: "2.0", id: "agy-fast-roots-1", result: { roots: [] } },
        ],
        { PLUGIN_ROOT: fakePluginDir },
      );
      assert.equal(emptyRootsRes.code, 0);
      const emptyRootsLines = emptyRootsRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
      const emptyRootCall = emptyRootsLines.find((l) => l.id === 2);
      assert.equal(emptyRootCall?.result?.isError, true);
      assert.match(emptyRootCall?.result?.content?.[0]?.text ?? "", /'cwd' is required.*plugin directory/i);
    } finally {
      await fs.rm(fakeRoot, { recursive: true, force: true });
    }
  });

  it("refuses to fall back to the home directory or the filesystem root when cwd is omitted or relative without MCP roots/list", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-home-cwd-"));
    const project = path.join(fakeHome, "project");
    try {
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(project, "app.ts"), "export function homeApp() { return 1; }\n", "utf8");

      const runIn = (
        cwd: string,
        msgs: unknown[],
      ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [MCP_SERVER_SCRIPT], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: buildCleanServerEnv({ HOME: fakeHome, USERPROFILE: fakeHome }),
          });
          let stdout = "";
          let stderr = "";
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("MCP server test timed out"));
          }, 10_000);
          timer.unref();
          child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
          });
          for (const m of msgs) {
            child.stdin.write(`${JSON.stringify(m)}\n`);
          }
          child.stdin.end();
        });
      const init = (name: string) => [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name, version: "1.0.0" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ];
      const parse = (stdout: string) => stdout.trim().split("\n").map((l) => JSON.parse(l));

      // 1. Started in the home directory: omitted/relative cwd fails fast, nothing is written,
      //    and an explicit absolute cwd still works.
      const homeRes = await runIn(fakeHome, [
        ...init("no-roots-host"),
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "apply_edits", arguments: { edits: [{ path: "rogue.txt", create: "nope" }] } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "batch_search", arguments: { queries: [{ type: "glob", pattern: "**/*.ts" }] } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_checks", arguments: { commands: [{ command: "echo hi" }] } } },
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "quick_outline", arguments: { cwd: "project", paths: ["app.ts"] } } },
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "quick_outline", arguments: { cwd: project, paths: ["app.ts"] } } },
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_slices", arguments: { outlines: ["project/app.ts"] } } },
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "quick_outline", arguments: { cwd: "~", paths: ["project/app.ts"] } } },
        { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "quick_outline", arguments: { cwd: fakeHome, paths: ["project/app.ts"] } } },
      ]);
      assert.equal(homeRes.code, 0);
      assert.equal(homeRes.stderr, "");
      const homeLines = parse(homeRes.stdout);
      for (const id of [2, 3, 4, 7]) {
        const resp = homeLines.find((l) => l.id === id);
        assert.equal(resp?.result?.isError, true, `Expected fail-fast error for call id=${id}`);
        assert.match(resp?.result?.content?.[0]?.text ?? "", /'cwd' is required.*home directory/i);
      }
      const relResp = homeLines.find((l) => l.id === 5);
      assert.equal(relResp?.result?.isError, true);
      assert.match(relResp?.result?.content?.[0]?.text ?? "", /'cwd' must be an absolute workspace path.*home directory/i);
      await assert.rejects(fs.access(path.join(fakeHome, "rogue.txt")));
      for (const id of [6, 8, 9]) {
        const explicitResp = homeLines.find((l) => l.id === id);
        assert.equal(explicitResp?.result?.isError, false, `Expected explicit cwd call id=${id} to succeed`);
        assert.match(explicitResp?.result?.content?.[0]?.text ?? "", /homeApp/);
      }

      // 2. Started inside a project under the home directory: the process cwd is still used.
      const projectRes = await runIn(project, [
        ...init("no-roots-host"),
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quick_outline", arguments: { paths: ["app.ts"] } } },
      ]);
      assert.equal(projectRes.code, 0);
      assert.equal(projectRes.stderr, "");
      const projectResp = parse(projectRes.stdout).find((l) => l.id === 2);
      assert.equal(projectResp?.result?.isError, false);
      assert.match(projectResp?.result?.content?.[0]?.text ?? "", /homeApp/);

      // 3. Started in the home directory but the host reports roots: the root is used.
      const rootsRes = await runIn(fakeHome, [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "roots-host", version: "1.0.0" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quick_outline", arguments: { paths: ["app.ts"] } } },
        { jsonrpc: "2.0", id: "agy-fast-roots-1", result: { roots: [{ uri: pathToFileURL(project).href }] } },
      ]);
      assert.equal(rootsRes.code, 0);
      assert.equal(rootsRes.stderr, "");
      const rootsResp = parse(rootsRes.stdout).find((l) => l.id === 2);
      assert.equal(rootsResp?.result?.isError, false);
      assert.match(rootsResp?.result?.content?.[0]?.text ?? "", /homeApp/);

      // 4. Started in the filesystem root: same fail-fast (calls that would be harmless if run).
      const fsRoot = path.parse(fakeHome).root;
      const rootRes = await runIn(fsRoot, [
        ...init("no-roots-host"),
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quick_outline", arguments: { paths: ["agy-fast-missing.ts"] } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_checks", arguments: { commands: [{ command: "echo hi" }] } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "quick_outline", arguments: { cwd: "agy-fast-missing-dir", paths: ["a.ts"] } } },
      ]);
      assert.equal(rootRes.code, 0);
      assert.equal(rootRes.stderr, "");
      const rootLines = parse(rootRes.stdout);
      for (const id of [2, 3]) {
        const resp = rootLines.find((l) => l.id === id);
        assert.equal(resp?.result?.isError, true, `Expected fail-fast error for call id=${id}`);
        assert.match(resp?.result?.content?.[0]?.text ?? "", /'cwd' is required.*filesystem root/i);
      }
      const rootRelResp = rootLines.find((l) => l.id === 4);
      assert.equal(rootRelResp?.result?.isError, true);
      assert.match(rootRelResp?.result?.content?.[0]?.text ?? "", /'cwd' must be an absolute workspace path.*filesystem root/i);
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("enforces frame size cap on NDJSON stdio framing without OOM and resumes cleanly on the next valid line", async () => {
    assert.equal(MAX_FRAME_BYTES, 64 * 1024 * 1024);

    const runInMemory = async (
      maxFrameBytes: number,
      chunks: Array<string | Buffer>,
    ): Promise<Array<Record<string, unknown>>> => {
      const input = new PassThrough();
      const output = new PassThrough();
      const outChunks: Buffer[] = [];
      output.on("data", (d: Buffer) => outChunks.push(d));

      const server = new McpStdioServer({
        name: "test-cap",
        version: "0.0.1",
        maxFrameBytes,
      });

      const drained = new Promise<void>((resolve) => {
        server.listen(input, output, resolve);
      });

      for (const chunk of chunks) {
        input.write(chunk);
        await new Promise((r) => setImmediate(r));
      }
      input.end();
      await drained;

      const rawOut = Buffer.concat(outChunks).toString("utf8").trim();
      return rawOut ? rawOut.split("\n").map((line) => JSON.parse(line)) : [];
    };

    const ping = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });

    // 1. Chunked oversized NDJSON without newline emits -32600 immediately, discards continuation
    //    chunks without duplicate errors, and resumes cleanly on a chunk starting with \n
    const chunkedRes = await runInMemory(128, [
      `{"jsonrpc":"2.0","id":1,"params":"${"a".repeat(80)}`,
      `${"b".repeat(80)}`, // crosses 128 bytes with no \n -> triggers -32600 and discarding state
      `${"c".repeat(200)}`, // still discarding, must NOT emit a second error
      `\n${ping(2)}\n`, // leading \n closes discarded line; id=2 must succeed
    ]);
    assert.equal(chunkedRes.length, 2);
    assert.equal((chunkedRes[0]!.error as { code: number; message: string }).code, -32600);
    assert.match(
      (chunkedRes[0]!.error as { message: string }).message,
      /NDJSON message exceeds maximum allowed size/,
    );
    assert.equal(chunkedRes[1]!.id, 2);
    assert.deepEqual(chunkedRes[1]!.result, {});

    // 2. Single-chunk oversized NDJSON line (with \n) pipelined with a valid next request in the same chunk
    const pipelinedRes = await runInMemory(128, [
      `{"jsonrpc":"2.0","id":9,"data":"${"x".repeat(200)}"}\n${ping(3)}\n`,
    ]);
    assert.equal(pipelinedRes.length, 2);
    assert.equal((pipelinedRes[0]!.error as { code: number }).code, -32600);
    assert.equal(pipelinedRes[1]!.id, 3);
    assert.deepEqual(pipelinedRes[1]!.result, {});

    // 3. Oversized NDJSON terminated by EOF (no \n) emits exactly one -32600 and no spurious -32700
    const eofRes = await runInMemory(128, [`{"jsonrpc":"2.0","data":"${"z".repeat(200)}`]);
    assert.equal(eofRes.length, 1);
    assert.equal((eofRes[0]!.error as { code: number }).code, -32600);

    // 4. Exact boundary (LF and CRLF) succeeds, and multi-line chunks > maxFrameBytes total succeed when each line fits
    const exactPing = ping(4);
    const exactLimit = Buffer.byteLength(exactPing, "utf8");
    const boundaryRes = await runInMemory(exactLimit, [
      `${exactPing}\n${ping(5)}\r\n${ping(6)}\n`,
    ]);
    assert.deepEqual(
      boundaryRes.map((r) => r.id),
      [4, 5, 6],
    );

    // 5. Split CRLF right at the exact boundary (\r at end of chunk 1, \n at start of chunk 2) succeeds
    const crlfSplitRes = await runInMemory(exactLimit, [
      `${exactPing}\r`,
      `\n${ping(7)}\n`,
    ]);
    assert.deepEqual(
      crlfSplitRes.map((r) => r.id),
      [4, 7],
    );
  });
});
