import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as settled } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createIagentIntegration } from "../electron/main/iagent/integration.ts";
import { ModelsDevCatalog } from "../electron/main/models-dev-catalog.ts";

const group = (id, name, platform, options = {}) => ({ id, name, platform, status: "active", ...options });
const model = (group_id, id) => ({ group_id, id });
const key = (id, group_id, name = "聊天", status = "active") => ({ id, group_id, name, status, key: `fixture-${id}` });
const ok = (data) => Response.json({ code: 0, data });

function fixture() {
  let now = 1_800_000_000_000;
  let signedInUser = 41;
  let groupFailure = false;
  let catalogFailure = false;
  let twoFactor = false;
  let pageFailure = false;
  let createFailure = false;
  let rejectRefresh = false;
  let rates = {};
  let plaza = null;
  let channels = [];
  let groups = [
    group(2, "ChatGPT", "openai"), group(1, "Claude", "anthropic"), group(3, "Mixed", "grok"),
    group(4, "GPT Image", "openai"), group(5, "Wan", "bailian"), group(6, "Video", "video-lt"),
    group(7, "Code service", "anthropic", { claude_code_only: true }), group(8, "Offline", "openai", { status: "inactive" }),
  ];
  let catalog = {
    group_order: [2, 1, 4, 5],
    sort_rules: [{ pattern: "gpt-*", strategy: "version-tier", keywords: ["astra", "sol", "terra"] }],
    models: [
      model(2, "gpt-6-sol"), model(2, "gpt-6-astra"), model(2, "gpt-5.6-terra"), model(2, "codex-auto-review"),
      model(1, "claude-opus-4-8"), model(3, "grok-imagine-video-1.5"), model(3, "grok-5"),
      model(4, "gpt-image-2"), model(5, "wan3.0-video"), model(6, "sd-2-fast-720"),
      model(7, "claude-code-1"), model(8, "gpt-7"), model(99, "ineligible"),
    ],
  };
  const pages = new Map();
  const existing = new Map();
  const secrets = new Map();
  const changes = [];
  const calls = [];
  let settings = {};
  let keyRequests = 0;
  const makeIntegration = (options = {}) => createIagentIntegration({
    now: () => now,
    language: () => "zh-CN",
    onChange: (update) => changes.push(update),
    call: async (method, params) => {
      if (method === "settings.set") {
        settings = { ...settings, ...params };
        return settings;
      }
      const ref = params.secretRef;
      if (method === "secrets.getForRuntime") return { value: secrets.get(ref) };
      if (method === "secrets.set") return secrets.set(ref, params.value);
      if (method === "secrets.delete") return secrets.delete(ref);
      assert.fail(`Unexpected host operation ${method}`);
    },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push([init.method, url.pathname]);
      assert.equal(url.origin, "https://ai.iagent.dev");
      assert.equal(init.redirect, "error");
      const auth = { user: { id: signedInUser, email: "desktop@example.test", internal_metadata: "private" }, access_token: "login-fixture", refresh_token: "refresh-fixture", expires_in: 3600 };
      if (url.pathname === "/api/v1/auth/login")
        return ok(twoFactor ? { requires_2fa: true, temp_token: "private-challenge" } : auth);
      if (url.pathname === "/api/v1/auth/login/2fa") {
        assert.deepEqual(JSON.parse(init.body), { temp_token: "private-challenge", totp_code: "123456" });
        return ok(auth);
      }
      if (url.pathname === "/api/v1/auth/logout") return ok({});
      if (url.pathname === "/api/v1/auth/refresh")
        return rejectRefresh ? new Response(null, { status: 401 }) : ok(auth);
      if (url.pathname === "/site-api/models") {
        assert.equal(new Headers(init.headers).has("authorization"), false);
        return catalogFailure ? new Response(null, { status: 503 }) : Response.json(catalog);
      }
      if (url.pathname === "/site-api/channels") {
        assert.equal(new Headers(init.headers).has("authorization"), false);
        return Response.json(channels);
      }
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer login-fixture");
      if (url.pathname === "/api/v1/groups/rates") return ok(rates);
      if (url.pathname === "/api/v1/model-plaza")
        return plaza ? ok(plaza) : new Response(null, { status: 404 });
      if (url.pathname === "/api/v1/groups/available")
        return groupFailure ? new Response(null, { status: 503 }) : ok(groups);
      if (url.pathname === "/api/v1/keys" && init.method === "GET") {
        const id = Number(url.searchParams.get("group_id"));
        const page = Number(url.searchParams.get("page"));
        if (pageFailure && page === 2) return new Response(null, { status: 503 });
        const data = pages.get(id) ?? [[]];
        return ok({ items: data[page - 1] ?? [], pages: data.length, total: data.flat().length, page_size: 100 });
      }
      if (url.pathname.startsWith("/api/v1/keys/")) {
        const id = Number(url.pathname.split("/").at(-1));
        return existing.has(id) ? ok(existing.get(id)) : new Response(null, { status: 404 });
      }
      if (url.pathname === "/api/v1/keys" && init.method === "POST") {
        keyRequests++;
        const { group_id, name } = JSON.parse(init.body);
        assert.equal(new Headers(init.headers).get("idempotency-key"), `iagent-workspace-v1-${signedInUser}-${group_id}-${name === "聊天" ? "chat" : "media"}`);
        if (createFailure) throw new TypeError("fixture network break after request");
        const created = key(90 + keyRequests, group_id, name);
        existing.set(created.id, created);
        return ok(created);
      }
      assert.fail(`Unexpected iAgent request ${url.pathname}`);
    },
    ...options,
  });
  return {
    makeIntegration, setTwoFactor: () => { twoFactor = true; },
    setUser: (id) => { signedInUser = id; }, advance: (ms = 61_000) => { now += ms; },
    setGroups: (next) => { groups = next; }, setCatalog: (next) => { catalog = next; },
    setPrices: (next) => { ({ rates = {}, plaza = null, channels = [] } = next); },
    failCatalog: (failed) => { catalogFailure = failed; }, failGroups: (failed) => { groupFailure = failed; },
    failPage: (failed) => { pageFailure = failed; }, failCreate: (failed) => { createFailure = failed; },
    failRefresh: () => { rejectRefresh = true; },
    changes, calls, pages, existing, keyRequests: () => keyRequests, settings: () => settings,
  };
}

test("a refreshed models.dev match updates the exact managed model and its thinking ladder", async () => {
  const mock = fixture();
  const id = "gpt-6-refresh-fixture";
  mock.setCatalog({ models: [model(2, id), model(2, id + "-thinking")] });
  let catalogFetches = 0;
  let online = false;
  const modelsDevCatalog = new ModelsDevCatalog({
    catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://models.dev/api.json");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      catalogFetches++;
      return online ? Response.json({ openai: {
        id: "openai", name: "OpenAI", api: "https://api.openai.com/v1",
        models: { [id]: {
          id, name: "A new model", reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          limit: { context: 400_000, output: 32_000 },
        } },
      } }) : new Response(null, { status: 503 });
    },
  });
  const integration = mock.makeIntegration({ modelsDevCatalog });
  await integration.refresh();
  assert.equal(catalogFetches, 0);
  await integration.login({ email: "desktop@example.test", password: "fake-password" });
  await settled();
  assert.equal(catalogFetches, 1);
  assert.deepEqual(integration.providers()[0].models.find((entry) => entry.id === id).thinkingLevels, ["off"]);
  online = true;
  const beforeMetadata = mock.changes.length;
  mock.advance(11 * 60_000);
  await integration.refresh();
  await settled();
  assert.equal(catalogFetches, 2);
  const match = integration.modelChoices("iagent:41:2").find((entry) => entry.modelId === id);
  assert.equal(match.catalogSource, "models.dev");
  assert.equal(match.contextWindow, 400_000);
  const bindings = integration.providers()[0].models;
  assert.deepEqual(bindings.find((entry) => entry.id === id).thinkingLevels, ["low", "medium", "high"]);
  assert.deepEqual(bindings.find((entry) => entry.id === id + "-thinking").thinkingLevels, ["off"]);
  assert.ok(mock.changes.slice(beforeMetadata).some(({ catalogChanged }) => catalogChanged));
  mock.advance();
  await integration.refresh();
  await settled();
  assert.equal(catalogFetches, 2, "a group sync reuses an already fresh metadata snapshot");
});

test("chat prices follow group and user rates, channel overrides and backend quotes", async () => {
  const mock = fixture();
  mock.setGroups([
    group(1, "Claude A", "anthropic", { rate_multiplier: 1.2 }),
    group(2, "Claude B", "anthropic", { rate_multiplier: 0.9 }),
  ]);
  const default_pricing = { found: true, input_price: 0.00001, output_price: 0.00005 };
  mock.setCatalog({ price_unit: "USD/token", models: [
    { ...model(1, "claude-fable-5"), default_pricing },
    { ...model(2, "claude-fable-5"), default_pricing },
  ] });
  mock.setPrices({
    rates: { 2: 0.5 },
    channels: [{ platforms: [{
      platform: "claude", groups: [{ id: 1 }, { id: 2 }],
      supported_models: [{
        id: "claude-fable-5", group_ids: [2],
        pricing: { billing_mode: "token", input_price: 0.000012, output_price: 0.00006 },
      }],
    }] }],
  });
  const integration = mock.makeIntegration();
  await integration.login({ email: "desktop@example.test", password: "fake-password" });
  await settled();
  const price = (id) => integration.modelChoices(`iagent:41:${id}`)[0].iagentChatPrice;
  assert.equal(integration.providers().find((row) => row.id === "iagent:41:2").iagentRate, 0.5);
  assert.deepEqual(price(1).tiers, [{ input: 12, output: 60 }]);
  assert.deepEqual(price(2).tiers, [{ input: 6, output: 30 }]);
  assert.equal(price(2).source, "reference");
  mock.setPrices({
    plaza: { groups: [{
      id: 2, platform: "anthropic", rate_multiplier: 0.9, user_rate_multiplier: 0,
      models: [{ name: "claude-fable-5", platform: "anthropic", pricing: {
        billing_mode: "token", input_price: 0.00001, output_price: 0.00005,
      } }],
    }] },
  });
  const beforePrices = mock.changes.length;
  mock.advance();
  await integration.refresh();
  await settled();
  assert.equal(price(2).source, "effective");
  assert.deepEqual(price(2).tiers, [{ input: 0, output: 0 }]);
  assert.ok(mock.changes.slice(beforePrices).some(({ catalogChanged }) => catalogChanged), "price-only changes reload the picker");
  assert.equal(mock.keyRequests(), 0);
});

test("guest browsing, account login and model projection follow iAgent's catalog", async () => {
  const mock = fixture();
  const integration = mock.makeIntegration();
  assert.deepEqual((await integration.refresh()).groups, []);
  assert.deepEqual(mock.calls, []);
  mock.setTwoFactor();
  const pending = await integration.login({ email: "desktop@example.test", password: "fake-password" });
  assert.equal(pending.requiresTwoFactor, true);
  assert.notEqual(pending.challengeId, "private-challenge");
  assert.deepEqual(integration.providers(), []);
  await assert.rejects(integration.confirm({ challengeId: "stale", code: "123456" }), /Invalid/);
  const status = await integration.confirm({ challengeId: pending.challengeId, code: "123456" });
  assert.deepEqual(status.account, { id: 41, email: "desktop@example.test" });
  assert.deepEqual(integration.providers().map((provider) => provider.name), ["ChatGPT", "Claude", "Mixed"]);
  assert.deepEqual(integration.modelChoices("iagent:41:2").map((entry) => entry.modelId), ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-terra"]);
  assert.equal(status.image.model, "gpt-image-2");
  assert.equal(mock.keyRequests(), 0, "login and display do not create remote keys");
});

test("refresh handles revoked, new and republished groups without cross-account leakage", async () => {
  const mock = fixture();
  const integration = mock.makeIntegration();
  await integration.login({ email: "desktop@example.test", password: "fake-password" });
  mock.setGroups([group(1, "Claude", "anthropic"), group(9, "New", "openai")]);
  mock.failCatalog(true);
  mock.advance();
  assert.equal((await integration.refresh()).sync, "stale");
  assert.deepEqual(integration.providers().map((provider) => provider.id), ["iagent:41:1"]);
  await assert.rejects(integration.resolveChat("iagent:41:2", "gpt-6-sol"), /no longer available/);
  mock.failCatalog(false);
  mock.setCatalog({ models: [model(9, "model-2"), model(9, "model-10")], group_order: [9] });
  await integration.refresh(true);
  assert.deepEqual(integration.modelChoices("iagent:41:9").map((entry) => entry.modelId), ["model-10", "model-2"]);
  mock.failGroups(true);
  mock.advance();
  await integration.refresh();
  assert.equal(integration.providers().length, 1);
  await assert.rejects(integration.resolveChat("iagent:41:9", "model-10"), /no longer available/);
  assert.equal(mock.keyRequests(), 0);
  await integration.logout();
  assert.deepEqual(integration.providers(), []);
  mock.setUser(52);
  mock.failGroups(false);
  await integration.login({ email: "other@example.test", password: "fake-password" });
  assert.equal(integration.providers()[0].id, "iagent:52:9");
  await assert.rejects(integration.resolveChat("iagent:41:9", "model-10"), /no longer available/);
  assert.ok(mock.changes.at(-1).catalogChanged);
});

test("the image picker persists a catalog choice and validates it again at generation", async () => {
  const mock = fixture();
  const integration = mock.makeIntegration();
  mock.setCatalog({
    models: [
      model(4, "gpt-image-2"), model(4, "gpt-image-1"),
      model(3, "grok-imagine-image"), model(3, "grok-imagine-edit"),
      model(5, "wan3.0-video"), model(8, "gpt-image-inactive"),
    ],
    group_order: [4, 3],
  });
  const login = await integration.login({ email: "desktop@example.test", password: "fake-password" });
  assert.deepEqual(login.status.imageModels.map(({ groupId, model }) => [groupId, model]), [
    [4, "gpt-image-2"], [4, "gpt-image-1"], [3, "grok-imagine-image"],
  ]);
  await assert.rejects(
    integration.setImageModel({ accountId: 52, choice: { groupId: 4, model: "gpt-image-1" } }),
    /image model is unavailable/,
  );
  await assert.rejects(
    integration.setImageModel({ accountId: 41, choice: { groupId: 3, model: "grok-imagine-edit" } }),
    /image model is unavailable/,
  );
  const gpt = await integration.setImageModel({ accountId: 41, choice: { groupId: 4, model: "gpt-image-1" } });
  assert.deepEqual(mock.settings().iagentImageGeneration, gpt);
  assert.equal(mock.keyRequests(), 0, "selecting a model does not allocate a workspace key");
  assert.equal((await integration.imageEndpoint(false, gpt)).endpoint.modelId, "gpt-image-1");
  await integration.setImageModel({ accountId: 41, choice: null });
  assert.equal(mock.settings().iagentImageGeneration, null);
  assert.equal((await integration.imageEndpoint(false, null)).endpoint.modelId, "gpt-image-2");
  assert.equal(mock.keyRequests(), 1, "changing models in one group reuses the same media key");

  const grok = await integration.setImageModel({ accountId: 41, choice: { groupId: 3, model: "grok-imagine-image" } });
  assert.equal((await integration.imageEndpoint(false, grok)).endpoint.modelId, "grok-imagine-image");
  assert.equal((await integration.imageEndpoint(true, grok)).endpoint.modelId, "grok-imagine-edit");
  mock.setGroups([group(4, "GPT Image", "openai")]);
  await integration.refresh(true);
  await assert.rejects(integration.imageEndpoint(false, grok), /image model is unavailable/);

  await integration.logout();
  mock.setUser(52);
  await integration.login({ email: "other@example.test", password: "fake-password" });
  assert.equal((await integration.imageEndpoint(false, grok)).endpoint.modelId, "gpt-image-2");
});

test("workspace keys reuse all pages, stay account-scoped, and coalesce first use", async () => {
  const mock = fixture();
  const integration = mock.makeIntegration();
  await integration.login({ email: "desktop@example.test", password: "fake-password" });
  mock.pages.set(2, [[key(1, 2, "different purpose")], [key(5, 2)]]);
  mock.existing.set(5, key(5, 2));
  mock.failPage(true);
  await assert.rejects(integration.resolveChat("iagent:41:2", "gpt-6-sol"), /503/);
  assert.equal(mock.keyRequests(), 0);
  mock.failPage(false);
  const chat = await integration.resolveChat("iagent:41:2", "GPT-6-SOL");
  assert.equal(chat.value, "fixture-5");
  assert.equal(chat.modelId, "gpt-6-sol");
  const [first, second] = await Promise.all([integration.imageEndpoint(false), integration.imageEndpoint(false)]);
  assert.equal(first.endpoint.apiKey, second.endpoint.apiKey);
  assert.equal(first.endpoint.modelId, "gpt-image-2");
  assert.equal(mock.keyRequests(), 1);
  await integration.logout();
  assert.throws(first.assertCurrent, /changed/);
  await integration.login({ email: "desktop@example.test", password: "fake-password" });
  assert.equal((await integration.imageEndpoint(false)).endpoint.apiKey, first.endpoint.apiKey);
  assert.equal(mock.keyRequests(), 1);
});

test("unconfirmed creation is reconciled across restart and known keys are not replaced", async () => {
  const mock = fixture();
  let integration = mock.makeIntegration();
  await integration.login({ email: "desktop@example.test", password: "fake-password" });
  mock.failCreate(true);
  await assert.rejects(integration.resolveChat("iagent:41:2", "gpt-6-sol"), /confirm key creation/);
  integration = mock.makeIntegration();
  mock.failCreate(false);
  await assert.rejects(integration.resolveChat("iagent:41:2", "gpt-6-sol"), /confirm key creation/);
  assert.equal(mock.keyRequests(), 1);
  mock.pages.set(2, [[key(24, 2)]]);
  assert.equal((await integration.resolveChat("iagent:41:2", "gpt-6-sol")).value, "fixture-24");
  mock.pages.delete(2);
  mock.advance();
  await assert.rejects(integration.resolveChat("iagent:41:2", "gpt-6-sol"), /workspace key is unavailable/);
  assert.equal(mock.keyRequests(), 1);
  assert.equal(mock.calls.some(([method]) => method === "DELETE"), false);
});

test("renews a signed-in account and removes access when the refresh grant expires", async () => {
  const mock = fixture();
  const integration = mock.makeIntegration();
  await integration.login({ email: "desktop@example.test", password: "fake-password" });
  mock.advance(3_601_000);
  await Promise.all([integration.refresh(), integration.refresh()]);
  assert.equal(mock.calls.filter(([, path]) => path === "/api/v1/auth/refresh").length, 1);
  assert.equal((await integration.status()).sync, "ready");
  mock.advance(3_601_000);
  mock.failRefresh();
  assert.equal((await integration.refresh()).sync, "expired");
  assert.deepEqual(integration.providers(), []);
  assert.equal(mock.keyRequests(), 0);
});
