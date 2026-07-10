---
name: setup-codex-grok-supergrok
description: Set up, diagnose, update, or remove an unofficial macOS integration that makes a SuperGrok-backed Grok model available in Codex CLI, as a native supported GPT-5.6 root-model delegated subagent, and in the ChatGPT/Codex Desktop model picker. Use when a user asks to connect a SuperGrok or X Premium+ subscription to Codex, delegate from a supported root model to Grok 4.5, add Grok 4.5 to Codex Desktop, fix the ChatGPT-account unsupported-model gate, repair xAI OAuth or the local Responses proxy, reapply the Desktop patch after an app update, or roll the integration back.
---

# Setup Grok in Codex

Connect a user's xAI subscription through device-code OAuth, a loopback Responses proxy, a Codex custom provider, a model catalog entry, and a narrowly scoped Desktop routing patch.

Read [implementation.md](references/implementation.md) before changing a machine. Treat the integration as unofficial and version-sensitive.

## Invariants

- Support macOS only. Stop on other platforms.
- Never set top-level `model_provider = "xai-grok-oauth"` in the user's global `config.toml`. It hijacks normal ChatGPT-backed Desktop behavior.
- Keep the xAI provider under `[model_providers.xai-grok-oauth]`; use `model_provider` only in `grok.config.toml` or as an explicit CLI override.
- Keep the proxy on `127.0.0.1`; do not expose it to the LAN.
- Never display or log access or refresh tokens.
- Pin `gpt-5.6-sol` and `gpt-5.6-terra` to Multi-Agent V1 for external-provider subagents. V2 encrypts inter-agent task text for OpenAI Responses and third-party providers cannot decrypt it.
- Install the standalone role at `${CODEX_HOME:-$HOME/.codex}/agents/grok-4.5-subagent.toml`; do not require the dynamic-subagents skill for native delegation.
- Install the bundled `$grok-subagents` companion skill at `${CODEX_HOME:-$HOME/.codex}/skills/grok-subagents`. Default to standard explicit invocation; honor `CODEX_GROK_SUBAGENTS_MODE=aggressive` only when the user wants eligible bounded Grok delegation to be implicit.
- Keep role nickname candidates unique and limited to ASCII letters, digits, spaces, hyphens, and underscores. Do not use the model punctuation in `Grok 4.5`; an invalid nickname causes Codex to reject the entire custom-agent profile. Use the managed Grok-family pool (`Grok`, `Groki`, `Groku`, and the other bundled candidates) so concurrent workers remain recognizable and unique.
- Use V1 no-context delegation (`fork_context=false`) for fresh bounded workers unless the task explicitly needs parent context.
- Install model-scoped delegation guidance for supported root models: keep the root as orchestrator and quality gate; use Grok for bounded independent work when heterogeneous reasoning improves coverage; fail visibly rather than silently falling back if the Grok route is unavailable.
- Require exactly one known Desktop hook match. Refuse unknown builds.
- Back up `app.asar`, `Info.plist`, the main executable, and `_CodeSignature` before patching.
- Do not patch while the ChatGPT main process or a renderer is active.
- Explain that app updates may replace the patch and that xAI can change subscription entitlements or model IDs.

## Prerequisites

Confirm:

- macOS with `/Applications/ChatGPT.app` or `/Applications/Codex.app`.
- Bun is installed and available as `bun`.
- Codex CLI is available as `codex`, or `CODEX_BIN` is known.
- The user has an active SuperGrok or eligible X Premium+ subscription.
- Codex Desktop and the Codex CLI are installed, the user is signed in, and the model picker has loaded `gpt-5.6-sol` or `gpt-5.6-terra` at least once. A clean, fully installed Codex app is sufficient; no previous Grok configuration is required.
- The user accepts an unofficial integration. Require separate explicit acceptance for the optional app-bundle patch and ad-hoc re-signing.

Default to model ID `grok-4.5`. If the user's xAI account exposes a different ID, set `CODEX_XAI_MODEL` and `CODEX_XAI_MODEL_DISPLAY_NAME` consistently for installation and patching.

## Communication Contract

Before starting, tell the user that the workflow will install a loopback proxy, local OAuth helper, provider/catalog entries, a native Grok role, and V1 routing/guidance for supported root models. Explain when browser authorization or a Codex restart is required. During work, announce each phase without exposing tokens. At completion, report what was installed, what was verified, what remains optional, and the exact next action if the user must restart.

## One-Session Core Install

For a clean but fully installed Codex app, run the bundled orchestrator:

```bash
bun scripts/setup.js
```

It installs the provider, proxy, catalog, native role, standard `$grok-subagents` companion skill, root-model guidance, and V1 configuration; starts device authorization only when no valid local OAuth session exists; verifies OAuth status, proxy health, and CLI routing; then tells the user to restart Codex Desktop. The browser authorization and restart are user-visible pauses, not failures. It intentionally does not patch the Desktop app: direct Grok root-model selection is optional and needs separate explicit approval.

To enable automatic use of the companion skill for eligible bounded work, run the same setup with `CODEX_GROK_SUBAGENTS_MODE=aggressive`. Make this an explicit user choice because it can consume xAI subscription or rate-limit budget more often.

## Manual Install

1. Inspect the current top-level Codex config before writing:

```bash
sed -n '1,/^\[/p' "${CODEX_HOME:-$HOME/.codex}/config.toml"
```

2. Run the bundled installer with Bun:

```bash
bun scripts/install.js
```

The installer creates a timestamped config backup, writes only marked catalog/provider blocks, installs a `grok` CLI profile, installs the `grok_4_5_subagent` role, pins supported root models to Multi-Agent V1, adds root-scoped Grok delegation guidance, disables Multi-Agent V2 for this external-provider path, installs the local proxy LaunchAgent, and never adds a root provider override.

3. Start xAI device authorization:

```bash
bun "${CODEX_HOME:-$HOME/.codex}/xai-grok-oauth/xai-grok-oauth.js" login
```

Show the verification URL and code to the user. Wait for explicit browser authorization. Do not print stored token data.

4. Verify auth and proxy health:

```bash
bun "${CODEX_HOME:-$HOME/.codex}/xai-grok-oauth/xai-grok-oauth.js" status
curl -fsS http://127.0.0.1:48145/health
```

5. Verify CLI routing before touching Desktop:

```bash
codex --profile grok exec --skip-git-repo-check "Reply exactly: GROK_OK"
```

Require `provider: xai-grok-oauth` in runtime metadata and `GROK_OK` in the result. If inference returns 403 after successful OAuth, stop; the xAI subscription is not entitled to this API surface.

## Verify Native Root-to-Grok Delegation

This is the strict success path for using a supported root as the Codex Desktop orchestrator and Grok as a real subagent. It does not use the dynamic-subagents skill and does not launch a nested Codex CLI process.

1. Confirm the installed state:

```bash
jq -c '.models[] | select(.slug == "gpt-5.6-sol" or .slug == "gpt-5.6-terra") | {slug,multi_agent_version}' "${CODEX_HOME:-$HOME/.codex}/xai-grok-oauth/model-catalog.json"
rg -n '^name|^model|^model_provider|^model_reasoning_effort' "${CODEX_HOME:-$HOME/.codex}/agents/grok-4.5-subagent.toml"
```

Require `multi_agent_version: "v1"` for the chosen root model, role `grok_4_5_subagent`, model `grok-4.5`, provider `xai-grok-oauth`, and high reasoning.

2. Fully restart Codex and start a brand-new Desktop task with a supported root (`gpt-5.6-sol` or `gpt-5.6-terra`). Existing tasks retain their original multi-agent protocol and tool schema.

3. Ask the root model to call the standard native `spawn_agent` tool with `agent_type="grok_4_5_subagent"` and `fork_context=false`. Give the child a tool-using task that is large enough to verify real inference, then wait for it.

4. Inspect the persisted parent and child rollout metadata. PASS only when the parent is the selected supported root through OpenAI and the child records all of:

- `agent_role="grok_4_5_subagent"`
- `model="grok-4.5"`
- `model_provider="xai-grok-oauth"`
- reasoning effort `high`
- actual tool calls or another substantive delegated output

The Desktop ASAR provider-routing patch is not required for this root-to-Grok subagent route. It is only required when the user wants to select Grok itself as the root model from the Desktop model picker.

## Patch Desktop

1. Inspect without modifying:

```bash
bun "${CODEX_HOME:-$HOME/.codex}/xai-grok-oauth/patch-desktop-grok-provider.js" inspect
```

Require exactly one `matches` entry and no `patched` entries. If it reports no match, the installed Desktop build has changed; do not broaden the replacement blindly.

2. Ask the user to quit ChatGPT/Codex. Check the actual main process:

```bash
pgrep -fl '/Applications/(ChatGPT|Codex)\.app/Contents/MacOS/'
```

Ignore isolated crash-reporting, GPU, Chrome integration, and task-kernel processes only when no main executable or renderer remains. If the main process persists because of Dock Extra, identify its exact PID and request confirmation before sending `TERM`.

3. Apply the patch:

```bash
bun "${CODEX_HOME:-$HOME/.codex}/xai-grok-oauth/patch-desktop-grok-provider.js" patch
```

The patch changes only new-thread routing for the configured Grok model to `modelProvider: "xai-grok-oauth"`; all other models retain normal ChatGPT/OpenAI routing.

4. Verify the patched hook and signature:

```bash
bun "${CODEX_HOME:-$HOME/.codex}/xai-grok-oauth/patch-desktop-grok-provider.js" inspect
codesign --verify --deep --strict --verbose=2 /Applications/ChatGPT.app
```

Require one `patched` entry and no unpatched match. Reopen Desktop, select Grok in a new task, and verify a real response. Existing tasks do not prove new-thread provider routing.

## Diagnose

- Grok appears but says it is unsupported with a ChatGPT account: the catalog is loaded but Desktop still sent `modelProvider: null`; inspect or reapply the Desktop patch.
- Desktop appears logged out or tasks disappear: remove any global root `model_provider`; keep only the catalog pointer and provider table.
- OAuth succeeds but inference is 403: xAI denied subscription API entitlement; do not loop reauthorization.
- Proxy rejects `namespace` or `external_web_access`: confirm the bundled proxy is running; it strips unsupported Codex-specific fields.
- Grok child fails with 422 and the proxy reports an `agent_message` containing `encrypted_content`: the parent used Multi-Agent V2. Re-run the installer, restart Codex, and use a fresh supported-root task so the V1 catalog pin is loaded.
- The root spawns another OpenAI model instead of Grok: confirm the fresh parent rollout says `multi_agent_version="v1"`, then verify the installed role file and call `agent_type="grok_4_5_subagent"` with `fork_context=false`.
- The role is present but inference fails: inspect the exact error. Check OAuth status and loopback proxy health first; 401/403/429-style errors may indicate expired OAuth, SuperGrok entitlement, or xAI usage/rate limits. Do not silently reroute the work to another model.
- `unknown agent_type 'grok_4_5_subagent'` immediately after editing nicknames: validate every `nickname_candidates` entry. A period such as the one in `Grok 4.5` invalidates the profile; reinstall the managed punctuation-free Grok-family candidates and restart Codex.
- Patcher says the app is running after all windows close: inspect parent PIDs. Dock Extra may keep the main executable alive.
- `Expected exactly one Grok provider hook, found 0`: an app update changed minified code. Stop and audit the new ASAR.
- Grok disappears after an app update: rerun `inspect`; reinstall/reapply only if the known hook still matches exactly once.

## Roll Back

Quit Desktop, then restore the original bundle and Apple signature material:

```bash
bun "${CODEX_HOME:-$HOME/.codex}/xai-grok-oauth/patch-desktop-grok-provider.js" restore
```

To disable the proxy without deleting data:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codex.xai-grok-proxy.plist"
```

Restore the timestamped `config.toml.bak-xai-grok-oauth-*` file only after comparing it with the current config so unrelated user changes are preserved.

## Standalone Prompt

When the recipient cannot install a skill, give them [standalone-prompt.md](references/standalone-prompt.md) together with this skill folder or its `scripts/` directory.
