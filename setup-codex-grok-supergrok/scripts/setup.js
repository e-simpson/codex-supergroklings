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
const proxyPort = Number(process.env.CODEX_XAI_PROXY_PORT || 48145);
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

try {
  console.log(`This installs the local xAI OAuth provider, Grok role, ${implicitGrokSubagents ? "implicit" : "explicit"} $grok-subagents skill, and V1 routing for supported root models.`);
  console.log("It never changes the global root model provider and never prints OAuth tokens.");
  console.log("It does not patch the Desktop app; that optional step requires a separate explicit decision.");

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
  console.log(implicitGrokSubagents
    ? "Grok Subagents is enabled for implicit use on eligible bounded work."
    : "Invoke $grok-subagents when you want bounded, parallel Grok review or investigation work.");
  console.log("Restart Codex Desktop now. Then start a brand-new supported-root task and verify native Grok delegation with agent_type=\"grok_4_5_subagent\" and fork_context=false.");
  console.log("If Grok fails after restart, report the exact failure and check role/provider registration, OAuth status, proxy health, and xAI entitlement or usage limits; do not silently fall back.");
} catch (error) {
  console.error(`\n[setup] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
