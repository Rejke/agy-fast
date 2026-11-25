import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const INSTALL_SH = path.resolve(process.cwd(), "install.sh");
const posixOnly = { skip: process.platform === "win32" };

interface InstallerFixture {
  tmp: string;
  project: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

async function withFixture(run: (fixture: InstallerFixture) => Promise<void>): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-shell-safety-"));
  try {
    const project = path.join(tmp, "workspace");
    const binDir = path.join(tmp, "bin");
    const repo = path.join(tmp, "local-plugin");
    const home = path.join(tmp, "home");
    await fs.mkdir(path.join(project, "scripts"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
    await fs.mkdir(home, { recursive: true });

    // Fail locally instead of contacting the network when the installer chooses remote mode.
    const fakeGit = path.join(binDir, "git");
    await fs.writeFile(fakeGit, "#!/bin/sh\necho REMOTE_CLONE_ATTEMPT >&2\nexit 19\n");
    await fs.chmod(fakeGit, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    delete env.AGY_FAST_REPO;
    await run({ tmp, project, repo, env });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("piped install never executes a workspace-local decoy installer", posixOnly, async () => {
  await withFixture(async ({ project, env }) => {
    await fs.writeFile(path.join(project, "plugin.json"), JSON.stringify({ name: "agy-fast" }));
    await fs.writeFile(path.join(project, "scripts", "install.mjs"), 'console.log("DECOY_EXECUTED");\n');
    const source = await fs.readFile(INSTALL_SH, "utf8");
    const res = spawnSync("sh", ["-s"], {
      cwd: project,
      env,
      input: source,
      encoding: "utf8",
    });
    assert.equal(res.status, 19, res.stderr);
    assert.match(res.stderr, /REMOTE_CLONE_ATTEMPT/);
    assert.doesNotMatch(res.stdout, /DECOY_EXECUTED/);
  });
});

test("explicit local shell install resolves its own directory from another cwd", posixOnly, async () => {
  await withFixture(async ({ project, repo, env }) => {
    await fs.copyFile(INSTALL_SH, path.join(repo, "install.sh"));
    await fs.writeFile(path.join(repo, "plugin.json"), JSON.stringify({ name: "agy-fast" }));
    await fs.writeFile(
      path.join(repo, "scripts", "install.mjs"),
      'console.log("LOCAL_INSTALLER", process.argv.slice(2).join(" "));\n',
    );
    const absolutePath = path.join(repo, "install.sh");
    const res = spawnSync("sh", [absolutePath, "doctor"], { cwd: project, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /LOCAL_INSTALLER doctor/);
    assert.doesNotMatch(res.stderr, /REMOTE_CLONE_ATTEMPT/);
  });
});

test("explicit local shell install rejects another plugin's manifest", posixOnly, async () => {
  await withFixture(async ({ project, repo, env }) => {
    await fs.copyFile(INSTALL_SH, path.join(repo, "install.sh"));
    await fs.writeFile(path.join(repo, "plugin.json"), JSON.stringify({ name: "different-plugin" }));
    await fs.writeFile(path.join(repo, "scripts", "install.mjs"), 'console.log("WRONG_PLUGIN_EXECUTED");\n');
    const res = spawnSync("sh", [path.join(repo, "install.sh")], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(res.status, 19, res.stderr);
    assert.match(res.stderr, /REMOTE_CLONE_ATTEMPT/);
    assert.doesNotMatch(res.stdout, /WRONG_PLUGIN_EXECUTED/);
  });
});
