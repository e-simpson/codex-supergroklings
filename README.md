<p align="center">
    <img src="./images/icon.png" width="300" alt="Logo"/>
    <h3 align="center">SuperGrok 4.5 in Codex</h3>
    <p align="center">
      Grok 4.5 through a SuperGrok subscription (even as a native Codex subagent) alongside Sol and Terra.
      <br>
      <p align="center">
        <img src="https://img.shields.io/badge/platform-macOS-black?logo=apple" alt="macOS" />
        <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
        <a href="https://github.com/e-simpson/codex-supergroklings"><img src="https://img.shields.io/github/stars/e-simpson/codex-supergroklings"></a>
        <br/>
        <a href="https://supergrok.com/"><img src="https://img.shields.io/badge/SuperGrok-Subscription%20Required-orange" alt="SuperGrok Subscription Required"></a>
      </p>
    </p>
</p>

## Install (paste into Codex)

```text
Install the setup-codex-grok-supergrok skill globally, then use it to run the One-Session Core Install:

`bunx skills add e-simpson/codex-supergroklings --skill setup-codex-grok-supergrok --agent codex --global --yes`

Prefer bunx (but npx also works). If you don't have Bun, replace `bunx` with `npx`.

Then use $setup-codex-grok-supergrok to install Grok 4.5 in standard mode. Guide me through browser authorization if needed, run its verification checks, and apply the guarded Desktop patch by default so Grok works as a selectable root model in the Codex app. Tell me when I must fully quit and reopen Codex.

Unless otherwise specified, make Codex choose Grok automatically for eligible bounded work and run the installer with `CODEX_GROK_SUBAGENTS_MODE=aggressive`.
```

## Screenshots

<p align="center">
  <img src="./images/screen1.png" width="220" alt="Codex model picker with Grok 4.5 selected"/>
  <br/>
  <em>Grok 4.5 available as a selectable Codex model</em>
</p>

<p align="center">
  <img src="./images/screen2.png" width="900" alt="Codex Desktop with SuperGrok Grok 4.5 as root model"/>
  <br/>
  <em>Codex Desktop running SuperGrok Grok 4.5 as the root model</em>
</p>

## Manual Installation

```shell
bunx skills add e-simpson/codex-supergroklings --skill setup-codex-grok-supergrok --agent codex --global --yes
```

## Requirements

- macOS, Codex Desktop and CLI, and Bun or Node.js with `npx`.
- An active SuperGrok or eligible X Premium+ subscription.
- A browser for xAI device authorization; no xAI API key is required.

## How

The installer creates local OAuth and provider files under `~/.codex`, a loopback-only adapter on `127.0.0.1:48145`, a Grok role, and a companion skill. It also applies a guarded, backup-first Desktop patch by default because the Codex app otherwise routes the custom model through the ChatGPT-account provider and rejects it. Set `CODEX_XAI_DESKTOP_PATCH=0` only when you want CLI and subagents without direct Grok root selection in Desktop. It does **not** install Codex or Bun or buy a subscription.

Restart Codex after installation, then use a new Sol or Terra task. Standard mode keeps `$grok-subagents` explicit; aggressive mode allows Codex to invoke it when appropriate.

## Why

- Grok 4.5 is very good and efficient
- Sol is very very smart and good at delegating
- **Uses your SuperGrok subscription** instead of wiring an API key into every Codex workflow.

## How it works

1. **Hermes-inspired OAuth.** The device-code flow was studied from [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s open-source xAI OAuth implementation. A Bun helper authorizes in the browser, stores credentials with restricted permissions, refreshes access tokens, and supplies bearer tokens to Codex without logging them.
2. **Local adapter.** A lightweight server bound only to `127.0.0.1:48145` forwards Responses requests to xAI, removes Codex fields xAI does not support, and normalizes incompatible tool output into xAI-compatible input.
3. **Native provider and role.** The installer registers `xai-grok-oauth`, a `grok` CLI profile, a Grok 4.5 model catalog entry, and the high-reasoning `grok_4_5_subagent` role. It deliberately avoids a global `model_provider` override, which can break normal ChatGPT-backed tasks.
4. **Multi-Agent V1 compatibility path.** Sol and Terra delegate to Grok through Codex’s native V1 subagent protocol. V2 encrypts the delegated task for OpenAI’s own provider path, which an external xAI child cannot decrypt; see [Codex issue #31814](https://github.com/openai/codex/issues/31814).

The normal subagent flow does not require modifying the Codex app, but directly selecting Grok as the root model does. The default installer therefore uses a guarded, backup-first patcher that changes only Grok’s new-task provider route and preserves normal OpenAI tasks.

## Desktop patch and app updates

The Desktop integration is unofficial and version-sensitive. It modifies `app.asar`, updates Electron's ASAR integrity hash, and ad-hoc signs the app bundle. That signature change can prevent the in-app updater from replacing the application normally.

Before updating ChatGPT/Codex, fully quit it, run `inspect`, and require `stateMatchesCurrent: true`. Only then restore the vendor bundle:

```shell
bun ~/.codex/xai-grok-oauth/patch-desktop-grok-provider.js restore
```

Reopen the app, install the official update, quit it again, then reapply and verify the guarded patch from the installed skill directory:

```shell
bun "${CODEX_HOME:-$HOME/.codex}/skills/setup-codex-grok-supergrok/scripts/setup.js" --desktop-patch-only
```

The patcher refuses an updated build unless it finds exactly one known routing hook. It also serializes mutations with a lock, binds restore data to the exact app build and ASAR hash, and automatically restores the matching vendor backup if the patched app does not launch. Signature verification alone is not treated as success. Run the resume command exactly once after quitting; do not combine it with a deferred/background patch job. Restoring or updating the app does not remove the OAuth provider, proxy, model catalog, Grok CLI profile, or native Grok subagent role under `~/.codex`.

## Use it (if not in aggressive mode)

Ask Codex: “Use `$grok-subagents` to review this change for bugs, security issues, and missing tests.” The root should fan out only genuinely independent work, reconcile the results, and surface xAI OAuth, entitlement, or rate-limit failures rather than silently switching models.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE). This is an independent, unofficial integration; it is not affiliated with or supported by OpenAI, Codex, ChatGPT, xAI, or Nous Research.
