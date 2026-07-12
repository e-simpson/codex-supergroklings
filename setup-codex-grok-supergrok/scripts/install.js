#!/usr/bin/env bun

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

if (process.platform !== "darwin") {
  throw new Error("This installer currently supports Codex Desktop on macOS only.");
}

const userHome = process.env.HOME || homedir();
const codexHome = process.env.CODEX_HOME || join(userHome, ".codex");
const installDir = join(codexHome, "xai-grok-oauth");
const helperSource = new URL("./xai-grok-oauth.js", import.meta.url).pathname;
const proxySource = new URL("./xai-codex-proxy.js", import.meta.url).pathname;
const desktopPatchSource = new URL("./patch-desktop-grok-provider.js", import.meta.url).pathname;
const packageSource = new URL("./package.json", import.meta.url).pathname;
const lockSource = new URL("./bun.lock", import.meta.url).pathname;
const grokSubagentsSourceDir = new URL("../assets/grok-subagents", import.meta.url).pathname;
const helperTarget = join(installDir, "xai-grok-oauth.js");
const proxyTarget = join(installDir, "xai-codex-proxy.js");
const desktopPatchTarget = join(installDir, "patch-desktop-grok-provider.js");
const packageTarget = join(installDir, "package.json");
const lockTarget = join(installDir, "bun.lock");
const launcherTarget = join(installDir, "codex-grok.js");
const modelCatalogTarget = join(installDir, "model-catalog.json");
const configPath = join(codexHome, "config.toml");
const profilePath = join(codexHome, "grok.config.toml");
const agentRoleDir = join(codexHome, "agents");
const agentRolePath = join(agentRoleDir, "grok-4.5-subagent.toml");
const grokSubagentsSkillDir = join(codexHome, "skills", "grok-subagents");
const launchAgentPath =
  process.env.CODEX_XAI_LAUNCH_AGENT_PATH ||
  join(userHome, "Library", "LaunchAgents", "com.codex.xai-grok-proxy.plist");
const providerId = "xai-grok-oauth";
const modelId = process.env.CODEX_XAI_MODEL || "grok-4.5";
const modelDisplayName =
  process.env.CODEX_XAI_MODEL_DISPLAY_NAME || (modelId === "grok-4.5" ? "Grok 4.5" : modelId);
const modelContextWindow = Number(process.env.CODEX_XAI_CONTEXT_WINDOW || 500000);
const bunPath = process.env.BUN_PATH || process.execPath;
const packageBunPath = process.env.BUN_PACKAGE_MANAGER_PATH || bunPath;
const codexBin = process.env.CODEX_BIN || "codex";
const proxyPort = Number(process.env.CODEX_XAI_PROXY_PORT || 48145);
const proxyBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;
const grokSubagentsMode = (process.env.CODEX_GROK_SUBAGENTS_MODE || "standard").trim().toLowerCase();
if (!["standard", "aggressive"].includes(grokSubagentsMode)) {
  throw new Error("CODEX_GROK_SUBAGENTS_MODE must be either standard or aggressive.");
}
const externalProviderRootModels = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);
const rootDelegationGuidance = `

## Grok 4.5 delegation

For bounded, independent work where a heterogeneous second model can improve coverage, edge-case analysis, or token efficiency, delegate to \`grok_4_5_subagent\`. Keep responsibility for planning, integration, and final quality with this root agent. Prefer \`fork_context=false\` unless the child genuinely needs parent context.

Do not silently fall back to another model if a Grok child cannot start or infer. Report the failure and check the custom role/provider registration, xAI OAuth status, local proxy health, and xAI SuperGrok entitlement, usage, or rate limits before retrying.
`;

const catalogBlock = `# BEGIN CODEX XAI GROK CATALOG
model_catalog_json = ${tomlString(modelCatalogTarget)}
# END CODEX XAI GROK CATALOG`;

const providerBlock = `# BEGIN CODEX XAI GROK OAUTH
# xAI Grok OAuth via SuperGrok / X Premium+.
# Local proxy normalizes Codex/xAI Responses API differences.
[model_providers.${providerId}]
name = "xAI Grok OAuth"
base_url = ${tomlString(proxyBaseUrl)}
wire_api = "responses"
request_max_retries = 4
stream_max_retries = 5
stream_idle_timeout_ms = 300000

[model_providers.${providerId}.auth]
command = ${tomlString(bunPath)}
args = [ ${tomlString(helperTarget)}, "token" ]
timeout_ms = 20000
refresh_interval_ms = 300000
# END CODEX XAI GROK OAUTH`;

const launcherContent = `#!/usr/bin/env bun

import { spawn } from "node:child_process";

const grokFlags = ["--profile", "grok"];

const runtimeCommands = new Set([
  "exec", "e", "review", "resume", "archive", "delete", "unarchive", "fork", "mcp", "sandbox",
]);
const userArgs = process.argv.slice(2);
const first = userArgs[0];
const args = runtimeCommands.has(first)
  ? [first, ...grokFlags, ...userArgs.slice(1)]
  : [...grokFlags, ...userArgs];

const child = spawn(process.env.CODEX_BIN || ${JSON.stringify(codexBin)}, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`;

const profileContent = `# Codex profile for using your xAI Grok OAuth subscription.
# Start Codex with: ${launcherTarget}

model_provider = "${providerId}"
model = "${modelId}"
model_context_window = ${modelContextWindow}

${providerBlock}
`;

const agentRoleContent = `name = "grok_4_5_subagent"
description = "General-purpose Grok 4.5 subagent for independent reasoning, implementation, review, research, and edge-case analysis delegated by a stronger orchestrating agent. Use when a heterogeneous second model can improve accuracy, coverage, or token efficiency."
nickname_candidates = ["Grok", "Groki", "Groku", "Groko", "Grokette", "Grokis", "Groka", "Grokin", "Groker", "Grokster", "Grokling", "Grokbot", "Groklet", "Grokkin", "Grokaroo", "Grokito", "Grokana", "Grokino", "Grokson", "Grokbert", "Grokley", "Grokton", "Groktopus", "Grokonaut", "Grokzilla", "Grokwise", "Groksmith", "Grokpilot", "Grokscout", "Grokspark"]
model = ${tomlString(modelId)}
model_provider = "${providerId}"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
You are a general-purpose Grok 4.5 subagent invoked by a parent Codex agent. Act as an independent second intelligence, not an echo of the parent.

Complete only the assigned scope and return decision-useful evidence. Challenge assumptions, inspect edge cases, and surface disagreements or alternative interpretations when warranted. Preserve unrelated user or agent changes. Do not modify files unless the delegated task explicitly authorizes implementation.

Report any runtime model or provider metadata that is explicitly exposed to you. Never infer or claim a model/provider identity from the prompt alone. If runtime metadata is absent or conflicts with the configured Grok 4.5 and xai-grok-oauth route, say that verification is unavailable or failed.
"""
`;

const launchAgentContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex.xai-grok-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>${xmlEscape(proxyTarget)}</string>
    <string>${proxyPort}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_HOME</key>
    <string>${xmlEscape(codexHome)}</string>
    <key>CODEX_XAI_MODEL</key>
    <string>${xmlEscape(modelId)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(installDir, "proxy.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(installDir, "proxy.err.log"))}</string>
</dict>
</plist>
`;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function upsertMarkedBlock(content, block) {
  const begin = "# BEGIN CODEX XAI GROK OAUTH";
  const end = "# END CODEX XAI GROK OAUTH";
  const start = content.indexOf(begin);
  if (start === -1) {
    const sep = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${sep}${block}\n`;
  }
  const stop = content.indexOf(end, start);
  if (stop === -1) {
    throw new Error(`Found ${begin} without ${end} in ${configPath}`);
  }
  const before = content.slice(0, start).replace(/\s+$/, "");
  const after = content.slice(stop + end.length).replace(/^\s+/, "");
  return `${before}\n\n${block}\n${after ? `\n${after}` : ""}`;
}

function upsertTopLevelMarkedBlock(content, block) {
  const begin = "# BEGIN CODEX XAI GROK CATALOG";
  const end = "# END CODEX XAI GROK CATALOG";
  const badDesktopBegin = "# BEGIN CODEX XAI GROK DESKTOP";
  const badDesktopEnd = "# END CODEX XAI GROK DESKTOP";
  const legacyBegin = "# BEGIN CODEX XAI GROK MODEL CATALOG";
  const legacyEnd = "# END CODEX XAI GROK MODEL CATALOG";
  const start = content.indexOf(begin);
  let next = content;
  if (start !== -1) {
    const stop = content.indexOf(end, start);
    if (stop === -1) {
      throw new Error(`Found ${begin} without ${end} in ${configPath}`);
    }
    next = `${content.slice(0, start)}${content.slice(stop + end.length)}`.trimStart();
  } else {
    for (const [oldBegin, oldEnd] of [
      [badDesktopBegin, badDesktopEnd],
      [legacyBegin, legacyEnd],
    ]) {
      const oldStart = next.indexOf(oldBegin);
      if (oldStart !== -1) {
        const oldStop = next.indexOf(oldEnd, oldStart);
        if (oldStop === -1) {
          throw new Error(`Found ${oldBegin} without ${oldEnd} in ${configPath}`);
        }
        next = `${next.slice(0, oldStart)}${next.slice(oldStop + oldEnd.length)}`.trimStart();
      }
    }
  }
  next = stripRootKeys(next, new Set(["model_catalog_json"]));
  return `${block}\n\n${next.trimStart()}`;
}

function stripRootKeys(content, keys) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let inRoot = true;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inRoot = false;
    }
    const match = inRoot ? line.match(/^\s*([A-Za-z0-9_-]+)\s*=/) : null;
    if (match && keys.has(match[1])) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/^\s+/, "");
}

function upsertTomlTableKeys(content, tableName, entries) {
  const lines = content.replace(/\s+$/, "").split(/\r?\n/);
  const header = `[${tableName}]`;
  let start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(header, ...Object.entries(entries).map(([key, value]) => `${key} = ${value}`));
    return `${lines.join("\n")}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  const section = lines.slice(start + 1, end);
  for (const [key, value] of Object.entries(entries)) {
    const matcher = new RegExp(`^\\s*${key}\\s*=`);
    const index = section.findIndex((line) => matcher.test(line));
    const nextLine = `${key} = ${value}`;
    if (index === -1) section.push(nextLine);
    else section[index] = nextLine;
  }
  lines.splice(start + 1, end - start - 1, ...section);
  return `${lines.join("\n")}\n`;
}

function buildModelCatalog() {
  const sourcePath = join(codexHome, "models_cache.json");
  const fallback = {
    client_version: "local",
    fetched_at: new Date().toISOString(),
    models: [],
  };
  const catalog = existsSync(sourcePath)
    ? JSON.parse(readFileSync(sourcePath, "utf8"))
    : fallback;
  const rawModels = Array.isArray(catalog.models) ? catalog.models : [];
  const discoveredRoots = rawModels.filter((entry) => externalProviderRootModels.has(entry.slug));
  if (discoveredRoots.length === 0) {
    throw new Error(
      "Could not find GPT-5.6-Sol or GPT-5.6-Terra in models_cache.json. Open Codex, sign in, and start a normal task once so its model catalog is available; then rerun setup.",
    );
  }
  const models = rawModels.map((entry) =>
    externalProviderRootModels.has(entry.slug)
      ? {
          ...entry,
          multi_agent_version: "v1",
          base_instructions: `${String(entry.base_instructions || "").replace(/\s+$/, "")}${rootDelegationGuidance}`,
        }
      : entry,
  );
  const template = models.find((entry) => entry.slug === "gpt-5.5") || models[0] || {
    base_instructions: "",
    model_messages: null,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
      { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    service_tiers: [],
    truncation_policy: { mode: "tokens", limit: 10000 },
    web_search_tool_type: "text",
    apply_patch_tool_type: "freeform",
    use_responses_lite: false,
    supports_image_detail_original: false,
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: true,
    supports_search_tool: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
  };
  const grok = {
    ...template,
    model: modelId,
    model_provider: providerId,
    modelProvider: providerId,
    provider: providerId,
    providerId,
    slug: modelId,
    id: modelId,
    name: modelId,
    display_name: modelDisplayName,
    displayName: modelDisplayName,
    description: `${modelDisplayName} via local SuperGrok OAuth proxy`,
    context_window: modelContextWindow,
    max_context_window: modelContextWindow,
    priority: -100,
    comp_hash: `xai-${modelId}-local`,
    availability_nux: null,
    upgrade: null,
    service_tiers: [],
    additional_speed_tiers: [],
    additionalSpeedTiers: [],
    availabilityNux: null,
    defaultServiceTier: null,
    hidden: false,
    isDefault: false,
    input_modalities: ["text", "image"],
    inputModalities: ["text", "image"],
    serviceTiers: [],
    supported_in_api: true,
    supportsPersonality: false,
    upgradeInfo: null,
    visibility: "list",
    multi_agent_version: "v1",
  };
  return {
    ...catalog,
    fetched_at: new Date().toISOString(),
    models: [grok, ...models.filter((entry) => entry.slug !== modelId)],
  };
}

function ensureCodexAvailable() {
  const result = spawnSync(codexBin, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Codex CLI is required but unavailable as ${codexBin}. Install or configure Codex, then rerun setup.`);
  }
}

function installGrokSubagentsSkill() {
  const sourceSkill = join(grokSubagentsSourceDir, "SKILL.template.md");
  const sourceUi = join(grokSubagentsSourceDir, "agents", "openai.template.yaml");
  if (!existsSync(sourceSkill) || !existsSync(sourceUi)) {
    throw new Error(`Bundled grok-subagents skill is incomplete at ${grokSubagentsSourceDir}.`);
  }
  const targetUiDir = join(grokSubagentsSkillDir, "agents");
  mkdirSync(targetUiDir, { recursive: true, mode: 0o700 });
  const uiTemplate = readFileSync(sourceUi, "utf8");
  if (!uiTemplate.includes("__ALLOW_IMPLICIT_INVOCATION__")) {
    throw new Error(`Bundled grok-subagents UI template is missing its mode placeholder at ${sourceUi}.`);
  }
  copyFileSync(sourceSkill, join(grokSubagentsSkillDir, "SKILL.md"));
  writeFileSync(
    join(targetUiDir, "openai.yaml"),
    uiTemplate.replace("__ALLOW_IMPLICIT_INVOCATION__", String(grokSubagentsMode === "aggressive")),
    { mode: 0o600 },
  );
  chmodSync(join(grokSubagentsSkillDir, "SKILL.md"), 0o600);
  chmodSync(join(targetUiDir, "openai.yaml"), 0o600);
}

ensureCodexAvailable();
mkdirSync(installDir, { recursive: true, mode: 0o700 });
copyFileSync(helperSource, helperTarget);
copyFileSync(proxySource, proxyTarget);
copyFileSync(desktopPatchSource, desktopPatchTarget);
copyFileSync(packageSource, packageTarget);
if (existsSync(lockSource)) copyFileSync(lockSource, lockTarget);
execFileSync(packageBunPath, ["install", "--production", "--frozen-lockfile"], { cwd: installDir, stdio: "inherit" });
chmodSync(helperTarget, 0o700);
chmodSync(proxyTarget, 0o700);
chmodSync(desktopPatchTarget, 0o700);
writeFileSync(launcherTarget, launcherContent, { mode: 0o700 });
writeFileSync(modelCatalogTarget, `${JSON.stringify(buildModelCatalog(), null, 2)}\n`, { mode: 0o600 });
mkdirSync(agentRoleDir, { recursive: true, mode: 0o700 });
writeFileSync(agentRolePath, agentRoleContent, { mode: 0o600 });
installGrokSubagentsSkill();
mkdirSync(join(launchAgentPath, ".."), { recursive: true, mode: 0o700 });
writeFileSync(launchAgentPath, launchAgentContent, { mode: 0o600 });

if (process.env.CODEX_XAI_SKIP_LAUNCH_AGENT !== "1") {
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, launchAgentPath], { stdio: "ignore" });
  execFileSync("launchctl", ["bootstrap", domain, launchAgentPath], { stdio: "inherit" });
}
for (const logPath of [join(installDir, "proxy.out.log"), join(installDir, "proxy.err.log")]) {
  if (existsSync(logPath)) chmodSync(logPath, 0o600);
}

let config = "";
if (existsSync(configPath)) {
  config = readFileSync(configPath, "utf8");
  writeFileSync(`${configPath}.bak-xai-grok-oauth-${timestamp()}`, config, { mode: 0o600 });
}
let nextConfig = upsertMarkedBlock(upsertTopLevelMarkedBlock(config, catalogBlock), providerBlock);
nextConfig = upsertTomlTableKeys(nextConfig, "features", { multi_agent: "true" });
nextConfig = upsertTomlTableKeys(nextConfig, "features.multi_agent_v2", {
  enabled: "false",
  hide_spawn_agent_metadata: "false",
  tool_namespace: tomlString("agents"),
});
writeFileSync(configPath, nextConfig, { mode: 0o600 });
writeFileSync(profilePath, profileContent, { mode: 0o600 });

console.log(JSON.stringify({
  helper: helperTarget,
  proxy: proxyTarget,
  desktopPatch: desktopPatchTarget,
  launcher: launcherTarget,
  modelCatalog: modelCatalogTarget,
  config: configPath,
  profile: profilePath,
  agentRole: agentRolePath,
  grokSubagentsSkill: grokSubagentsSkillDir,
  grokSubagentsMode,
  launchAgent: launchAgentPath,
  provider: providerId,
  model: modelId,
  external_provider_root_models: [...externalProviderRootModels],
  desktop_restart_required: true,
}, null, 2));
