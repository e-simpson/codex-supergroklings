#!/usr/bin/env bun

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const providerId = "xai-grok-oauth";
const modelId = process.env.CODEX_XAI_MODEL || "grok-4.5";
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const installDir = join(codexHome, "xai-grok-oauth");
const patchDir = join(installDir, "desktop-patch");
const statePath = join(patchDir, "state.json");
const appBundle =
  process.env.CODEX_XAI_DESKTOP_APP ||
  [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(homedir(), "Applications", "ChatGPT.app"),
    join(homedir(), "Applications", "Codex.app"),
  ].find(existsSync) || "/Applications/ChatGPT.app";
const asarPath = join(appBundle, "Contents", "Resources", "app.asar");
const infoPlistPath = join(appBundle, "Contents", "Info.plist");
const asar = process.env.ASAR || join(installDir, "node_modules", ".bin", "asar");

const before =
  "else d=null;if(a){let e=await a();if(e)for(let[t,n]of Object.entries(e))l[t]=n}return{cwd:r,model:e,modelProvider:d,";
const after =
  `else d=e===${JSON.stringify(modelId)}?${JSON.stringify(providerId)}:null;if(a){let e=await a();if(e)for(let[t,n]of Object.entries(e))l[t]=n}return{cwd:r,model:e,modelProvider:d,`;
const legacyAfter =
  modelId === "grok-4.5"
    ? "else d=e===`grok-4.5`?`xai-grok-oauth`:null;if(a){let e=await a();if(e)for(let[t,n]of Object.entries(e))l[t]=n}return{cwd:r,model:e,modelProvider:d,"
    : null;

function usage() {
  console.log(`Usage:
  patch-desktop-grok-provider.js patch
  patch-desktop-grok-provider.js restore
  patch-desktop-grok-provider.js inspect

Environment:
  CODEX_XAI_DESKTOP_APP=/Applications/ChatGPT.app
  ASAR=/path/to/asar`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readAsarHeaderHash(file) {
  const bytes = readFileSync(file);
  const headerJsonSize = bytes.readUInt32LE(12);
  if (!Number.isFinite(headerJsonSize) || headerJsonSize <= 0) {
    throw new Error(`Invalid ASAR header size in ${file}`);
  }
  return sha256(bytes.subarray(16, 16 + headerJsonSize));
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "pipe", ...options });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function appExecutablePath() {
  const executable = output("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlistPath]);
  return join(appBundle, "Contents", "MacOS", executable);
}

function copyDirectory(source, destination) {
  if (existsSync(source)) cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

function appProcesses() {
  const result = spawnSync("pgrep", ["-fl", basename(appBundle).replace(/\.app$/, "")], { encoding: "utf8" });
  const lines = result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  const executable = appExecutablePath();
  return lines.filter((line) => {
    if (!line.includes(`${appBundle}/Contents/`)) return false;
    const command = line.replace(/^\d+\s+/, "");
    return command === executable || command.startsWith(`${executable} `) || command.includes("--type=renderer");
  });
}

function ensurePatchableAppNotRunning() {
  const processes = appProcesses();
  if (processes.length > 0) {
    throw new Error(
      `Refusing to patch while ${appBundle} is running. Quit the app completely, then rerun.\n` +
        processes.slice(0, 5).join("\n"),
    );
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      walk(file, out);
    } else if (file.endsWith(".js")) {
      out.push(file);
    }
  }
  return out;
}

function inspectExtracted(root) {
  const matches = [];
  const patched = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    if (text.includes(before)) matches.push(file);
    if (text.includes(after) || (legacyAfter && text.includes(legacyAfter))) patched.push(file);
  }
  return { matches, patched };
}

function extractAsar(dest) {
  if (!existsSync(asar)) throw new Error(`Missing ASAR tool at ${asar}. Re-run the Grok installer.`);
  run(asar, ["extract", asarPath, dest], { maxBuffer: 64 * 1024 * 1024 });
}

function packAsar(src, dest) {
  if (!existsSync(asar)) throw new Error(`Missing ASAR tool at ${asar}. Re-run the Grok installer.`);
  run(asar, ["pack", src, dest], { maxBuffer: 64 * 1024 * 1024 });
}

function patch() {
  if (!existsSync(appBundle) || !existsSync(asarPath) || !existsSync(infoPlistPath)) {
    throw new Error(`Cannot find a patchable app bundle at ${appBundle}`);
  }

  ensurePatchableAppNotRunning();

  const workDir = mkdtempSync(join(tmpdir(), "codex-xai-grok-desktop-"));
  const extractDir = join(workDir, "app");
  const patchedAsar = join(workDir, "app.asar");
  mkdirSync(patchDir, { recursive: true, mode: 0o700 });

  try {
    extractAsar(extractDir);
    const inspected = inspectExtracted(extractDir);
    if (inspected.patched.length > 0 && inspected.matches.length === 0) {
      console.log(JSON.stringify({ status: "already-patched", appBundle, files: inspected.patched }, null, 2));
      return;
    }
    if (inspected.matches.length !== 1) {
      throw new Error(`Expected exactly one Grok provider hook, found ${inspected.matches.length}`);
    }

    const target = inspected.matches[0];
    const text = readFileSync(target, "utf8");
    writeFileSync(target, text.replace(before, after), "utf8");
    packAsar(extractDir, patchedAsar);

    const stamp = timestamp();
    const asarBackup = join(patchDir, `app.asar.${stamp}.bak`);
    const plistBackup = join(patchDir, `Info.plist.${stamp}.bak`);
    const executablePath = appExecutablePath();
    const executableBackup = join(patchDir, `executable.${stamp}.bak`);
    const codeSignaturePath = join(appBundle, "Contents", "_CodeSignature");
    const codeSignatureBackup = join(patchDir, `_CodeSignature.${stamp}.bak`);
    copyFileSync(asarPath, asarBackup);
    copyFileSync(infoPlistPath, plistBackup);
    copyFileSync(executablePath, executableBackup);
    copyDirectory(codeSignaturePath, codeSignatureBackup);
    copyFileSync(patchedAsar, asarPath);

    const headerHash = readAsarHeaderHash(asarPath);
    run("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,
      infoPlistPath,
    ]);
    run("codesign", ["--force", "--sign", "-", appBundle]);

    const state = {
      active: true,
      appBundle,
      asarPath,
      infoPlistPath,
      modelId,
      providerId,
      targetFile: target.replace(`${extractDir}/`, ""),
      patchedAt: new Date().toISOString(),
      asarBackup,
      plistBackup,
      executablePath,
      executableBackup,
      codeSignaturePath,
      codeSignatureBackup: existsSync(codeSignatureBackup) ? codeSignatureBackup : null,
      headerHash,
      appAsarSize: statSync(asarPath).size,
    };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: "patched", ...state }, null, 2));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function restore() {
  if (!existsSync(statePath)) {
    throw new Error(`No desktop patch state found at ${statePath}`);
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.appBundle !== appBundle) {
    throw new Error(`Patch state belongs to ${state.appBundle}, not ${appBundle}`);
  }
  ensurePatchableAppNotRunning();
  for (const file of [state.asarBackup, state.plistBackup, state.executableBackup]) {
    if (!file || !existsSync(file)) throw new Error(`Missing required backup: ${file}`);
  }

  copyFileSync(state.asarBackup, asarPath);
  copyFileSync(state.plistBackup, infoPlistPath);
  copyFileSync(state.executableBackup, state.executablePath || appExecutablePath());
  if (state.codeSignatureBackup && existsSync(state.codeSignatureBackup)) {
    copyDirectory(state.codeSignatureBackup, state.codeSignaturePath || join(appBundle, "Contents", "_CodeSignature"));
  }
  writeFileSync(statePath, `${JSON.stringify({ ...state, active: false, restoredAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: "restored", appBundle, restoredAt: new Date().toISOString() }, null, 2));
}

function inspect() {
  if (!existsSync(asarPath)) {
    console.log(JSON.stringify({ status: "missing", appBundle, asarPath }, null, 2));
    return;
  }
  const workDir = mkdtempSync(join(tmpdir(), "codex-xai-grok-inspect-"));
  try {
    extractAsar(workDir);
    const inspected = inspectExtracted(workDir);
    console.log(JSON.stringify({ appBundle, asarPath, ...inspected }, null, 2));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const command = process.argv[2] || "inspect";
try {
  if (command === "patch") patch();
  else if (command === "restore") restore();
  else if (command === "inspect") inspect();
  else {
    usage();
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
