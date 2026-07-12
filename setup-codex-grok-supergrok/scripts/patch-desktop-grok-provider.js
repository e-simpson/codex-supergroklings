#!/usr/bin/env bun

import {
  copyFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
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
const lockDir = join(patchDir, "mutation.lock");
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
const codesign = process.env.CODEX_XAI_CODESIGN || "codesign";
const plistBuddy = process.env.CODEX_XAI_PLIST_BUDDY || "/usr/libexec/PlistBuddy";

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
  ASAR=/path/to/asar
  CODEX_XAI_CODESIGN=/usr/bin/codesign`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function readFully(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset;
}

function readAsarHeaderHash(file) {
  const fd = openSync(file, "r");
  const prefix = Buffer.alloc(16);
  try {
    if (readFully(fd, prefix, 0) !== prefix.length) {
      throw new Error(`Cannot read ASAR prefix from ${file}`);
    }
    const headerJsonSize = prefix.readUInt32LE(12);
    if (!Number.isFinite(headerJsonSize) || headerJsonSize <= 0) {
      throw new Error(`Invalid ASAR header size in ${file}`);
    }
    const header = Buffer.alloc(headerJsonSize);
    if (readFully(fd, header, 16) !== header.length) {
      throw new Error(`Cannot read complete ASAR header from ${file}`);
    }
    return sha256(header);
  } finally {
    closeSync(fd);
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "pipe", ...options });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function appExecutablePath() {
  const executable = output(plistBuddy, ["-c", "Print :CFBundleExecutable", infoPlistPath]);
  return join(appBundle, "Contents", "MacOS", executable);
}

function appIdentity() {
  const executablePath = appExecutablePath();
  return {
    bundleVersion: output(plistBuddy, ["-c", "Print :CFBundleShortVersionString", infoPlistPath]),
    bundleBuild: output(plistBuddy, ["-c", "Print :CFBundleVersion", infoPlistPath]),
    asarHash: sha256File(asarPath),
    infoPlistHash: sha256File(infoPlistPath),
    executablePath,
    executableHash: sha256File(executablePath),
  };
}

function copyDirectory(source, destination) {
  if (existsSync(source)) cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

function replaceDirectory(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  copyDirectory(source, destination);
}

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireMutationLock() {
  mkdirSync(patchDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
        mode: 0o600,
      });
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
      } catch {}
      if (pidIsRunning(owner?.pid)) {
        throw new Error(`Another Desktop patch operation is already running as PID ${owner.pid}.`);
      }
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  throw new Error("Could not acquire the Desktop patch lock.");
}

function withMutationLock(operation) {
  acquireMutationLock();
  try {
    return operation();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
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

function readState() {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
}

function verifyMatchingActiveState(identity) {
  const state = readState();
  if (!state?.active) {
    throw new Error("Desktop contains the Grok patch but has no active restore state. Reinstall the official app before patching again.");
  }
  if (state.appBundle !== appBundle) {
    throw new Error(`Desktop patch state belongs to ${state.appBundle}, not ${appBundle}.`);
  }
  if (!state.patchedAsarHash || !state.bundleVersion || !state.bundleBuild) {
    throw new Error("Desktop patch state predates safe build/hash validation. Reinstall the official app before patching again.");
  }
  if (
    state.patchedAsarHash !== identity.asarHash ||
    state.bundleVersion !== identity.bundleVersion ||
    state.bundleBuild !== identity.bundleBuild
  ) {
    throw new Error("Desktop is patched, but its build or ASAR does not match the active restore state. Refusing unsafe recovery.");
  }
  return state;
}

function restoreBackups(state) {
  for (const file of [state.asarBackup, state.plistBackup, state.executableBackup, state.codeSignatureBackup]) {
    if (!file || !existsSync(file)) throw new Error(`Missing required backup: ${file}`);
  }
  copyFileSync(state.asarBackup, asarPath);
  copyFileSync(state.plistBackup, infoPlistPath);
  copyFileSync(state.executableBackup, state.executablePath || appExecutablePath());
  replaceDirectory(state.codeSignatureBackup, state.codeSignaturePath || join(appBundle, "Contents", "_CodeSignature"));
}

function patch() {
  if (!existsSync(appBundle) || !existsSync(asarPath) || !existsSync(infoPlistPath)) {
    throw new Error(`Cannot find a patchable app bundle at ${appBundle}`);
  }

  ensurePatchableAppNotRunning();

  const workDir = mkdtempSync(join(tmpdir(), "codex-xai-grok-desktop-"));
  const extractDir = join(workDir, "app");
  const patchedAsar = join(workDir, "app.asar");
  const stagedAsar = `${asarPath}.codex-xai-grok.tmp`;
  mkdirSync(patchDir, { recursive: true, mode: 0o700 });
  let rollbackState = null;
  let appMutated = false;

  try {
    extractAsar(extractDir);
    const inspected = inspectExtracted(extractDir);
    if (inspected.patched.length > 0 && inspected.matches.length === 0) {
      const identity = appIdentity();
      verifyMatchingActiveState(identity);
      run(codesign, ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
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
    if (!existsSync(codeSignaturePath)) throw new Error(`Missing original app signature at ${codeSignaturePath}`);
    const originalIdentity = appIdentity();
    copyFileSync(asarPath, asarBackup);
    copyFileSync(infoPlistPath, plistBackup);
    copyFileSync(executablePath, executableBackup);
    copyDirectory(codeSignaturePath, codeSignatureBackup);
    rollbackState = {
      asarBackup,
      plistBackup,
      executablePath,
      executableBackup,
      codeSignaturePath,
      codeSignatureBackup,
    };
    if (existsSync(statePath)) {
      copyFileSync(statePath, join(patchDir, `state.${stamp}.stale.json`));
    }
    copyFileSync(patchedAsar, stagedAsar);
    appMutated = true;
    renameSync(stagedAsar, asarPath);

    const headerHash = readAsarHeaderHash(asarPath);
    run(plistBuddy, [
      "-c",
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,
      infoPlistPath,
    ]);
    run(codesign, ["--force", "--sign", "-", appBundle]);
    run(codesign, ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
    const patchedIdentity = appIdentity();

    const state = {
      active: true,
      appBundle,
      asarPath,
      infoPlistPath,
      modelId,
      providerId,
      bundleVersion: originalIdentity.bundleVersion,
      bundleBuild: originalIdentity.bundleBuild,
      targetFile: target.replace(`${extractDir}/`, ""),
      patchedAt: new Date().toISOString(),
      asarBackup,
      plistBackup,
      executablePath,
      executableBackup,
      codeSignaturePath,
      codeSignatureBackup: existsSync(codeSignatureBackup) ? codeSignatureBackup : null,
      originalAsarHash: originalIdentity.asarHash,
      patchedAsarHash: patchedIdentity.asarHash,
      originalInfoPlistHash: originalIdentity.infoPlistHash,
      patchedInfoPlistHash: patchedIdentity.infoPlistHash,
      originalExecutableHash: originalIdentity.executableHash,
      patchedExecutableHash: patchedIdentity.executableHash,
      headerHash,
      appAsarSize: statSync(asarPath).size,
    };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: "patched", ...state }, null, 2));
  } catch (error) {
    if (appMutated && rollbackState) {
      try {
        restoreBackups(rollbackState);
        run(codesign, ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
      } catch (rollbackError) {
        throw new Error(
          `Desktop patch failed and automatic rollback also failed: ${String(error)}; rollback: ${String(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(stagedAsar, { force: true });
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
  if (!state.active) {
    console.log(JSON.stringify({ status: "already-restored", appBundle, restoredAt: state.restoredAt || null }, null, 2));
    return;
  }
  ensurePatchableAppNotRunning();
  if (!state.patchedAsarHash || !state.bundleVersion || !state.bundleBuild) {
    throw new Error("Restore state predates safe build/hash validation. Refusing to overwrite the current app; reinstall the official app instead.");
  }
  const currentIdentity = appIdentity();
  verifyMatchingActiveState(currentIdentity);
  restoreBackups(state);
  run(codesign, ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
  const restoredIdentity = appIdentity();
  if (
    restoredIdentity.asarHash !== state.originalAsarHash ||
    restoredIdentity.bundleVersion !== state.bundleVersion ||
    restoredIdentity.bundleBuild !== state.bundleBuild
  ) {
    throw new Error("Restore completed but the restored app identity does not match its recorded original state.");
  }
  const restoredAt = new Date().toISOString();
  writeFileSync(statePath, `${JSON.stringify({ ...state, active: false, restoredAt }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: "restored", appBundle, restoredAt }, null, 2));
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
    const identity = appIdentity();
    const state = readState();
    const stateMatchesCurrent = Boolean(
      state?.active &&
      state.appBundle === appBundle &&
      state.patchedAsarHash === identity.asarHash &&
      state.bundleVersion === identity.bundleVersion &&
      state.bundleBuild === identity.bundleBuild
    );
    console.log(JSON.stringify({ appBundle, asarPath, ...identity, stateMatchesCurrent, ...inspected }, null, 2));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const command = process.argv[2] || "inspect";
try {
  if (command === "patch") withMutationLock(patch);
  else if (command === "restore") withMutationLock(restore);
  else if (command === "inspect") withMutationLock(inspect);
  else {
    usage();
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
