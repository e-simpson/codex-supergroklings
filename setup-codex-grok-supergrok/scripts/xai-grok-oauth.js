#!/usr/bin/env bun

import { mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID =
  process.env.XAI_OAUTH_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE =
  process.env.XAI_OAUTH_SCOPE || "openid profile email offline_access grok-cli:access api:access";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const STORE_PATH =
  process.env.CODEX_XAI_OAUTH_STORE ||
  join(CODEX_HOME, "xai-grok-oauth", "auth.json");
const LOCK_PATH = `${STORE_PATH}.lock`;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  xai-grok-oauth.js login      Start xAI Grok OAuth device-code login
  xai-grok-oauth.js token      Print a fresh xAI OAuth access token for Codex
  xai-grok-oauth.js status     Show token store status`);
  process.exit(exitCode);
}

function ensureStoreDir() {
  mkdirSync(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
}

function readStore() {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

function writeStore(data) {
  ensureStoreDir();
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STORE_PATH);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock(fn) {
  ensureStoreDir();
  const deadline = Date.now() + 30_000;
  let fd;
  while (Date.now() < deadline) {
    try {
      fd = openSync(LOCK_PATH, "wx", 0o600);
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      await sleep(250);
    }
  }
  if (fd === undefined) {
    throw new Error(`Timed out waiting for token store lock: ${LOCK_PATH}`);
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(LOCK_PATH);
    } catch {}
  }
}

function validateXaiUrl(value, field) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`${field} must be HTTPS: ${value}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`${field} host must be x.ai or a *.x.ai subdomain: ${value}`);
  }
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${url}, got HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
  }
  if (!response.ok) {
    const detail = payload.error_description || payload.error || text || response.statusText;
    throw new Error(`HTTP ${response.status} from ${url}: ${detail}`);
  }
  return payload;
}

async function discover() {
  const payload = await requestJson(XAI_OAUTH_DISCOVERY_URL);
  const authorizationEndpoint = String(payload.authorization_endpoint || "").trim();
  const tokenEndpoint = String(payload.token_endpoint || "").trim();
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("xAI OIDC discovery response is missing required endpoints.");
  }
  validateXaiUrl(authorizationEndpoint, "authorization_endpoint");
  validateXaiUrl(tokenEndpoint, "token_endpoint");
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  };
}

async function startDeviceCode() {
  const body = new URLSearchParams({
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
  });
  const payload = await requestJson(XAI_OAUTH_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const required = ["device_code", "user_code", "verification_uri", "expires_in", "interval"];
  const missing = required.filter((key) => payload[key] === undefined || payload[key] === null);
  if (missing.length > 0) {
    throw new Error(`xAI device-code response missing fields: ${missing.join(", ")}`);
  }
  return payload;
}

async function pollDeviceToken(tokenEndpoint, deviceCode, expiresIn, interval) {
  validateXaiUrl(tokenEndpoint, "token_endpoint");
  const deadline = Date.now() + Math.max(1, Number(expiresIn || 0)) * 1000;
  let currentInterval = Math.max(1, Number(interval || 5));
  while (Date.now() < deadline) {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: String(deviceCode),
    });
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Token polling returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
    }
    if (response.status === 200) {
      if (!payload.access_token || !payload.refresh_token) {
        throw new Error("xAI token response did not include both access_token and refresh_token.");
      }
      return payload;
    }
    const code = String(payload.error || "");
    if (code === "authorization_pending") {
      await sleep(currentInterval * 1000);
      continue;
    }
    if (code === "slow_down") {
      currentInterval = Math.min(currentInterval + 1, 30);
      await sleep(currentInterval * 1000);
      continue;
    }
    const detail = payload.error_description || payload.error || text || response.statusText;
    throw new Error(`xAI token polling failed with HTTP ${response.status}: ${detail}`);
  }
  throw new Error("Timed out waiting for xAI device authorization.");
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return undefined;
  const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
}

function tokenExpiresSoon(token, skewSeconds = 120) {
  try {
    const payload = decodeJwtPayload(token);
    if (!payload || typeof payload.exp !== "number") return false;
    return payload.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
  } catch {
    return false;
  }
}

async function refreshToken(store) {
  const tokens = store.tokens || {};
  const refreshTokenValue = String(tokens.refresh_token || "").trim();
  if (!refreshTokenValue) {
    throw new Error(`No refresh_token stored. Run: ${process.argv[1]} login`);
  }
  const discovery = store.discovery && store.discovery.token_endpoint ? store.discovery : await discover();
  const tokenEndpoint = validateXaiUrl(String(discovery.token_endpoint || ""), "token_endpoint");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshTokenValue,
  });
  const payload = await requestJson(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!payload.access_token) {
    throw new Error("xAI refresh response did not include access_token.");
  }
  const updated = {
    ...store,
    provider: "xai-oauth",
    base_url: DEFAULT_XAI_BASE_URL,
    discovery,
    tokens: {
      ...tokens,
      access_token: String(payload.access_token || "").trim(),
      refresh_token: String(payload.refresh_token || refreshTokenValue).trim(),
      id_token: String(payload.id_token || tokens.id_token || "").trim(),
      expires_in: payload.expires_in ?? tokens.expires_in,
      token_type: String(payload.token_type || tokens.token_type || "Bearer").trim() || "Bearer",
    },
    last_refresh: new Date().toISOString(),
  };
  writeStore(updated);
  return updated;
}

async function commandLogin() {
  const discovery = await discover();
  const device = await startDeviceCode();
  const verificationUrl = validateXaiUrl(
    String(device.verification_uri_complete || device.verification_uri),
    "verification_uri",
  );
  const userCode = String(device.user_code);
  console.error("");
  console.error("To continue:");
  console.error(`  1. Open: ${verificationUrl}`);
  console.error(`  2. If prompted, enter code: ${userCode}`);
  console.error(`Waiting for approval (polling every ${Math.max(1, Number(device.interval || 5))}s)...`);
  const payload = await pollDeviceToken(
    discovery.token_endpoint,
    device.device_code,
    device.expires_in,
    device.interval,
  );
  const store = {
    provider: "xai-oauth",
    source: "oauth-device-code",
    base_url: DEFAULT_XAI_BASE_URL,
    discovery,
    tokens: {
      access_token: String(payload.access_token || "").trim(),
      refresh_token: String(payload.refresh_token || "").trim(),
      id_token: String(payload.id_token || "").trim(),
      expires_in: payload.expires_in,
      token_type: String(payload.token_type || "Bearer").trim() || "Bearer",
    },
    last_refresh: new Date().toISOString(),
  };
  writeStore(store);
  console.error("");
  console.error(`Login successful. Token store: ${STORE_PATH}`);
}

async function commandToken() {
  await withLock(async () => {
    let store = readStore();
    let accessToken = String(store.tokens?.access_token || "").trim();
    if (!accessToken) {
      throw new Error(`No xAI OAuth access_token stored. Run: ${process.argv[1]} login`);
    }
    if (tokenExpiresSoon(accessToken, 120)) {
      store = await refreshToken(store);
      accessToken = String(store.tokens?.access_token || "").trim();
    }
    if (!accessToken) throw new Error("xAI OAuth access_token is still empty after refresh.");
    process.stdout.write(`${accessToken}\n`);
  });
}

async function commandStatus() {
  const store = readStore();
  const accessToken = String(store.tokens?.access_token || "").trim();
  const refreshToken = String(store.tokens?.refresh_token || "").trim();
  let expiresAt = "unknown";
  try {
    const payload = decodeJwtPayload(accessToken);
    if (typeof payload?.exp === "number") expiresAt = new Date(payload.exp * 1000).toISOString();
  } catch {}
  console.log(JSON.stringify({
    store: STORE_PATH,
    logged_in: Boolean(accessToken && refreshToken),
    expires_at: expiresAt,
    base_url: store.base_url || DEFAULT_XAI_BASE_URL,
    provider: store.provider || "xai-oauth",
  }, null, 2));
}

const command = process.argv[2];
try {
  if (!command || command === "-h" || command === "--help") usage(0);
  if (command === "login") await commandLogin();
  else if (command === "token") await commandToken();
  else if (command === "status") await commandStatus();
  else usage(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
