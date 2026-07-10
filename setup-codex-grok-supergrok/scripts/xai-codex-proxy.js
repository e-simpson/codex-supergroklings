#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.CODEX_XAI_PROXY_PORT || process.argv[2] || 48145);
const HOST = "127.0.0.1";
const XAI_BASE = "https://api.x.ai/v1";
const PREFERRED_MODEL = process.env.CODEX_XAI_MODEL || "grok-4.5";
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const LOG_DIR = process.env.CODEX_XAI_PROXY_LOG_DIR || join(CODEX_HOME, "xai-grok-oauth", "proxy-logs");
const DEBUG = process.env.CODEX_XAI_PROXY_DEBUG === "1";
let modelTemplate;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = key.toLowerCase() === "authorization" ? "Bearer ***" : value;
  }
  return out;
}

function logJson(name, payload) {
  if (!DEBUG) return;
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const safe = JSON.stringify(payload, null, 2).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer ***");
  writeFileSync(join(LOG_DIR, `${Date.now()}-${name}.json`), `${safe}\n`, { mode: 0o600 });
}

function codexModelFromXai(model) {
  const id = String(model.id || "");
  const template = getModelTemplate();
  const contextWindow = Number(model.context_length || template.context_window || 0) || undefined;
  return {
    ...template,
    slug: id,
    id,
    name: id,
    display_name: id,
    description: "xAI Grok via SuperGrok OAuth",
    context_window: contextWindow,
    max_context_window: contextWindow,
    priority: id === PREFERRED_MODEL ? -10 : Number(template.priority || 0),
    aliases: Array.isArray(model.aliases) ? model.aliases : [],
  };
}

function getModelTemplate() {
  if (modelTemplate) return modelTemplate;
  const fallback = {
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
    input_modalities: ["text"],
  };
  try {
    const cachePath = join(CODEX_HOME, "models_cache.json");
    if (existsSync(cachePath)) {
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      const models = Array.isArray(cache.models) ? cache.models : [];
      modelTemplate = models.find((entry) => entry.slug === "gpt-5.5") || models[0] || fallback;
      return modelTemplate;
    }
  } catch {}
  modelTemplate = fallback;
  return modelTemplate;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeTool(tool) {
  if (!isPlainObject(tool)) return undefined;
  const allowed = new Set([
    "function",
    "web_search",
    "x_search",
    "collections_search",
    "file_search",
    "code_execution",
    "code_interpreter",
    "mcp",
    "shell",
  ]);
  if (!allowed.has(String(tool.type || ""))) return undefined;
  const clean = { ...tool };
  delete clean.external_web_access;
  return clean;
}

function sanitizeInputItem(item) {
  if (!isPlainObject(item)) return item;

  // Codex emits shell tool results as OpenAI-specific input items. xAI currently
  // accepts tool type "shell" but is stricter about continuation input. Keep the
  // semantic content by converting unsupported tool result objects to text.
  const type = String(item.type || "");
  if (type === "reasoning" || type === "function_call") {
    return undefined;
  }
  if (
    type.includes("tool") ||
    type.includes("shell") ||
    type.includes("function_call_output") ||
    type.includes("call_output")
  ) {
    const output = item.output ?? item.content ?? item.result ?? item.text ?? "";
    if (typeof output === "string") {
      return {
        role: "user",
        content: [{ type: "input_text", text: `Tool result (${type || "unknown"}):\n${output}` }],
      };
    }
  }

  const clone = { ...item };
  if (Array.isArray(clone.content)) clone.content = clone.content.map(sanitizeInputItem);
  return clone;
}

function sanitizeResponsesBody(body) {
  const clean = { ...body };
  delete clean.external_web_access;

  if (Array.isArray(clean.tools)) {
    clean.tools = clean.tools.map(sanitizeTool).filter(Boolean);
    if (clean.tools.length === 0) delete clean.tools;
  }

  if (Array.isArray(clean.input)) {
    clean.input = clean.input.map(sanitizeInputItem).filter((item) => item !== undefined);
  }

  return clean;
}

function summarizeInputItem(item) {
  if (!isPlainObject(item)) return { value_type: Array.isArray(item) ? "array" : typeof item };
  return {
    keys: Object.keys(item).sort(),
    type: item.type ?? null,
    role: item.role ?? null,
    content:
      Array.isArray(item.content)
        ? item.content.map((part) =>
            isPlainObject(part)
              ? { keys: Object.keys(part).sort(), type: part.type ?? null }
              : { value_type: Array.isArray(part) ? "array" : typeof part },
          )
        : { value_type: Array.isArray(item.content) ? "array" : typeof item.content },
  };
}

async function forward(request, targetUrl, body) {
  const headers = new Headers(request.headers);
  headers.set("host", "api.x.ai");
  headers.delete("content-length");
  return fetch(targetUrl, {
    method: request.method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  });
}

async function handleModels(request) {
  const response = await forward(request, `${XAI_BASE}/models`);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return new Response(text, { status: response.status, headers: response.headers });
  }
  if (!response.ok) return json(payload, response.status);

  const data = Array.isArray(payload.data) ? payload.data : [];
  const models = data.map(codexModelFromXai);
  logJson("models", { raw: payload, codex: { models } });
  return json({ models, data, object: payload.object || "list" });
}

async function handleResponses(request) {
  const rawText = await request.text();
  let body;
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    return json({ error: "Invalid JSON request body" }, 400);
  }
  logJson("responses-in", { headers: redactHeaders(request.headers), body });
  const clean = sanitizeResponsesBody(body);
  logJson("responses-out", clean);

  const response = await fetch(`${XAI_BASE}/responses`, {
    method: "POST",
    headers: {
      authorization: request.headers.get("authorization") || "",
      "content-type": "application/json",
      accept: request.headers.get("accept") || "text/event-stream",
    },
    body: JSON.stringify(clean),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(
      "xAI Responses rejected normalized request",
      JSON.stringify({
        status: response.status,
        error: text.slice(0, 2000),
        body_keys: Object.keys(clean).sort(),
        input_type: Array.isArray(clean.input) ? "array" : typeof clean.input,
        input: Array.isArray(clean.input) ? clean.input.map(summarizeInputItem) : undefined,
        tool_types: Array.isArray(clean.tools) ? clean.tools.map((tool) => tool?.type ?? null) : [],
      }),
    );
    logJson("responses-error", { status: response.status, text, clean });
    return new Response(text, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
      },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/v1/models" || url.pathname === "/models") return handleModels(request);
    if (url.pathname === "/v1/responses" || url.pathname === "/responses") return handleResponses(request);

    const targetPath = url.pathname.startsWith("/v1/") ? url.pathname.slice(3) : url.pathname;
    return forward(request, `${XAI_BASE}${targetPath}${url.search}`, request.body);
  },
});

console.error(`xAI Codex proxy listening on http://${server.hostname}:${server.port}/v1`);
