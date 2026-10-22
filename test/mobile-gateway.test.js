const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createMobileGateway,
  handleMobileGatewayAdmin,
  findTailscaleAddress,
  isTailscaleAddress,
  sanitizeQuery,
  summarizeTopModels,
  lastNDayKeys,
  resolveTimeZone,
} = require("../src/lib/mobile-gateway");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Stand-in for the loopback dashboard server: records every request and
// answers the usage endpoints the gateway forwards to.
async function startFakeLocalServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      const send = (payload, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      switch (url.pathname) {
        case "/api/local-auth":
          return send({ token: "local-secret" });
        case "/functions/tokentracker-local-sync":
          return send({ ok: req.headers["x-tokentracker-local-auth"] === "local-secret" },
            req.headers["x-tokentracker-local-auth"] === "local-secret" ? 200 : 401);
        case "/functions/tokentracker-usage-summary":
          return send({ totals: { total_tokens: 1000, total_cost_usd: 1.5, conversation_count: 3 } });
        case "/functions/tokentracker-usage-model-breakdown":
          return send({ sources: [
            { source: "claude", models: [{ model: "claude-x", totals: { total_tokens: 700, total_cost_usd: "1.0" } }] },
            { source: "codex", models: [{ model: "gpt-y", totals: { total_tokens: 300, total_cost_usd: "0.5" } }] },
          ] });
        case "/functions/tokentracker-usage-daily":
          return send({ data: [{ day: url.searchParams.get("to"), total_tokens: 1000, total_cost_usd: 1.5 }] });
        case "/functions/tokentracker-usage-heatmap":
          return send({ weeks: url.searchParams.get("weeks") });
        default:
          return send({ code: "not_found" }, 404);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function request(port, pathname, { token, method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function setup(t, { cursorsAgeMs = 0 } = {}) {
  const trackerDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-mobile-gw-"));
  const cursors = path.join(trackerDir, "cursors.json");
  fs.writeFileSync(cursors, "{}");
  const stamp = new Date(Date.now() - cursorsAgeMs);
  fs.utimesSync(cursors, stamp, stamp);
  const local = await startFakeLocalServer();
  const port = await freePort();
  const gateway = createMobileGateway({
    trackerDir,
    localBaseUrl: local.baseUrl,
    env: { TOKENTRACKER_MOBILE_GATEWAY_HOST: "127.0.0.1", TOKENTRACKER_MOBILE_GATEWAY_PORT: String(port) },
    log: () => {},
  });
  t.after(async () => {
    await gateway.stop();
    await new Promise((resolve) => local.server.close(resolve));
    fs.rmSync(trackerDir, { recursive: true, force: true });
  });
  return { trackerDir, local, port, gateway };
}

test("only Tailscale's own adapter in 100.64.0.0/10 counts as a Tailscale address", () => {
  assert.equal(isTailscaleAddress("100.64.0.1"), true);
  assert.equal(isTailscaleAddress("100.127.255.254"), true);
  assert.equal(isTailscaleAddress("100.128.0.1"), false);
  assert.equal(isTailscaleAddress("192.168.1.2"), false);

  const ifaces = {
    "Ethernet": [{ family: "IPv4", address: "100.70.0.9", internal: false }],
    "Tailscale": [
      { family: "IPv6", address: "fd7a:115c:a1e0::1", internal: false },
      { family: "IPv4", address: "100.101.102.103", internal: false },
    ],
  };
  assert.deepEqual(findTailscaleAddress(ifaces), { address: "100.101.102.103", interfaceName: "Tailscale" });
  assert.equal(findTailscaleAddress({ "Ethernet": ifaces.Ethernet }), null);
});

test("query sanitizer drops account, device and refresh parameters", () => {
  const clean = sanitizeQuery(new URLSearchParams("from=2026-01-01&account=1&device_id=local:x&tz=Asia/Shanghai&refresh=1"));
  assert.equal(clean.toString(), "from=2026-01-01&tz=Asia%2FShanghai");
});

test("top models are merged across sources and sorted by tokens", () => {
  const top = summarizeTopModels({ sources: [
    { models: [{ model: "a", totals: { total_tokens: 5, total_cost_usd: "1" } }] },
    { models: [{ model: "b", totals: { total_tokens: 9, total_cost_usd: 2 } }, { model: "a", totals: { total_tokens: 6 } }] },
  ] });
  assert.deepEqual(top.map((m) => [m.model, m.total_tokens]), [["a", 11], ["b", 9]]);
});

test("lastNDayKeys returns consecutive calendar days ending today", () => {
  const keys = lastNDayKeys(new Date("2026-03-09T12:00:00Z"), "America/Chicago", 7);
  assert.deepEqual(keys, ["2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]);
  assert.equal(resolveTimeZone("Not/AZone"), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  assert.equal(resolveTimeZone("Asia/Shanghai"), "Asia/Shanghai");
});

test("gateway stays closed until enabled and refuses to pair while closed", async (t) => {
  const { gateway, port } = await setup(t);
  await gateway.reconcile();
  assert.equal(gateway.describe().status, "disabled");
  assert.equal(gateway.address, null);
  assert.throws(() => gateway.pair("phone"), { code: "gateway_not_listening" });
  await assert.rejects(request(port, "/api/mobile/snapshot"));
});

test("paired token unlocks the snapshot and allowlisted endpoints only", async (t) => {
  const { gateway, port, local, trackerDir } = await setup(t);
  await gateway.setEnabled(true);
  assert.equal(gateway.describe().status, "listening");

  const { pairing, device } = gateway.pair("My iPhone");
  assert.equal(pairing.port, port);
  assert.equal(pairing.host, "127.0.0.1");
  assert.equal(device.tokenHash, undefined);
  const stored = JSON.parse(fs.readFileSync(path.join(trackerDir, "mobile-gateway.json"), "utf8"));
  assert.equal(JSON.stringify(stored).includes(pairing.token), false, "plain token must never be persisted");

  assert.equal((await request(port, "/api/mobile/snapshot")).status, 401);
  assert.equal((await request(port, "/api/mobile/snapshot", { token: "wrong" })).status, 401);

  const snap = await request(port, "/api/mobile/snapshot?tz=Asia/Shanghai", { token: pairing.token });
  assert.equal(snap.status, 200);
  const body = JSON.parse(snap.body);
  assert.equal(body.time_zone, "Asia/Shanghai");
  assert.equal(body.today.total_tokens, 1000);
  assert.equal(body.today.conversations, 3);
  assert.equal(body.last_7_days.length, 7);
  assert.equal(body.last_7_days[6].total_tokens, 1000);
  assert.deepEqual(body.top_models_today.map((m) => m.model), ["claude-x", "gpt-y"]);
  assert.ok(snap.headers.etag);

  const again = await request(port, "/api/mobile/snapshot?tz=Asia/Shanghai", {
    token: pairing.token,
    headers: { "If-None-Match": snap.headers.etag },
  });
  assert.equal(again.status, 304);

  const heatmap = await request(port, "/functions/tokentracker-usage-heatmap?weeks=52&account=1&device_id=x", { token: pairing.token });
  assert.equal(heatmap.status, 200);
  const forwarded = local.calls.find((c) => c.path === "/functions/tokentracker-usage-heatmap");
  assert.equal(forwarded.query.toString(), "weeks=52");
  assert.equal(forwarded.headers.authorization, undefined, "phone token must not reach the local API");

  for (const blocked of ["/api/local-auth", "/functions/tokentracker-local-sync", "/api/mobile-gateway", "/functions/tokentracker-skills", "/"]) {
    assert.equal((await request(port, blocked, { token: pairing.token })).status, 404, blocked);
  }
  assert.equal((await request(port, "/api/mobile/snapshot", { token: pairing.token, method: "POST" })).status, 405);

  assert.equal(gateway.revoke(device.id), true);
  assert.equal((await request(port, "/api/mobile/snapshot", { token: pairing.token })).status, 401);
});

test("stale data triggers one on-demand sync through local-auth; fresh data does not", async (t) => {
  const stale = await setup(t, { cursorsAgeMs: 10 * 60_000 });
  await stale.gateway.setEnabled(true);
  const { pairing } = stale.gateway.pair("phone");
  await request(stale.port, "/api/mobile/snapshot", { token: pairing.token });
  await stale.gateway.syncInFlight;
  await request(stale.port, "/api/mobile/snapshot", { token: pairing.token });
  const syncCalls = stale.local.calls.filter((c) => c.path === "/functions/tokentracker-local-sync");
  assert.equal(syncCalls.length, 1, "throttled to one sync per minute");
  assert.equal(syncCalls[0].method, "POST");
  assert.equal(syncCalls[0].headers["x-tokentracker-local-auth"], "local-secret");
  const syncBody = JSON.parse(syncCalls[0].body);
  assert.equal(syncBody.background, true);
  assert.equal(syncBody.publishAccount, undefined, "phone-triggered sync never uploads to the cloud");

  const fresh = await setup(t, { cursorsAgeMs: 0 });
  await fresh.gateway.setEnabled(true);
  const freshPair = fresh.gateway.pair("phone");
  await request(fresh.port, "/api/mobile/snapshot", { token: freshPair.pairing.token });
  assert.equal(fresh.local.calls.some((c) => c.path === "/functions/tokentracker-local-sync"), false);
});

test("repeated bad tokens are rate limited", async (t) => {
  const { gateway, port } = await setup(t);
  await gateway.setEnabled(true);
  for (let i = 0; i < 10; i++) {
    assert.equal((await request(port, "/api/mobile/snapshot", { token: `bad-${i}` })).status, 401);
  }
  assert.equal((await request(port, "/api/mobile/snapshot", { token: "bad" })).status, 429);
});

test("admin handler reports unavailable without a gateway and rejects unknown actions", async () => {
  const captured = [];
  const res = {
    writeHead(status) { captured.push(status); },
    end() {},
  };
  await handleMobileGatewayAdmin({ method: "GET" }, res, async () => ({}), null);
  const fake = { describe: () => ({}) };
  await handleMobileGatewayAdmin({ method: "POST" }, res, async () => ({ action: "nope" }), fake);
  await handleMobileGatewayAdmin({ method: "DELETE" }, res, async () => ({}), fake);
  assert.deepEqual(captured, [503, 400, 405]);
});
