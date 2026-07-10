# Standalone Setup Prompt

Paste the prompt below into Codex and attach the `setup-codex-grok-supergrok` folder so Codex can use the bundled scripts.

```text
Set up my active SuperGrok subscription as an unofficial Grok 4.5 provider in Codex CLI and the macOS ChatGPT/Codex Desktop app, including native delegation from a supported GPT-5.6 root model to a standalone Grok 4.5 subagent. Use the attached setup-codex-grok-supergrok skill folder and follow its SKILL.md exactly.

Work end to end: preflight the machine, preserve my existing ChatGPT login and tasks, install the xAI device-code OAuth helper and loopback Responses proxy, add the custom provider and model catalog, install the grok_4_5_subagent role and opt-in $grok-subagents companion skill, pin supported root models to Multi-Agent V1, add root-model delegation guidance, complete browser authorization with me, prove the Grok CLI profile routes through xai-grok-oauth, prove a fresh supported-root Desktop task can natively spawn the Grok role with no inherited context, inspect and safely patch Desktop's per-model new-thread routing only if direct Grok root-model selection is required, verify rollback backups and signing, then test a new Grok task and a normal OpenAI task.

Hard requirements:
- Never set a top-level global model_provider to xai-grok-oauth.
- Never print or log OAuth tokens.
- Bind the proxy only to 127.0.0.1.
- Do not use Multi-Agent V2 for external-provider delegation; its encrypted agent_message payload is not decryptable by xAI.
- Verify persisted child metadata shows agent_role grok_4_5_subagent, model grok-4.5, provider xai-grok-oauth, and high reasoning.
- Back up config and all modified app/signature files.
- Refuse to patch an unknown Desktop build unless exactly one guarded hook matches.
- Ask before terminating a persistent ChatGPT main process.
- Stop and explain if OAuth inference is forbidden by xAI entitlement.
- Tell me that app updates can remove the patch and give me the restore command.

Default to model ID grok-4.5. If my account exposes a different xAI model identifier, show me the evidence and use CODEX_XAI_MODEL consistently rather than silently substituting a model.
```
