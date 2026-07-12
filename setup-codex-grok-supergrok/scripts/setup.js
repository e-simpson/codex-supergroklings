#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const codexHome = process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex");
const bunPath = process.env.BUN_PATH || process.execPath;
const codexBin = process.env.CODEX_BIN || "codex";
const helperPath = join(codexHome, "xai-grok-oauth", "xai-grok-oauth.js");
const desktopPatchPath = join(codexHome, "xai-grok-oauth", "patch-desktop-grok-provider.js");
const proxyPort = Number(process.env.CODEX_XAI_PROXY_PORT || 48145);
const desktopPatchOnly = process.argv.includes("--desktop-patch-only");
const desktopPatchSetting = (process.env.CODEX_XAI_DESKTOP_PATCH || "1").trim().toLowerCase();
const desktopPatchEnabled = !new Set(["0", "false", "no", "off"]).has(desktopPatchSetting);
const grokSubagentsMode = (process.env.CODEX_GROK_SUBAGENTS_MODE || "standard").trim().toLowerCase();
if (!new Set(["standard", "aggressive"]).has(grokSubagentsMode)) {
  throw new Error("CODEX_GROK_SUBAGENTS_MODE must be either standard or aggressive.");
}
const implicitGrokSubagents = grokSubagentsMode === "aggressive";

function run(label, command, args, options = {}) {
  console.log(`\n[setup] ${label}`);
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ""}`);
  }
  return result;
}

function isLoggedIn() {
  if (!existsSync(helperPath)) return false;
  const result = spawnSync(bunPath, [helperPath, "status"], { encoding: "utf8" });
  if (result.status !== 0) return false;
  try {
    return Boolean(JSON.parse(result.stdout).logged_in);
  } catch {
    return false;
  }
}

async function verifyProxy() {
  console.log("\n[setup] Verifying local xAI proxy health");
  const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
  const body = await response.text();
  if (!response.ok || !body.includes('"ok":true')) {
    throw new Error(`Local xAI proxy health check failed: HTTP ${response.status}`);
  }
  console.log("Local xAI proxy is healthy.");
}

function parseJsonOutput(label, result) {
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function desktopAppProcesses(appBundle) {
  const result = spawnSync("pgrep", ["-fl", appBundle], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const executableResult = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", join(appBundle, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  const executablePath = executableResult.status === 0
    ? join(appBundle, "Contents", "MacOS", executableResult.stdout.trim())
    : null;
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes(`${appBundle}/Contents/`))
    .filter((line) => {
      const command = line.replace(/^\d+\s+/, "");
      return line.includes("--type=renderer") || Boolean(
        executablePath && (command === executablePath || command.startsWith(`${executablePath} `)),
      );
    });
}

function restoreAfterLaunchFailure(appBundle, detail) {
  console.error(`Patched Desktop app did not launch${detail ? `: ${detail}` : ""}. Restoring the recorded vendor bundle now.`);
  const restored = spawnSync(bunPath, [desktopPatchPath, "restore"], { encoding: "utf8" });
  if (restored.stdout) process.stdout.write(restored.stdout);
  if (restored.stderr) process.stderr.write(restored.stderr);
  if (restored.error || restored.status !== 0) {
    throw new Error("Desktop launch failed and automatic restore also failed. Reinstall the official app before continuing.");
  }
  spawnSync("open", [appBundle]);
  throw new Error("Desktop launch verification failed. The original vendor bundle was restored and reopened; Grok root routing was not enabled.");
}

function verifyDesktopLaunch(appBundle) {
  if (process.env.CODEX_XAI_SKIP_DESKTOP_LAUNCH_TEST === "1") {
    console.log("\n[setup] Desktop launch verification skipped by CODEX_XAI_SKIP_DESKTOP_LAUNCH_TEST=1.");
    return;
  }
  if (desktopAppProcesses(appBundle).length === 0) {
    console.log("\n[setup] Launching patched Desktop app");
    const opened = spawnSync("open", [appBundle], { encoding: "utf8" });
    if (opened.error || opened.status !== 0) {
      restoreAfterLaunchFailure(appBundle, opened.stderr || opened.error?.message || "open command failed");
    }
  }
  for (let attempt = 0; attempt < 15; attempt += 1) {
    spawnSync("sleep", ["1"]);
    if (desktopAppProcesses(appBundle).length > 0) {
      console.log("Patched Desktop app launch verified.");
      return;
    }
  }
  restoreAfterLaunchFailure(appBundle, "no main executable or renderer appeared within 15 seconds");
}

function patchDesktop() {
  if (!existsSync(desktopPatchPath)) {
    throw new Error(`Desktop patcher is missing at ${desktopPatchPath}. Run the full setup first.`);
  }

  const inspected = parseJsonOutput(
    "Desktop patch inspection",
    run("Inspecting guarded Desktop routing hook", bunPath, [desktopPatchPath, "inspect"]),
  );
  if (inspected.patched?.length === 1 && inspected.matches?.length === 0) {
    if (!inspected.stateMatchesCurrent) {
      throw new Error("Desktop is patched but does not have matching active build/hash restore state. Reinstall the official app before continuing.");
    }
    run("Verifying Desktop app signature", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", inspected.appBundle]);
    console.log("Desktop Grok routing is already patched.");
    return { appBundle: inspected.appBundle, alreadyPatched: true };
  }
  if (inspected.matches?.length !== 1 || inspected.patched?.length !== 0) {
    throw new Error(
      `Refusing Desktop patch: expected one unpatched hook, found ${inspected.matches?.length || 0} unpatched and ${inspected.patched?.length || 0} patched.`,
    );
  }

  console.log("\n[setup] Applying guarded Grok-only Desktop routing patch");
  const result = spawnSync(bunPath, [desktopPatchPath, "patch"], { encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (output.includes("Refusing to patch while")) {
      console.log("\n[setup] DESKTOP PATCH PENDING");
      console.log("Core installation is verified, but the running ChatGPT/Codex app cannot patch itself.");
      console.log("Quit the app completely, then run:");
      console.log(`${JSON.stringify(bunPath)} ${JSON.stringify(new URL(import.meta.url).pathname)} --desktop-patch-only`);
      return null;
    }
    throw new Error(`Desktop patch failed${result.error ? `: ${result.error.message}` : ""}`);
  }

  const verified = parseJsonOutput(
    "Patched Desktop inspection",
    run("Verifying patched Desktop routing hook", bunPath, [desktopPatchPath, "inspect"]),
  );
  if (verified.patched?.length !== 1 || verified.matches?.length !== 0) {
    throw new Error("Desktop patch completed but guarded hook verification failed.");
  }
  if (!verified.stateMatchesCurrent) {
    throw new Error("Desktop patch completed but build/hash restore state does not match the patched app.");
  }
  run("Verifying Desktop app signature", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", verified.appBundle]);
  return { appBundle: verified.appBundle, alreadyPatched: false };
}

try {
  if (desktopPatchOnly) {
    if (!desktopPatchEnabled) throw new Error("--desktop-patch-only conflicts with CODEX_XAI_DESKTOP_PATCH=0.");
    const patched = patchDesktop();
    if (!patched) process.exitCode = 2;
    else {
      verifyDesktopLaunch(patched.appBundle);
      console.log("\n[setup] Desktop patch and launch verified. Test a brand-new Grok root task.");
    }
    process.exit(process.exitCode || 0);
  }

  console.log(`This installs the local xAI OAuth provider, Grok role, ${implicitGrokSubagents ? "implicit" : "explicit"} $grok-subagents skill, and V1 routing for supported root models.`);
  console.log("It never changes the global root model provider and never prints OAuth tokens.");
  console.log(desktopPatchEnabled
    ? "Desktop Grok root routing is enabled by default and will be patched after core verification. The app must be fully quit for that step."
    : "Desktop app patching is disabled by CODEX_XAI_DESKTOP_PATCH=0; CLI and Grok subagents will still be installed.");

  run("Installing provider, catalog, role, and loopback proxy", bunPath, [join(scriptDir, "install.js")]);

  if (isLoggedIn()) {
    console.log("\n[setup] Existing xAI OAuth session found; skipping device authorization.");
  } else {
    run("Starting xAI device authorization", bunPath, [helperPath, "login"], { stdio: "inherit", encoding: undefined });
  }

  run("Checking OAuth session status", bunPath, [helperPath, "status"]);
  await verifyProxy();
  const smoke = run(
    "Verifying Grok CLI routing",
    codexBin,
    ["--profile", "grok", "exec", "--skip-git-repo-check", "Reply exactly: GROK_OK"],
  );
  if (!`${smoke.stdout || ""}${smoke.stderr || ""}`.includes("GROK_OK")) {
    throw new Error("Grok CLI command completed without the required GROK_OK response.");
  }

  console.log("\n[setup] Core installation verified.");
  const desktopPatchResult = desktopPatchEnabled ? patchDesktop() : null;
  if (desktopPatchResult) verifyDesktopLaunch(desktopPatchResult.appBundle);
  console.log(implicitGrokSubagents
    ? "Grok Subagents is enabled for implicit use on eligible bounded work."
    : "Invoke $grok-subagents when you want bounded, parallel Grok review or investigation work.");
  if (desktopPatchEnabled && !desktopPatchResult) {
    console.log("Complete the pending Desktop patch command after quitting the app, then reopen Codex.");
  } else {
    console.log("Restart Codex Desktop now.");
  }
  console.log("Then start a brand-new supported-root task and verify native Grok delegation with agent_type=\"grok_4_5_subagent\" and fork_context=false.");
  if (desktopPatchResult) console.log("Also select Grok 4.5 in a brand-new task and verify direct root-model routing.");
  console.log("If Grok fails after restart, report the exact failure and check role/provider registration, OAuth status, proxy health, and xAI entitlement or usage limits; do not silently fall back.");
} catch (error) {
  console.error(`\n[setup] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
