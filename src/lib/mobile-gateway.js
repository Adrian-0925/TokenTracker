"use strict";

// Mobile gateway: a second, read-only HTTP listener for the companion iPhone
// app. The main dashboard server stays bound to 127.0.0.1 and is untouched;
// this listener binds only to the machine's Tailscale address, requires a
// paired bearer token, and forwards a fixed allowlist of usage endpoints to the
// loopback server. Everything else (settings, auth, local-auth, skills, proxy)
// is unreachable from the phone.

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_GATEWAY_PORT = 7690;
const CONFIG_FILE_NAME = "mobile-gateway.json";
const MAX_PAIRED_DEVICES = 10;
const RECONCILE_INTERVAL_MS = 30_000;
const ON_DEMAND_SYNC_MIN_AGE_MS = 60_000;
const ON_DEMAND_SYNC_TIMEOUT_MS = 5 * 60_000;
const LOOPBACK_TIMEOUT_MS = 30_000;
const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 10;
const SNAPSHOT_PATH = "/api/mobile/snapshot";
const SNAPSHOT_TOP_MODELS = 5;

const PROXIED_ENDPOINTS = new Set([
  "/functions/tokentracker-usage-summary",
  "/functions/tokentracker-usage-daily",
  "/functions/tokentracker-usage-hourly",
  "/functions/tokentracker-usage-monthly",
  "/functions/tokentracker-usage-model-breakdown",
  "/functions/tokentracker-usage-heatmap",
  "/functions/tokentracker-wrapped",
]);

// Query parameters the phone may pass through. Anything else (account=1,
// device_id, include_account_level, refresh, ...) is dropped so a request can
// never reach the cloud-account or offline-snapshot code paths.
const ALLOWED_QUERY_PARAMS = new Set(["from", "to", "tz", "tz_offset_minutes", "weeks", "year", "day"]);

const BACKGROUND_SYNC_BODY = JSON.stringify({
  auto: true,
  background: true,
  allLocalSources: true,
  nativeOnlyWsl: true,
});

// ── Config store ─────────────────────────────────────────────────────────────

function defaultConfig() {
  return { enabled: false, port: DEFAULT_GATEWAY_PORT, devices: [] };
}

function normalizeConfig(raw) {
  const config = defaultConfig();
  if (!raw || typeof raw !== "object") return config;
  config.enabled = raw.enabled === true;
  const port = Number(raw.port);
  if (Number.isInteger(port) && port > 0 && port < 65536) config.port = port;
  if (Array.isArray(raw.devices)) {
    config.devices = raw.devices
      .filter((d) => d && typeof d.id === "string" && /^[a-f0-9]{64}$/.test(String(d.tokenHash || "")))
      .map((d) => ({
        id: d.id,
        name: typeof d.name === "string" ? d.name.slice(0, 64) : "",
        tokenHash: d.tokenHash,
        createdAt: typeof d.createdAt === "string" ? d.createdAt : null,
        lastSeenAt: typeof d.lastSeenAt === "string" ? d.lastSeenAt : null,
      }));
  }
  return config;
}

function createConfigStore(trackerDir) {
  const file = path.join(trackerDir, CONFIG_FILE_NAME);
  return {
    file,
    read() {
      try {
        return normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (_e) {
        return defaultConfig();
      }
    },
    write(config) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(normalizeConfig(config), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

// ── Tokens ───────────────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function parseBearer(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || "").trim());
  return match ? match[1] : "";
}

// Constant-time match of a presented token against the stored hashes. Every
// device is compared even after a hit so timing does not reveal its position.
function findDeviceByToken(devices, token) {
  if (!token) return null;
  const presented = Buffer.from(hashToken(token), "hex");
  let found = null;
  for (const device of devices) {
    const stored = Buffer.from(device.tokenHash, "hex");
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented) && !found) {
      found = device;
    }
  }
  return found;
}

// ── Network ──────────────────────────────────────────────────────────────────

// Tailscale hands out addresses from the CGNAT block 100.64.0.0/10.
function isTailscaleAddress(ip) {
  const parts = String(ip || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// The CGNAT range alone is not proof (carrier NAT uses it too), so the
// interface must also be Tailscale's own adapter.
function findTailscaleAddress(interfaces = os.networkInterfaces()) {
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    if (!/tailscale/i.test(name)) continue;
    for (const addr of addrs || []) {
      const isV4 = addr.family === "IPv4" || addr.family === 4;
      if (isV4 && !addr.internal && isTailscaleAddress(addr.address)) {
        return { address: addr.address, interfaceName: name };
      }
    }
  }
  return null;
}

// ── Time helpers ─────────────────────────────────────────────────────────────

function resolveTimeZone(value) {
  const candidate = String(value || "").trim();
  if (candidate && /^[A-Za-z0-9_+\-/]{1,64}$/.test(candidate)) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate });
      return candidate;
    } catch (_e) {
      // fall through to the machine's zone
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function dayKey(date, timeZone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function lastNDayKeys(now, timeZone, n) {
  const keys = [];
  const seen = new Set();
  // Step back in 12h increments so DST shifts can never skip a calendar day.
  for (let offset = 0; keys.length < n && offset < n * 4; offset++) {
    const key = dayKey(new Date(now.getTime() - offset * 12 * 60 * 60 * 1000), timeZone);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.reverse();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ── Loopback client ──────────────────────────────────────────────────────────

function loopbackRequest(baseUrl, pathWithQuery, { method = "GET", headers = {}, body = null, timeoutMs = LOOPBACK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathWithQuery, baseUrl);
    const req = http.request(
      target,
      { method, headers: { Accept: "application/json", ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_PROXY_BODY_BYTES) {
            req.destroy(new Error("loopback response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({
          status: res.statusCode || 502,
          contentType: res.headers["content-type"] || "application/json",
          body: Buffer.concat(chunks),
        }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("loopback request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function loopbackJson(baseUrl, pathname, params) {
  const query = new URLSearchParams(params).toString();
  const result = await loopbackRequest(baseUrl, query ? `${pathname}?${query}` : pathname);
  if (result.status !== 200) throw new Error(`${pathname} returned ${result.status}`);
  return JSON.parse(result.body.toString("utf8"));
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

function summarizeTopModels(breakdown, limit = SNAPSHOT_TOP_MODELS) {
  const byModel = new Map();
  for (const source of breakdown?.sources || []) {
    for (const model of source?.models || []) {
      const name = String(model?.model || model?.model_id || "unknown");
      const entry = byModel.get(name) || { model: name, total_tokens: 0, cost_usd: 0 };
      entry.total_tokens += toNumber(model?.totals?.total_tokens);
      entry.cost_usd += toNumber(model?.totals?.total_cost_usd);
      byModel.set(name, entry);
    }
  }
  return [...byModel.values()]
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, limit)
    .map((m) => ({ ...m, cost_usd: Number(m.cost_usd.toFixed(6)) }));
}

function summaryTotals(summary) {
  const totals = summary?.totals || {};
  return {
    total_tokens: toNumber(totals.total_tokens),
    cost_usd: Number(toNumber(totals.total_cost_usd).toFixed(6)),
    conversations: toNumber(totals.conversation_count),
  };
}

async function buildSnapshot({ baseUrl, timeZone, now = new Date(), lastSyncAt, machineName }) {
  const today = dayKey(now, timeZone);
  const monthStart = `${today.slice(0, 8)}01`;
  const week = lastNDayKeys(now, timeZone, 7);
  const tz = { tz: timeZone };

  const [todaySummary, monthSummary, lifetimeSummary, breakdown, daily] = await Promise.all([
    loopbackJson(baseUrl, "/functions/tokentracker-usage-summary", { from: today, to: today, ...tz }),
    loopbackJson(baseUrl, "/functions/tokentracker-usage-summary", { from: monthStart, to: today, ...tz }),
    loopbackJson(baseUrl, "/functions/tokentracker-usage-summary", { from: "1970-01-01", to: today, ...tz }),
    loopbackJson(baseUrl, "/functions/tokentracker-usage-model-breakdown", { from: today, to: today, ...tz }),
    loopbackJson(baseUrl, "/functions/tokentracker-usage-daily", { from: week[0], to: today, ...tz }),
  ]);

  const dailyByDay = new Map((daily?.data || []).map((d) => [d.day, d]));
  return {
    generated_at: now.toISOString(),
    last_sync_at: lastSyncAt,
    machine_name: machineName,
    time_zone: timeZone,
    today: summaryTotals(todaySummary),
    this_month: summaryTotals(monthSummary),
    top_models_today: summarizeTopModels(breakdown),
    last_7_days: week.map((day) => ({
      day,
      total_tokens: toNumber(dailyByDay.get(day)?.total_tokens),
      cost_usd: Number(toNumber(dailyByDay.get(day)?.total_cost_usd).toFixed(6)),
    })),
    lifetime_total_tokens: summaryTotals(lifetimeSummary).total_tokens,
  };
}

function etagFor(value) {
  return `"${crypto.createHash("sha1").update(value).digest("hex")}"`;
}

function sanitizeQuery(searchParams) {
  const clean = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (ALLOWED_QUERY_PARAMS.has(key) && value.length <= 64) clean.append(key, value);
  }
  return clean;
}

// ── Gateway ──────────────────────────────────────────────────────────────────

function createMobileGateway({
  trackerDir,
  localBaseUrl,
  env = process.env,
  networkInterfaces = () => os.networkInterfaces(),
  log = (line) => process.stdout.write(`[mobile-gateway] ${line}\n`),
  now = () => new Date(),
} = {}) {
  if (!trackerDir) throw new Error("trackerDir is required");
  const store = createConfigStore(trackerDir);
  const cursorsPath = path.join(trackerDir, "cursors.json");
  // TOKENTRACKER_MOBILE_GATEWAY_HOST pins the bind address (tests / machines
  // without Tailscale); it is never inferred from a request.
  const hostOverride = String(env.TOKENTRACKER_MOBILE_GATEWAY_HOST || "").trim();
  const portOverride = Number(env.TOKENTRACKER_MOBILE_GATEWAY_PORT || 0);

  let server = null;
  let boundHost = null;
  let boundPort = null;
  let status = "disabled";
  let lastError = null;
  let reconcileTimer = null;
  let reconciling = Promise.resolve();
  let syncInFlight = null;
  let lastSyncTriggerAt = 0;
  const lastSeenWrites = new Map();
  const authFailures = new Map();

  function setStatus(next, error = null) {
    if (next !== status || error !== lastError) {
      status = next;
      lastError = error;
      log(error ? `${next}: ${error}` : next);
    }
  }

  function desiredBinding(config) {
    if (!config.enabled) return null;
    const port = Number.isInteger(portOverride) && portOverride > 0 ? portOverride : config.port;
    if (hostOverride) return { host: hostOverride, port };
    const tailscale = findTailscaleAddress(networkInterfaces());
    return tailscale ? { host: tailscale.address, port } : { host: null, port };
  }

  function closeServer() {
    if (!server) return Promise.resolve();
    const closing = server;
    server = null;
    boundHost = null;
    boundPort = null;
    return new Promise((resolve) => {
      closing.close(() => resolve());
      closing.closeAllConnections?.();
    });
  }

  function listen(host, port) {
    return new Promise((resolve, reject) => {
      const next = http.createServer((req, res) => {
        handleRequest(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { code: "internal_error" });
          else res.destroy();
        });
      });
      next.requestTimeout = 60_000;
      next.headersTimeout = 15_000;
      next.once("error", reject);
      next.listen(port, host, () => {
        next.off("error", reject);
        next.on("error", (e) => setStatus("error", e.message));
        resolve(next);
      });
    });
  }

  async function reconcileOnce() {
    const config = store.read();
    const desired = desiredBinding(config);
    if (!desired) {
      await closeServer();
      setStatus("disabled");
      return;
    }
    if (!desired.host) {
      await closeServer();
      setStatus("waiting_for_tailscale");
      return;
    }
    if (server && boundHost === desired.host && boundPort === desired.port) return;
    await closeServer();
    try {
      server = await listen(desired.host, desired.port);
      boundHost = desired.host;
      boundPort = desired.port;
      setStatus("listening");
      log(`listening on http://${boundHost}:${boundPort}`);
    } catch (e) {
      setStatus("error", e?.code || e?.message || String(e));
    }
  }

  function reconcile() {
    reconciling = reconciling.then(reconcileOnce, reconcileOnce);
    return reconciling;
  }

  function lastSyncAt() {
    try {
      return fs.statSync(cursorsPath).mtime.toISOString();
    } catch (_e) {
      return null;
    }
  }

  // Phone activity pulls the 5-minute tray cadence forward: when the data is
  // older than a minute, run the same background sync the tray uses. The
  // shared sync.lock keeps it from overlapping a tray- or hook-fired sync.
  function maybeTriggerSync() {
    if (syncInFlight) return;
    const nowMs = now().getTime();
    if (nowMs - lastSyncTriggerAt < ON_DEMAND_SYNC_MIN_AGE_MS) return;
    const last = Date.parse(lastSyncAt() || "");
    if (Number.isFinite(last) && nowMs - last < ON_DEMAND_SYNC_MIN_AGE_MS) return;
    lastSyncTriggerAt = nowMs;
    syncInFlight = (async () => {
      const auth = await loopbackRequest(localBaseUrl, "/api/local-auth");
      const token = JSON.parse(auth.body.toString("utf8"))?.token;
      if (!token) throw new Error("local auth unavailable");
      const result = await loopbackRequest(localBaseUrl, "/functions/tokentracker-local-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tokentracker-local-auth": token },
        body: BACKGROUND_SYNC_BODY,
        timeoutMs: ON_DEMAND_SYNC_TIMEOUT_MS,
      });
      if (result.status !== 200) throw new Error(`sync returned ${result.status}`);
    })()
      .catch((e) => log(`on-demand sync failed: ${e?.message || e}`))
      .finally(() => {
        syncInFlight = null;
      });
  }

  function isRateLimited(remote) {
    const entry = authFailures.get(remote);
    if (!entry) return false;
    if (now().getTime() - entry.since > AUTH_FAILURE_WINDOW_MS) {
      authFailures.delete(remote);
      return false;
    }
    return entry.count >= AUTH_FAILURE_LIMIT;
  }

  function recordAuthFailure(remote) {
    const nowMs = now().getTime();
    const entry = authFailures.get(remote);
    if (!entry || nowMs - entry.since > AUTH_FAILURE_WINDOW_MS) {
      authFailures.set(remote, { since: nowMs, count: 1 });
    } else {
      entry.count += 1;
    }
  }

  function touchDevice(device) {
    const nowMs = now().getTime();
    if (nowMs - (lastSeenWrites.get(device.id) || 0) < LAST_SEEN_PERSIST_INTERVAL_MS) return;
    lastSeenWrites.set(device.id, nowMs);
    try {
      const config = store.read();
      const stored = config.devices.find((d) => d.id === device.id);
      if (!stored) return;
      stored.lastSeenAt = new Date(nowMs).toISOString();
      store.write(config);
    } catch (_e) {
      // lastSeenAt is informational; never fail a request over it
    }
  }

  async function handleRequest(req, res) {
    const remote = req.socket?.remoteAddress || "unknown";
    if (isRateLimited(remote)) {
      sendJson(res, 429, { code: "too_many_attempts" });
      return;
    }
    const device = findDeviceByToken(store.read().devices, parseBearer(req.headers.authorization));
    if (!device) {
      recordAuthFailure(remote);
      sendJson(res, 401, { code: "unauthorized" });
      return;
    }
    authFailures.delete(remote);
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET") {
      sendJson(res, 405, { code: "method_not_allowed" });
      return;
    }
    touchDevice(device);
    maybeTriggerSync();

    const url = new URL(req.url || "/", "http://gateway.invalid");
    const ifNoneMatch = req.headers["if-none-match"];
    if (url.pathname === SNAPSHOT_PATH) {
      const timeZone = resolveTimeZone(url.searchParams.get("tz"));
      const snapshot = await buildSnapshot({
        baseUrl: localBaseUrl,
        timeZone,
        now: now(),
        lastSyncAt: lastSyncAt(),
        machineName: os.hostname(),
      });
      const { generated_at: _generatedAt, ...stable } = snapshot;
      sendWithEtag(res, 200, "application/json; charset=utf-8", Buffer.from(JSON.stringify(snapshot)),
        etagFor(JSON.stringify(stable)), ifNoneMatch);
      return;
    }
    if (!PROXIED_ENDPOINTS.has(url.pathname)) {
      sendJson(res, 404, { code: "not_found" });
      return;
    }
    const query = sanitizeQuery(url.searchParams).toString();
    const upstream = await loopbackRequest(localBaseUrl, query ? `${url.pathname}?${query}` : url.pathname);
    if (upstream.status !== 200) {
      sendJson(res, 502, { code: "upstream_error", status: upstream.status });
      return;
    }
    sendWithEtag(res, 200, upstream.contentType, upstream.body, etagFor(upstream.body), ifNoneMatch);
  }

  // ── Admin (called from the loopback-only local API) ──

  function describe() {
    const config = store.read();
    return {
      enabled: config.enabled,
      status,
      error: lastError,
      host: boundHost,
      port: boundPort || config.port,
      tailscale: findTailscaleAddress(networkInterfaces()),
      last_sync_at: lastSyncAt(),
      devices: config.devices.map(({ tokenHash: _hash, ...rest }) => rest),
    };
  }

  async function setEnabled(enabled) {
    const config = store.read();
    config.enabled = enabled === true;
    store.write(config);
    await reconcile();
    return describe();
  }

  function pair(name) {
    if (status !== "listening" || !boundHost) {
      const error = new Error("The mobile gateway is not listening.");
      error.code = status === "waiting_for_tailscale" ? "tailscale_not_found" : "gateway_not_listening";
      throw error;
    }
    const config = store.read();
    if (config.devices.length >= MAX_PAIRED_DEVICES) {
      const error = new Error("Too many paired devices.");
      error.code = "too_many_devices";
      throw error;
    }
    const token = generateToken();
    const device = {
      id: crypto.randomUUID(),
      name: String(name || "iPhone").trim().slice(0, 64) || "iPhone",
      tokenHash: hashToken(token),
      createdAt: now().toISOString(),
      lastSeenAt: null,
    };
    config.devices.push(device);
    store.write(config);
    const pairing = { v: 1, host: boundHost, port: boundPort, token, name: os.hostname() };
    const { tokenHash: _hash, ...publicDevice } = device;
    return { device: publicDevice, pairing, pairing_uri: JSON.stringify(pairing) };
  }

  function revoke(deviceId) {
    const config = store.read();
    const before = config.devices.length;
    config.devices = deviceId === "*" ? [] : config.devices.filter((d) => d.id !== deviceId);
    store.write(config);
    return before !== config.devices.length;
  }

  return {
    start() {
      void reconcile();
      reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
      reconcileTimer.unref?.();
    },
    async stop() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      await reconciling.catch(() => {});
      await closeServer();
    },
    reconcile,
    describe,
    setEnabled,
    pair,
    revoke,
    // exposed for tests
    get address() {
      return server ? server.address() : null;
    },
    get syncInFlight() {
      return syncInFlight;
    },
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function sendWithEtag(res, status, contentType, body, etag, ifNoneMatch) {
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": contentType, ETag: etag, "Cache-Control": "no-cache" });
  res.end(body);
}

// ── Process-wide instance for the loopback admin API ─────────────────────────

let activeGateway = null;

function setActiveMobileGateway(gateway) {
  activeGateway = gateway;
}

// Admin routes live on the loopback server and are gated by local-auth there.
//   GET  /api/mobile-gateway                         → status + paired devices
//   POST /api/mobile-gateway {action:"enable"}       → start listening
//   POST /api/mobile-gateway {action:"disable"}      → stop listening
//   POST /api/mobile-gateway {action:"pair", name}   → new token (shown once)
//   POST /api/mobile-gateway {action:"revoke", device_id} ("*" revokes all)
async function handleMobileGatewayAdmin(req, res, readJsonBody, gateway = activeGateway) {
  if (!gateway) {
    sendJson(res, 503, { code: "gateway_unavailable" });
    return;
  }
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET") {
    sendJson(res, 200, gateway.describe());
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, { code: "method_not_allowed" });
    return;
  }
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (_e) {
    sendJson(res, 400, { code: "invalid_body" });
    return;
  }
  try {
    switch (body?.action) {
      case "enable":
        sendJson(res, 200, await gateway.setEnabled(true));
        return;
      case "disable":
        sendJson(res, 200, await gateway.setEnabled(false));
        return;
      case "pair":
        sendJson(res, 200, gateway.pair(body.name));
        return;
      case "revoke":
        sendJson(res, 200, { revoked: gateway.revoke(String(body.device_id || "")), ...gateway.describe() });
        return;
      default:
        sendJson(res, 400, { code: "unknown_action" });
    }
  } catch (e) {
    sendJson(res, 409, { code: e?.code || "gateway_error", error: e?.message || String(e) });
  }
}

module.exports = {
  createMobileGateway,
  setActiveMobileGateway,
  handleMobileGatewayAdmin,
  findTailscaleAddress,
  isTailscaleAddress,
  findDeviceByToken,
  hashToken,
  sanitizeQuery,
  summarizeTopModels,
  lastNDayKeys,
  resolveTimeZone,
  DEFAULT_GATEWAY_PORT,
  PROXIED_ENDPOINTS,
  SNAPSHOT_PATH,
};
