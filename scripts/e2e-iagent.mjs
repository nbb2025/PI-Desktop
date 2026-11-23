// Isolated Desktop, real Host and Agent runtime, and a loopback iAgent fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { imageChatModel } from "./e2e/image-chat-model.mjs";
import { waitFor } from "./e2e/wait.mjs";

const { appDir, electronBinary } = resolveElectronBinary();
const hostBinary = resolveHostBinary();
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-iagent-e2e-")));
const dataDir = join(root, "data");
const project = join(root, "project");
mkdirSync(project);
const host = new Host(hostBinary, dataDir);
await host.start();
await host.call("workspace.set", { path: project });
await host.call("settings.set", {
  language: "en",
  defaultMode: "agent",
  defaultPermissionMode: "auto",
  onboardingDismissed: true,
  startupAnimation: { enabled: false },
});
await host.stop();

const chat = imageChatModel();
const chatGroup = { id: 10, name: "iAgent Chat Fixture", platform: "composite", status: "active" };
const imageGroup = { id: 20, name: "iAgent Images Fixture", platform: "openai", status: "active" };
const videoGroup = { id: 30, name: "iAgent Video Fixture", platform: "video-lt", status: "active" };
const newGroup = { id: 40, name: "iAgent New Fixture", platform: "composite", status: "active" };
let groups = [chatGroup, imageGroup, videoGroup];
let catalog = [
  { id: "gpt-fixture", group_id: 10 },
  { id: "codex-auto-review", group_id: 10 },
  { id: "gpt-image-2", group_id: 20 },
  { id: "sd-2-fast-720", group_id: 30 },
];
const posts = [];
const faults = [];
const wires = [];
const requests = [];
const reply = (res, data) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    const { pathname } = url;
    requests.push(`${req.method} ${pathname}`);
    if (pathname === "/v1/chat/completions" || pathname === "/v1/images/generations") {
      const expected = pathname.includes("/images/") ? "Bearer image-key-fixture" : "Bearer chat-key-fixture";
      assert.equal(req.headers.authorization, expected);
      wires.push(pathname);
      return chat.handler(req, res);
    }
    if (pathname === "/site-api/models") return reply(res, { models: catalog, group_order: [40, 10, 20, 30] });
    if (pathname === "/api/v1/auth/login") {
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { email: "desktop@example.test", password: "fixture-password" });
      return reply(res, { code: 0, data: {
        access_token: "access-fixture", refresh_token: "refresh-fixture", expires_in: 3600,
        user: { id: 71, email: "desktop@example.test" },
      } });
    }
    if (pathname === "/api/v1/auth/logout") return reply(res, { code: 0, data: {} });
    assert.equal(req.headers.authorization, "Bearer access-fixture");
    if (pathname === "/api/v1/groups/available") return reply(res, { code: 0, data: groups });
    if (pathname === "/api/v1/keys" && req.method === "GET") {
      const group_id = Number(url.searchParams.get("group_id"));
      const data = group_id === 10 ? [{ id: 81, group_id, name: "聊天", status: "active", key: "chat-key-fixture" }] : [];
      return reply(res, { code: 0, data: { items: data, total: data.length, page_size: 100, pages: 1 } });
    }
    if (pathname === "/api/v1/keys" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      assert.deepEqual(payload, { group_id: 20, name: "创意工坊" });
      assert.equal(req.headers["idempotency-key"], "iagent-workspace-v1-71-20-media");
      posts.push(payload);
      return reply(res, { code: 0, data: { ...payload, id: 82, status: "active", key: "image-key-fixture" } });
    }
    throw new Error(`Unhandled fixture path ${req.method} ${pathname}`);
  } catch (error) {
    faults.push(String(error));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const fetchHook = join(root, "fetch-fixture.mjs");
writeFileSync(fetchHook, `const target = "http://127.0.0.1:${server.address().port}";
let inner = globalThis.fetch;
const redirecting = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "ai.iagent.dev") return inner(input, init);
  const fixture = target + url.pathname + url.search;
  return input instanceof Request ? inner(new Request(fixture, input), init) : inner(fixture, init);
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true, get: () => redirecting, set: (value) => { if (value !== redirecting) inner = value; },
});`);

const env = {
  ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: hostBinary,
  PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "",
  NODE_OPTIONS: `--import=${fetchHook}`,
};
delete env.ELECTRON_RUN_AS_NODE;
const detached = process.platform !== "win32";
const child = spawn(electronBinary, [
  "--remote-debugging-port=0", `--user-data-dir=${join(root, "profile")}`,
  "--host-resolver-rules=MAP ai.iagent.dev ~NOTFOUND", ".",
], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached });
const closed = once(child, "close");
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

let ws;
let screen = async () => "";
try {
  let target;
  await waitFor(async () => {
    const port = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) return false;
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((entry) =>
        entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
      return !!target;
    } catch { return false; }
  }, 30_000, "isolated Desktop target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") {
      output += `\nRenderer exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`;
    }
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error.message));
    else operation.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Renderer action failed");
    return result.result.value;
  };
  screen = () => evaluate(`JSON.stringify({
    body: document.body.innerText.slice(-3000),
    booting: !!document.querySelector(".app-shell.is-booting"),
    settingsOpen: document.querySelector('[data-nav="settings"]')?.getAttribute("aria-expanded"),
    documentVisibility: document.visibilityState,
  })`);
  const invoke = (name, ...args) => evaluate(`window.piDesktop.invoke(window.piDesktop.channels.invoke.${name}, ...${JSON.stringify(args)}).then((result) => {
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  })`);
  await send("Runtime.enable");
  await send("Page.bringToFront");
  await waitFor(() => evaluate('!!window.__PI_DESKTOP__ && !!document.querySelector(\'[data-nav="settings"]\') && !document.querySelector(".app-shell.is-booting")'),
    30_000, "desktop usable as guest");
  assert.equal((await invoke("iagentStatus")).account, undefined);
  await evaluate('window.__PI_DESKTOP__.skipStartupOverlays(); window.__PI_DESKTOP__.setSettingsTab("agent");');
  await waitFor(() => evaluate(`!!document.querySelector('input[autocomplete="username"]')`), 10_000, "iAgent sign-in form");
  const login = await invoke("iagentLogin", { email: "desktop@example.test", password: "fixture-password" });
  assert.equal(login.status.sync, "ready");
  const providerList = await invoke("providersList");
  assert.deepEqual(providerList.providers.map((provider) => provider.name), [chatGroup.name]);
  assert.deepEqual(providerList.providers[0].models.map((model) => model.id), ["gpt-fixture"]);
  assert.deepEqual(posts, []);
  await evaluate('window.__PI_DESKTOP__.setPage("chat")');
  await waitFor(() => evaluate(`!!document.querySelector('.composer-input[contenteditable="true"]')`), 15_000, "agent composer");
  await evaluate('document.querySelector(".composer-input").focus()');
  await send("Input.insertText", { text: "Generate two raster images." });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor(() => evaluate('document.querySelector(".generated-image-preview img")?.naturalWidth === 480'), 50_000, "Agent-created image preview");
  assert.equal(chat.imageRequests.length, 2);
  assert.equal(posts.length, 1);
  assert.ok(wires.includes("/v1/chat/completions"));
  assert.deepEqual(chat.failures, []);
  groups = [newGroup, imageGroup];
  catalog = [{ id: "new-model", group_id: 40 }, { id: "gpt-image-2", group_id: 20 }];
  await invoke("iagentRefresh");
  assert.deepEqual((await invoke("providersList")).providers.map((provider) => provider.name), [newGroup.name]);
  await invoke("iagentLogout");
  assert.deepEqual((await invoke("providersList")).providers, []);
  assert.deepEqual(faults, []);
  console.log("PASS: guest entry, iAgent sign-in, chat key reuse, Agent image preview, catalog changes and disconnect");
} catch (error) {
  console.error("Fixture requests", requests, faults, chat.failures);
  if (ws?.readyState === WebSocket.OPEN) console.error(await screen().catch(() => ""));
  console.error(output.slice(-3800));
  throw error;
} finally {
  ws?.close();
  try { if (detached) process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch {}
  let timer;
  await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, 5_000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    try { if (detached) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
    await closed;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
