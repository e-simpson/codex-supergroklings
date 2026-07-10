---
name: grok-subagents
description: Direct a compatible Codex root model to delegate bounded, independent reasoning work to the installed Grok 4.5 native subagent. Use when the user invokes `$grok-subagents`, or when implicit invocation is enabled and bounded Grok delegation improves independent review, debugging hypotheses, security or edge-case analysis, alternative designs, research, or other parallelizable read-heavy work.
---

# Grok Subagents

Use the installed native role `grok_4_5_subagent`, not a direct `model="grok-4.5"` override. The role pins the xAI provider and high reasoning effort.

## Delegate Deliberately

- Keep the root agent as planner, integrator, and final quality gate.
- Delegate one to four genuinely independent, bounded workstreams. Favor code review, evidence gathering, competing approaches, debugging hypotheses, security/edge-case checks, and test-gap analysis.
- Do not delegate trivial work, sequential work whose output immediately blocks the next root action, or duplicate work already owned by the root.
- The installed Grok role is read-only. Have it return evidence and recommendations; make edits and final decisions in the root task.

## Native Spawn Protocol

1. Confirm the fresh parent task uses Multi-Agent V1. If it uses V2, do not spawn Grok; explain that a Codex restart and fresh supported-root task are required.
2. For each bounded workstream, call the standard native spawn tool with `agent_type="grok_4_5_subagent"` and `fork_context=false`. Do not pass model, provider, reasoning-effort, or service-tier overrides.
3. Start all independent children before waiting. Give each a precise scope, expected evidence, and concise return format.
4. Wait for the needed results, reconcile disagreements, verify important claims locally, and return one integrated answer.

## Fail Clearly

- `unknown agent_type`: the role is unavailable; verify the Grok setup, then restart Codex before retrying.
- V2 or an encrypted `agent_message` failure: do not retry through Grok; restart Codex and use a new V1 root task.
- 401, 403, or 429-style inference errors: report the exact error and check xAI OAuth status, loopback proxy health, SuperGrok entitlement, and xAI usage/rate limits. Do not silently fall back to another model.
- Any model/provider mismatch: fail the delegated result closed and tell the user what could not be verified.

## Report

State how many Grok children ran, what each covered, their key evidence or disagreement, and how the root used the results. Surface an unavailable Grok route rather than concealing it.
