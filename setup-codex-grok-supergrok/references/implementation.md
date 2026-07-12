# Implementation Reference

## Contents

- Scope and status
- Architecture
- Why the Desktop patch is required
- File layout
- Security properties
- Operational footprint
- Fresh-machine sequence
- Update and recovery behavior
- Sources and attribution

## Scope and status

This integration was proven on macOS with the ChatGPT/Codex Desktop bundle at `/Applications/ChatGPT.app`, Codex custom-provider support, an active xAI OAuth subscription, and model ID `grok-4.5`. Native Desktop delegation was proven with a `gpt-5.6-sol` root spawning the standalone `grok_4_5_subagent` role through Multi-Agent V1; the installer now applies the same V1 route to `gpt-5.6-terra`, which must be verified on the target build before claiming Terra success. Persisted child metadata must record `model=grok-4.5`, `model_provider=xai-grok-oauth`, high reasoning, and substantive output.

It is not an OpenAI-supported or xAI-supported Codex integration. OpenAI supports custom model providers, command-backed bearer authentication, profiles, and custom model catalogs. xAI officially supports subscription OAuth in Hermes Agent. The per-model Desktop routing change is an unsupported local patch to the app's ASAR bundle.

Current xAI/Hermes documentation may advertise a different Grok model ID. Treat `grok-4.5` as a configurable target, not a permanent public alias. A successful OAuth login does not guarantee inference entitlement; xAI may return 403 based on subscription tier.

## Architecture

The setup has six layers:

1. `xai-grok-oauth.js` performs OIDC discovery and OAuth 2.0 device-code login against xAI. It stores access and refresh tokens with mode `0600`, refreshes shortly before expiration, and prints only a fresh access token when Codex invokes the auth command.
2. `xai-codex-proxy.js` binds to `127.0.0.1:48145` and forwards Responses requests to `https://api.x.ai/v1`. It removes Codex/OpenAI-specific request fields and tools that xAI rejects while preserving normal streaming responses.
3. `install.js` registers `[model_providers.xai-grok-oauth]`, command-backed auth, a custom model catalog, a `grok` CLI profile, and a macOS LaunchAgent for the loopback proxy.
4. The model catalog makes Grok visible in Codex's model list. Visibility alone does not determine the provider used by Desktop.
5. `patch-desktop-grok-provider.js` changes the new-thread parameter builder so only the configured Grok model gets `modelProvider: "xai-grok-oauth"`. Other models keep `modelProvider: null` and therefore preserve normal ChatGPT account behavior.
6. `~/.codex/agents/grok-4.5-subagent.toml` pins the native agent role `grok_4_5_subagent` to Grok through the xAI provider. The managed catalog pins both `gpt-5.6-sol` and `gpt-5.6-terra` to Multi-Agent V1, and appends narrowly scoped delegation guidance to those roots, so delegated task text remains compatible with external providers.

The role uses a 30-name, punctuation-free Grok-family nickname pool (`Grok`, `Groki`, `Groku`, `Groko`, `Grokette`, `Grokis`, and other bundled candidates). Codex requires candidates to be unique and composed only of ASCII letters, digits, spaces, hyphens, and underscores; using the display-model spelling `Grok 4.5` invalidates the whole role because of the period. Multiple concurrent agents also require unique active nicknames, so the installer supplies distinct names rather than a single repeated candidate.

## Why root-to-Grok delegation uses V1

Multi-Agent V2 marks `spawn_agent.message` as encrypted. OpenAI Responses encrypts the parent tool argument and decrypts the resulting `agent_message.encrypted_content` internally for an OpenAI recipient. Codex and the loopback proxy receive ciphertext, not a reusable plaintext task. xAI does not implement that OpenAI-internal encrypted message contract, so an xAI child either rejects the `agent_message` request shape with 422 or receives no usable delegated task.

Multi-Agent V1 sends a normal task payload and preserves native custom-agent selection through `agent_type`. The working invariant is:

```text
Root parent: model=gpt-5.6-sol or gpt-5.6-terra, provider=openai, multi_agent_version=v1
spawn: agent_type=grok_4_5_subagent, fork_context=false
Grok child: model=grok-4.5, provider=xai-grok-oauth, effort=high
```

Setting `features.multi_agent_v2.enabled=true` does not solve the provider boundary. It activates the encrypted path. `hide_spawn_agent_metadata=false` and `tool_namespace="agents"` restore routing fields under V2 but do not make the ciphertext decryptable by xAI.

## Why the Desktop patch is required

Codex CLI honors `model_provider` in the `grok` profile. Desktop's model picker loads the custom catalog entry but, on the tested build, ignores provider hints embedded in that catalog. Selecting Grok therefore still starts the task with the built-in OpenAI provider and produces:

```text
The 'grok-4.5' model is not supported when using Codex with a ChatGPT account.
```

A global root override appears to solve routing but changes the provider for the entire Desktop app. That can break ChatGPT login state and make normal tasks appear missing. The correct invariant is:

```text
global config: catalog pointer + provider definition, no root model_provider
grok CLI profile: model_provider = "xai-grok-oauth"
Desktop new Grok task: modelProvider = "xai-grok-oauth"
all other Desktop tasks: modelProvider = null
```

## File layout

The installer writes under `${CODEX_HOME:-$HOME/.codex}`:

```text
xai-grok-oauth/
  auth.json
  xai-grok-oauth.js
  xai-codex-proxy.js
  patch-desktop-grok-provider.js
  model-catalog.json
  codex-grok.js
  package.json
  bun.lock
  node_modules/
  desktop-patch/
grok.config.toml
config.toml
agents/
  grok-4.5-subagent.toml
```

It also writes `~/Library/LaunchAgents/com.codex.xai-grok-proxy.plist`.

## Security properties

- OAuth endpoints discovered at runtime must use HTTPS and resolve to `x.ai` or an `x.ai` subdomain.
- The token file and temporary writes use owner-only permissions.
- The token refresh lock prevents concurrent refresh-token races.
- The proxy listens only on loopback.
- Debug request logging is off by default and redacts bearer headers when enabled.
- The ASAR patch refuses zero or multiple matches.
- Rollback material is saved before any bundle mutation.
- The app is ad-hoc signed after its ASAR integrity hash is updated. This replaces the original top-level Apple signature; rollback restores the original executable, plist, ASAR, and signature directory.

Risks remain: the OAuth client is derived from Hermes' public implementation, provider behavior and entitlements can change, the local proxy processes prompts and tool results, and an app update can overwrite or invalidate the Desktop patch.

## Operational footprint

macOS may show a background item attributed to "Jarred Sumner." That is the signing identity associated with the Bun runtime used by the LaunchAgent, not a second AI service. The proxy performs lightweight JSON normalization and network forwarding; model inference still runs at xAI.

On the original working machine, the idle proxy measured approximately 0.0% CPU and 34 MB resident memory. Treat that as an observed example rather than a guaranteed ceiling. `Dock Extra (ChatGPT.app)`, ChatGPT for Chrome, crashpad handlers, GPU services, and Codex renderer processes belong to the ChatGPT/Codex app, not this proxy.

## Fresh-machine sequence

1. Inspect OS, app location, Bun, Codex CLI, and existing global config.
2. Run `bun scripts/install.js` from this skill directory.
3. Run the installed OAuth helper with `login`; let the user approve in their browser.
4. Confirm `status`, proxy `/health`, and a CLI Grok response through `--profile grok`.
5. Restart Desktop and verify a fresh Sol or Terra task can spawn `grok_4_5_subagent` with V1 no-context delegation. Confirm persisted parent/child metadata and substantive child tool use.
6. Inspect the Desktop ASAR and require exactly one known routing hook only when direct Grok root-model selection is required.
7. Quit Desktop. If Dock Extra keeps the app alive, identify the exact main PID before requesting permission to terminate it.
8. Apply the patch, inspect again, and verify code signing.
9. Reopen Desktop and test a new Grok root task plus a new normal OpenAI task.

## Update and recovery behavior

Desktop updates normally replace `app.asar`, so model-picker visibility may remain while provider routing disappears. Codex updates can also refresh `models_cache.json`, so rerun the installer to regenerate the managed catalog and restore the Sol/Terra V1 pins, their delegation guidance, and the standalone agent role. Re-run `inspect` after every Desktop update when direct Grok root selection is used. Reapply only when the original hook matches exactly once. If the hook changed, extract the new ASAR, trace the new-thread request builder, and update the patch with a new exact guard.

If the app fails to launch, restore immediately with the patcher's `restore` command. If restore cannot run, reinstalling the official app restores the vendor bundle but does not remove the local provider, proxy, OAuth store, or model catalog from `CODEX_HOME`.

## Sources and attribution

- OpenAI Codex advanced configuration, including custom providers, command-backed auth, profiles, `CODEX_HOME`, and `model_catalog_json`: https://developers.openai.com/codex/config-advanced
- xAI's announcement of subscription-backed Grok in Hermes: https://x.ai/news/grok-hermes
- Hermes Agent xAI OAuth guide and current entitlement warning: https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth
- Hermes Agent source repository, used to understand the public xAI OAuth device flow: https://github.com/NousResearch/hermes-agent
- Electron ASAR tooling: https://github.com/electron/asar
- Electron process model, used to distinguish main/renderer processes from crash and GPU helpers: https://www.electronjs.org/docs/latest/tutorial/process-model

Review upstream licenses and provider terms before redistributing the scripts. Do not describe this as an official OpenAI integration.
