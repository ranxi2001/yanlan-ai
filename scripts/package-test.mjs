import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "yanlan-package-"));
const npmCli = process.platform === "win32"
  ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  : "";
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArgs = (args) => process.platform === "win32" ? [npmCli, ...args] : args;

try {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { stdout } = await execFile(npmCommand, npmArgs(["pack", "--json", "--pack-destination", temporaryDirectory]), {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const packed = JSON.parse(stdout)[0];
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const required of [
    "bin/yanlan.mjs",
    "src/api.js",
    "src/agent/harness.js",
    "src/agent/profiles/meeting-analysis.js",
    "src/agent/profiles/terminology.js",
    "src/agent/responses-adapter.js",
    "src/agent/tool-registry.js",
    "src/cli.js",
    "skills/yanlan-transcribe/SKILL.md",
    "public/THIRD_PARTY_NOTICES.txt",
  ]) {
    assert.ok(files.has(required), `package is missing ${required}`);
  }

  const installDirectory = join(temporaryDirectory, "installed");
  await mkdir(installDirectory);
  const tarball = join(temporaryDirectory, packed.filename);
  await execFile(npmCommand, npmArgs(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball]), {
    maxBuffer: 4 * 1024 * 1024,
  });
  const installedCli = join(installDirectory, "node_modules", packageJson.name, "bin", "yanlan.mjs");
  const version = await execFile(process.execPath, [installedCli, "--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);
  console.log(`Package flow passed: ${packed.filename} installs and runs Yanlan CLI ${packageJson.version}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
