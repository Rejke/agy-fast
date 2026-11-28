import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const testDir = path.join(rootDir, "test");
const tmpOutDir = path.join(rootDir, ".tmp", "tests");

await fs.rm(tmpOutDir, { recursive: true, force: true });
await fs.mkdir(tmpOutDir, { recursive: true });

const entries = (await fs.readdir(testDir))
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

if (entries.length === 0) {
  console.error("No test files found in test/");
  process.exit(1);
}

const outFiles = [];
for (const file of entries) {
  const outFile = path.join(tmpOutDir, file.replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [path.join(testDir, file)],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    sourcemap: "inline",
  });
  outFiles.push(outFile);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsTestConcurrency = nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 10);
const envConcurrency = Number.parseInt(process.env.AGY_FAST_TEST_CONCURRENCY ?? "", 10);
const concurrencyArgs = supportsTestConcurrency
  ? Number.isInteger(envConcurrency) && envConcurrency > 0
    ? [`--test-concurrency=${envConcurrency}`]
    : !process.env.CI && process.platform === "win32"
      ? ["--test-concurrency=2"]
      : []
  : [];
const testArgs = [
  "--test",
  ...concurrencyArgs,
  ...outFiles,
];
// Run the suite with an empty throw-away home so a contributor's own setup cannot change the
// results: global and system git config (commit/tag signing, hooks, status settings), config
// injected through GIT_CONFIG_* variables, global ignore files (which ripgrep reads as well) and
// local agy-fast switches (AGY_FAST_AUTO_UPDATE, AGY_FAST_UPDATE_CHANNEL, ...) are not inherited.
// Names are matched case-insensitively so Windows duplicates such as `Home` + `HOME` cannot survive.
const DROPPED_ENV = new RegExp(
  `^(?:${[
    "AGY_FAST_.*",
    "NODE_USE_ENV_PROXY",
    "HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME",
    "GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|PARAMETERS|COUNT|KEY_.*|VALUE_.*)",
    // Exported by git inside hooks: they would point fixture repositories at the contributor's own
    "GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX)",
  ].join("|")})$`,
  "i",
);
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-test-home-"));
let status = 1;
try {
  await fs.writeFile(path.join(testHome, ".gitconfig"), "[safe]\n\tdirectory = *\n", "utf8");
  const testEnv = { ...process.env };
  for (const key of Object.keys(testEnv)) {
    if (DROPPED_ENV.test(key)) delete testEnv[key];
  }
  testEnv.HOME = testHome;
  testEnv.USERPROFILE = testHome;
  testEnv.GIT_CONFIG_NOSYSTEM = "1";
  if (process.platform === "win32") {
    const drive = path.parse(testHome).root.replace(/[\\/]+$/, "");
    testEnv.HOMEDRIVE = drive;
    testEnv.HOMEPATH = testHome.slice(drive.length);
  }
  const res = spawnSync(process.execPath, testArgs, {
    cwd: rootDir,
    env: testEnv,
    stdio: "inherit",
  });
  status = res.status ?? 1;
} finally {
  await fs.rm(testHome, { recursive: true, force: true });
}

await fs.rm(path.join(rootDir, ".tmp"), { recursive: true, force: true });
process.exit(status);
