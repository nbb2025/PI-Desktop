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
  language: "zh-CN",
  defaultMode: "agent",
  defaultPermissionMode: "auto",
  onboardingDismissed: true,
  startupAnimation: { enabled: false },
});
await host.stop();

const chat = imageChatModel();
const chatGroup = { id: 10, name: "ChatGPT 福利组（长分组名）", platform: "composite", status: "active", rate_multiplier: 1.2 };
const imageGroup = { id: 20, name: "iAgent Images Fixture", platform: "openai", status: "active" };
const videoGroup = { id: 30, name: "iAgent Video Fixture", platform: "video-lt", status: "active" };
const newGroup = { id: 40, name: "iAgent New Fixture", platform: "composite", status: "active" };
const reasoningGroup = { id: 50, name: "ChatGPT-8倍速（专用分组）", platform: "openai", status: "active", rate_multiplier: 0.9 };
const chatModel = "gpt-6.2-reasoning-fixture";
const selectedImageModel = "gpt-image-1-fixture";
const basePrice = { found: true, input_price: 0.00001, output_price: 0.00005 };
let groups = [chatGroup, reasoningGroup, imageGroup, videoGroup];
let catalog = [
  { id: chatModel, group_id: 10, default_pricing: basePrice },
  { id: chatModel, group_id: 50, default_pricing: basePrice },
  { id: "codex-auto-review", group_id: 10 },
  { id: "gpt-image-2", group_id: 20 },
  { id: selectedImageModel, group_id: 20 },
  { id: "sd-2-fast-720", group_id: 30 },
];
const posts = [];
const faults = [];
const externalUrls = [];
const wires = [];
const requests = [];
const reasoningRequests = [];
const imageTasks = new Map();
let imageTasksCompleted = false;
let releaseMetadata;
const metadataReady = new Promise((resolve) => { releaseMetadata = resolve; });
const reasoningAnswer = "Thinking level received.";
const reply = (res, data) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    const { pathname } = url;
    if (pathname === "/os/open-external") {
      assert.equal(req.method, "POST");
      let externalUrl = "";
      for await (const chunk of req) externalUrl += chunk;
      externalUrls.push(externalUrl);
      return reply(res, {});
    }
    requests.push(`${req.method} ${pathname}`);
    if (pathname === "/api.json") {
      assert.equal(req.headers.authorization, undefined);
      await metadataReady;
      return reply(res, { openai: {
        id: "openai", name: "OpenAI", api: "https://api.openai.com/v1",
        models: { [chatModel]: {
          id: chatModel, name: "Reasoning fixture", reasoning: true, tool_call: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          limit: { context: 400_000, output: 32_000 },
        } },
      } });
    }
    if (pathname === "/v1/responses") {
      assert.equal(req.headers.authorization, "Bearer reasoning-key-fixture");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      reasoningRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const answer = `${reasoningAnswer} ${reasoningRequests.length}`;
      const item = {
        id: "thinking-message", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: answer, annotations: [] }],
      };
      const events = [
        { type: "response.created", response: { id: "thinking-response" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: answer },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: {
          id: "thinking-response", status: "completed", output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        } },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    }
    if (pathname === "/v1/chat/completions") {
      assert.equal(req.headers.authorization, "Bearer chat-key-fixture");
      wires.push(pathname);
      return chat.handler(req, res);
    }
    if (pathname === "/site-api/image-config") return reply(res, { async_enabled: true });
    if (pathname === "/images/generations/async") {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer image-key-fixture");
      assert.equal(req.headers["x-iagent-image-route"], "openai-generation");
      assert.equal(req.headers["accept-language"], "zh-CN");
      let result;
      await chat.handler(req, {
        writeHead(status) { assert.equal(status, 200); },
        end(body) { result = JSON.parse(body); },
      });
      assert.ok(result);
      const task_id = `imgtask_${imageTasks.size + 1}`;
      imageTasks.set(task_id, result);
      res.writeHead(202, { "content-type": "application/json", "retry-after": "1" });
      return res.end(JSON.stringify({ task_id, status: "processing", poll_url: `/site-api/image-tasks/${task_id}` }));
    }
    if (pathname.startsWith("/site-api/image-tasks/")) {
      assert.equal(req.method, "GET");
      assert.equal(req.headers.authorization, "Bearer image-key-fixture");
      assert.equal(req.headers["accept-language"], "zh-CN");
      const task_id = pathname.split("/").at(-1);
      const result = imageTasks.get(task_id);
      assert.ok(result);
      return reply(res, imageTasksCompleted ? { task_id, status: "completed", result } : { task_id, status: "processing" });
    }
    if (pathname === "/site-api/models") return reply(res, { models: catalog, group_order: [40, 10, 50, 20, 30], price_unit: "USD/token" });
    if (pathname === "/site-api/channels") return reply(res, []);
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
    if (pathname === "/api/v1/groups/rates") return reply(res, { code: 0, data: { 50: 0.5 } });
    if (pathname === "/api/v1/model-plaza") {
      res.writeHead(404);
      return res.end();
    }
    if (pathname === "/api/v1/keys" && req.method === "GET") {
      const group_id = Number(url.searchParams.get("group_id"));
      const data = group_id === 10
        ? [{ id: 81, group_id, name: "聊天", status: "active", key: "chat-key-fixture" }]
        : group_id === 50 ? [{ id: 85, group_id, name: "聊天", status: "active", key: "reasoning-key-fixture" }] : [];
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
writeFileSync(fetchHook, `import { createRequire } from "node:module";
const target = "http://127.0.0.1:${server.address().port}";
let inner = globalThis.fetch;
if (process.type === "browser") {
  const { shell } = createRequire(import.meta.url)("electron");
  shell.openExternal = async (url) => {
    const response = await inner(target + "/os/open-external", { method: "POST", body: url });
    if (!response.ok) throw new Error("External URL fixture failed");
  };
  console.log("External URL fixture installed");
}
const redirecting = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "ai.iagent.dev" && url.hostname !== "models.dev") return inner(input, init);
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
  "--host-resolver-rules=MAP ai.iagent.dev ~NOTFOUND, MAP models.dev ~NOTFOUND", ".",
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
  assert.match(output, /External URL fixture installed/);
  const registrationButton = `[...document.querySelectorAll("button")].find(
    (button) => button.type === "button" && button.textContent.trim() === "注册账号"
  )`;
  assert.ok(await evaluate(`Boolean(${registrationButton})`), "the iAgent guest login offers registration");
  await evaluate(`${registrationButton}.click()`);
  await waitFor(() => externalUrls.length > 0, 5_000, "registration opens the iAgent homepage");
  assert.deepEqual(externalUrls, ["https://ai.iagent.dev/"]);
  const login = await invoke("iagentLogin", { email: "desktop@example.test", password: "fixture-password" });
  assert.equal(login.status.sync, "ready");
  const providerList = await invoke("providersList");
  assert.deepEqual(providerList.providers.map((provider) => provider.name), [chatGroup.name, reasoningGroup.name]);
  assert.deepEqual(providerList.providers[0].models.map((model) => model.id), [chatModel]);
  assert.deepEqual(posts, []);
  const imageTrigger = 'button[aria-label="iAgent 生图模型"]';
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(imageTrigger)})?.textContent.includes("自动选择")`),
    10_000, "the signed-in account defaults to automatic image selection");
  await evaluate(`document.querySelector(${JSON.stringify(imageTrigger)}).click()`);
  await waitFor(() => evaluate(`[...document.querySelectorAll('[role="option"]')].some(
    (item) => item.textContent.includes(${JSON.stringify(selectedImageModel)})
  )`), 5_000, "the iAgent image model menu displays authorized models");
  await evaluate(`[...document.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent.includes(${JSON.stringify(selectedImageModel)})
  ).click()`);
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(imageTrigger)})?.textContent.includes(${JSON.stringify(selectedImageModel)})`),
    5_000, "the selected image model appears in settings");
  assert.deepEqual((await invoke("settingsGet")).iagentImageGeneration, {
    accountId: 71, groupId: 20, model: selectedImageModel,
  });
  await evaluate('window.__PI_DESKTOP__.setPage("chat")');
  await waitFor(() => evaluate(`!!document.querySelector('.composer-input[contenteditable="true"]')`), 15_000, "agent composer");
  await waitFor(() => evaluate(`(async () => {
    const element = document.querySelector(".empty-hero .brand-logo");
    if (!element) return false;
    const background = getComputedStyle(element).backgroundImage;
    if (!background.startsWith('url("') || !background.includes("iagent-mark")) return false;
    const image = new Image();
    image.src = background.slice(5, -2);
    await image.decode();
    return image.naturalWidth > 0;
  })()`), 10_000, "official iAgent mark");
  const openMenu = () => evaluate('document.querySelector(".composer-model-thinking-chip").click()');
  const closeMenu = () => send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  const selectGroup = (label) => evaluate(`Array.from(document.querySelectorAll(".composer-model-rail-item"))
    .find((item) => item.querySelector(".composer-model-rail-label")?.textContent === ${JSON.stringify(label)}).click()`);
  const selectModel = () => evaluate('document.querySelector(".composer-model-option").click()');
  const priceText = () => evaluate('document.querySelector(".composer-iagent-price")?.textContent');
  const sendPrompt = async (text) => {
    await evaluate('document.querySelector(".composer-input").focus()');
    await send("Input.insertText", { text });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  await openMenu();
  await waitFor(async () => (await priceText())?.includes("$12"), 10_000, "first group's adjusted price");
  const menuAlpha = await evaluate(`(() => {
    const menu = document.querySelector(".composer-model-thinking-menu");
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    const canvas = document.createElement("canvas");
    const pixel = canvas.getContext("2d");
    try {
      return ["dark", "light"].map((theme) => {
        root.dataset.theme = theme;
        pixel.clearRect(0, 0, 1, 1);
        pixel.fillStyle = getComputedStyle(menu).backgroundColor;
        pixel.fillRect(0, 0, 1, 1);
        return pixel.getImageData(0, 0, 1, 1).data[3];
      });
    } finally {
      root.dataset.theme = previousTheme;
    }
  })()`);
  assert.deepEqual(menuAlpha, [255, 255], "picker hides the page beneath it in both themes");
  await selectGroup(reasoningGroup.name);
  await waitFor(async () => (await priceText())?.includes("$5"), 10_000, "second group's custom adjusted price");
  assert.match(await priceText(), /\$5\b.*\$25\b/);
  assert.match(await evaluate('document.querySelector(".composer-model-rail-item.active").textContent'), /×0\.5/);
  assert.equal(await evaluate('!!document.querySelector(".composer-thinking-range")'), false);
  await selectModel();
  releaseMetadata();
  await waitFor(() => evaluate('document.querySelector(".composer-thinking-range")?.getAttribute("aria-valuetext") === "omit"'), 10_000, "reasoning levels with no forced default");
  const visibleRail = () => evaluate(`(() => {
    const menu = document.querySelector(".composer-model-thinking-menu");
    const labels = [...menu.querySelectorAll(".composer-model-rail-label")];
    const { left, right } = menu.getBoundingClientRect();
    return labels.some((label) => label.textContent === ${JSON.stringify(reasoningGroup.name)})
      && labels.every((label) => label.scrollWidth <= label.clientWidth + 1)
      && left >= 0 && right <= innerWidth;
  })()`);
  assert.equal(await visibleRail(), true);
  await send("Emulation.setDeviceMetricsOverride", { width: 450, height: 640, deviceScaleFactor: 1, mobile: false });
  await waitFor(visibleRail, 5_000, "narrow model picker without clipped group labels");
  await send("Emulation.clearDeviceMetricsOverride");
  await closeMenu();
  await sendPrompt("Use the default thinking behavior.");
  const waitForReply = (index) => waitFor(
    () => evaluate(`document.body.innerText.includes(${JSON.stringify(`${reasoningAnswer} ${index}`)})
      && !document.querySelector(".composer-model-thinking-chip")?.disabled`), 25_000, "reasoning reply");
  await waitForReply(1);
  assert.equal(reasoningRequests[0].reasoning?.effort, undefined);
  await openMenu();
  if (process.env.PI_IAGENT_E2E_SCREENSHOT) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.PI_IAGENT_E2E_SCREENSHOT, Buffer.from(data, "base64"));
  }
  await evaluate('Array.from(document.querySelectorAll(".composer-thinking-tick")).find((tick) => tick.textContent === "high").click()');
  await waitFor(() => evaluate('document.querySelector(".composer-thinking-range")?.getAttribute("aria-valuetext") === "high"'), 5_000, "thinking selection");
  await closeMenu();
  await sendPrompt("Verify the selected thinking level.");
  await waitForReply(2);
  assert.deepEqual(reasoningRequests.map(({ model, reasoning }) => [model, reasoning?.effort]), [
    [chatModel, undefined], [chatModel, "high"],
  ]);
  await openMenu();
  await selectGroup(chatGroup.name);
  await selectModel();
  await closeMenu();
  await sendPrompt("Generate two raster images.");
  await waitFor(() => evaluate('document.body.innerText.includes("iAgent 已接单，等待图片")'),
    15_000, "the conversation shows that iAgent accepted the image task");
  assert.equal(await evaluate('!!document.querySelector(".generated-image-preview img")'), false);
  imageTasksCompleted = true;
  await waitFor(() => evaluate('document.querySelector(".generated-image-preview img")?.naturalWidth === 480'), 50_000, "Agent-created image preview");
  assert.equal(chat.imageRequests.length, 2);
  assert.deepEqual(chat.imageRequests.map(({ model }) => model), [selectedImageModel, selectedImageModel]);
  assert.equal(imageTasks.size, 2, "one accepted image task per requested output");
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
  console.log("PASS: iAgent registration link, image model selection, task receipt and preview, prices, responsive picker, reasoning, key reuse and disconnect");
} catch (error) {
  console.error("Fixture requests", requests, faults, chat.failures);
  if (ws?.readyState === WebSocket.OPEN) console.error(await screen().catch(() => ""));
  console.error(output.slice(-3800));
  throw error;
} finally {
  releaseMetadata();
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
