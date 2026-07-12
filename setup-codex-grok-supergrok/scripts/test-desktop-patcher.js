#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const patcher = join(scriptDir, "patch-desktop-grok-provider.js");
const asar =
  process.env.ASAR ||
  join(process.env.HOME || "", ".codex", "xai-grok-oauth", "node_modules", ".bin", "asar");
const before =
  "else d=null;if(a){let e=await a();if(e)for(let[t,n]of Object.entries(e))l[t]=n}return{cwd:r,model:e,modelProvider:d,";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result;
}

function makeFixture(root, name) {
  const appBundle = join(root, `${name}.app`);
  const contents = join(appBundle, "Contents");
  const source = join(root, `${name}-asar-source`);
  const executable = join(contents, "MacOS", name);
  const asarPath = join(contents, "Resources", "app.asar");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  mkdirSync(join(source, "webview", "assets"), { recursive: true });
  writeFileSync(join(source, "webview", "assets", "app.js"), `const fixture = ${JSON.stringify(before)};\n`);
  run(asar, ["pack", source, asarPath]);
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>test.codex.${name.toLowerCase()}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleVersion</key><string>123</string>
<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict>
<key>algorithm</key><string>SHA256</string><key>hash</key><string>${"0".repeat(64)}</string>
</dict></dict>
</dict></plist>\n`,
  );
  run("codesign", ["--force", "--sign", "-", appBundle]);
  return { appBundle, asarPath, infoPlist: join(contents, "Info.plist"), executable };
}

function patchCommand(fixture, codexHome, command, extraEnv = {}) {
  return spawnSync(process.execPath, [patcher, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_XAI_DESKTOP_APP: fixture.appBundle,
      ASAR: asar,
      ...extraEnv,
    },
  });
}

function requireSuccess(result, label) {
  assert(result.status === 0, `${label} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

if (!existsSync(asar)) throw new Error(`ASAR tool missing at ${asar}`);

const root = mkdtempSync(join(tmpdir(), "codex-grok-patcher-test-"));
try {
  {
    const codexHome = join(root, "happy-home");
    const fixture = makeFixture(root, "HappyFixture");
    const originalAsar = sha256(fixture.asarPath);
    const patched = requireSuccess(patchCommand(fixture, codexHome, "patch"), "happy patch");
    assert(patched.status === "patched", "happy patch did not report patched");
    const inspected = requireSuccess(patchCommand(fixture, codexHome, "inspect"), "happy inspect");
    assert(inspected.patched.length === 1 && inspected.stateMatchesCurrent, "patched state did not match fixture");
    const restored = requireSuccess(patchCommand(fixture, codexHome, "restore"), "happy restore");
    assert(restored.status === "restored", "happy restore did not report restored");
    assert(sha256(fixture.asarPath) === originalAsar, "restore did not recover original ASAR");
  }

  {
    const codexHome = join(root, "stale-home");
    const fixture = makeFixture(root, "StaleFixture");
    const patched = requireSuccess(patchCommand(fixture, codexHome, "patch"), "stale patch");
    copyFileSync(patched.asarBackup, fixture.asarPath);
    const beforeRestore = sha256(fixture.asarPath);
    const restored = patchCommand(fixture, codexHome, "restore");
    assert(restored.status !== 0 && restored.stderr.includes("does not match"), "stale restore was not refused");
    assert(sha256(fixture.asarPath) === beforeRestore, "stale restore modified replacement app");
  }

  {
    const codexHome = join(root, "lock-home");
    const fixture = makeFixture(root, "LockFixture");
    const lockDir = join(codexHome, "xai-grok-oauth", "desktop-patch", "mutation.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
    const inspected = patchCommand(fixture, codexHome, "inspect");
    assert(inspected.status !== 0 && inspected.stderr.includes("already running"), "active lock was not enforced");
  }

  {
    const codexHome = join(root, "rollback-home");
    const fixture = makeFixture(root, "RollbackFixture");
    const original = {
      asar: sha256(fixture.asarPath),
      plist: sha256(fixture.infoPlist),
      executable: sha256(fixture.executable),
    };
    const fakeCodesign = join(root, "fail-codesign.sh");
    writeFileSync(fakeCodesign, "#!/bin/sh\nif [ \"$1\" = \"--force\" ]; then exit 42; fi\nexit 0\n");
    chmodSync(fakeCodesign, 0o755);
    const patched = patchCommand(fixture, codexHome, "patch", { CODEX_XAI_CODESIGN: fakeCodesign });
    assert(patched.status !== 0, "injected signing failure unexpectedly succeeded");
    assert(sha256(fixture.asarPath) === original.asar, "automatic rollback did not restore ASAR");
    assert(sha256(fixture.infoPlist) === original.plist, "automatic rollback did not restore Info.plist");
    assert(sha256(fixture.executable) === original.executable, "automatic rollback did not restore executable");
  }

  console.log("Desktop patcher regression tests passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
