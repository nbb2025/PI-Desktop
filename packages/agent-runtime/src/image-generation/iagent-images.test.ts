import { describe, expect, it, vi } from "vitest";
import { IAGENT_ORIGIN } from "@pi-desktop/shared";
import { generateImageBatch } from "./index.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";
const inputImage = { bytes: Buffer.from(png, "base64"), mimeType: "image/png", extension: "png" };
const base = { baseUrl: `${IAGENT_ORIGIN}/v1`, apiKey: "fixture", vendorKey: "iagent" };

describe("iAgent image routes", () => {
  it("recovers a dropped query while polling a single GPT Image job past the former deadline", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const task = "imgtask_slow";
      let queries = 0;
      const dispatch = vi.fn<typeof fetch>(async (url, init) => {
        const path = new URL(String(url)).pathname;
        const headers = new Headers(init?.headers);
        if (path === "/site-api/image-config") {
          expect(headers.has("authorization")).toBe(false);
          return Response.json({ async_enabled: true });
        }
        if (path === "/images/generations/async") {
          expect(headers.get("x-iagent-image-route")).toBe("openai-generation");
          expect(JSON.parse(String(init?.body))).toEqual({
            model: "gpt-image-2.6-sunburst", prompt: "A watercolor cat", n: 1,
            size: "1024x1024", quality: "high", output_format: "png", moderation: "auto",
          });
          return Response.json({ task_id: task, status: "processing", poll_url: `/images/tasks/${task}` }, { status: 202 });
        }
        expect(path).toBe(`/images/tasks/${task}`);
        expect(init?.method).toBe("GET");
        expect(headers.get("authorization")).toBe("Bearer fixture");
        if (++queries === 1) {
          return new Response(new ReadableStream({
            start(stream) { stream.error(new TypeError("Image task response disconnected")); },
          }));
        }
        const completed = Date.now() - startedAt >= 4 * 60_000;
        return Response.json({
          task_id: task, status: completed ? "completed" : "processing",
          ...(completed ? { result: { data: [{ b64_json: png }] } } : {}),
        });
      });
      const batch = generateImageBatch({
        endpoint: { ...base, iagentProtocol: "openai", modelId: "gpt-image-2.6-sunburst" },
        input: { items: [{ prompt: "A watercolor cat" }] },
        signal: new AbortController().signal, fetchImpl: dispatch,
        save: async () => "/cat.png",
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 3_000);
      expect((await batch)[0]).toMatchObject({ status: "succeeded", path: "/cat.png" });
      expect(dispatch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the receipt before querying and retains it when the upstream times out", async () => {
    vi.useFakeTimers();
    try {
      const taskId = "imgtask_accepted";
      const accepted = vi.fn();
      const operation = vi.fn();
      let queried = false;
      const dispatch = vi.fn<typeof fetch>(async (url, init) => {
        const target = new URL(String(url));
        expect(target.origin).toBe(IAGENT_ORIGIN);
        if (target.pathname === "/site-api/image-config") return Response.json({ async_enabled: true });
        if (init?.method === "POST") {
          return Response.json({
            task_id: taskId, status: "processing", poll_url: `https://example.test/images/tasks/${taskId}`,
          }, { status: 202 });
        }
        expect(target.pathname).toBe(`/site-api/image-tasks/${taskId}`);
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture");
        queried = true;
        return Response.json({ task_id: taskId, status: "failed", http_status: 504 });
      });
      const pending = generateImageBatch({
        endpoint: { ...base, iagentProtocol: "openai", modelId: "gpt-image-2" },
        input: { items: [{ prompt: "A landscape" }] },
        signal: new AbortController().signal, fetchImpl: dispatch,
        save: async () => "/image.png", onOperation: operation, onIagentTaskAccepted: accepted,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted).toHaveBeenCalledExactlyOnceWith({ index: 0, taskId });
      expect(queried).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toEqual([{ index: 0, status: "failed", errorCode: "IMAGE_HTTP_504" }]);
      expect(queried).toBe(true);
      expect(operation).toHaveBeenCalledExactlyOnceWith({ index: 0, text: [], responseId: taskId });
      expect(dispatch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the website's multipart field and defaults for one GPT Image reference", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/site-api/image-config")) return Response.json({ async_enabled: false });
      expect(url).toBe(`${IAGENT_ORIGIN}/images/edits`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      const body = init?.body as FormData;
      expect(Object.fromEntries([...body.entries()].filter(([, value]) => typeof value === "string"))).toEqual({
        model: "gpt-image-2.6-sunburst", prompt: "Keep the same scene", n: "1",
        size: "1024x1024", quality: "high", output_format: "png", moderation: "auto",
      });
      expect(body.get("image[]")).toBeInstanceOf(Blob);
      expect(body.has("image")).toBe(false);
      return Response.json({ data: [{ b64_json: png }] });
    });
    const result = await generateImageBatch({
      endpoint: { ...base, iagentProtocol: "openai", modelId: "gpt-image-2.6-sunburst" },
      input: { items: [{ prompt: "Keep the same scene", images: ["/fixture.png"] }] },
      signal: new AbortController().signal, fetchImpl: dispatch,
      loadImages: async () => [inputImage], save: async () => "/generated.png",
    });
    expect(result[0].status).toBe("succeeded");
    expect(dispatch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("uses Gemini inline image parts for a reference edit", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/site-api/image-config")) return Response.json({ async_enabled: false });
      expect(url).toBe(`${IAGENT_ORIGIN}/v1beta/models/gemini-3-pro-image-preview:generateContent`);
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("fixture");
      expect(JSON.parse(String(init?.body))).toEqual({
        contents: [{ parts: [{ text: "Use a warmer background" }, { inlineData: { data: png, mimeType: "image/png" } }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      });
      return Response.json({ candidates: [{ content: { parts: [{ inline_data: { data: png } }] } }] });
    });
    const result = await generateImageBatch({
      endpoint: { ...base, iagentProtocol: "gemini", modelId: "gemini-3-pro-image-preview" },
      input: { items: [{ prompt: "Use a warmer background", images: ["/fixture.png"] }] },
      signal: new AbortController().signal, fetchImpl: dispatch,
      loadImages: async () => [inputImage], save: async () => "/generated.png",
    });
    expect(result[0].status).toBe("succeeded");
    expect(dispatch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("uses the Grok JSON edit wire and does not re-submit failures", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/site-api/image-config")) return Response.json({ async_enabled: true });
      expect(url).toBe(`${IAGENT_ORIGIN}/site-api/image-tasks`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
      expect(new Headers(init?.headers).get("x-iagent-image-route")).toBe("grok-edit");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "grok-imagine-edit", prompt: "Change the lighting", n: 1,
        image: { image_url: `data:image/png;base64,${png}` },
      });
      return new Response(null, { status: 503 });
    });
    const result = await generateImageBatch({
      endpoint: { ...base, iagentProtocol: "grok", modelId: "grok-imagine-edit" },
      input: { items: [{ prompt: "Change the lighting", images: ["/fixture.png"] }] },
      signal: new AbortController().signal, fetchImpl: dispatch,
      loadImages: async () => [inputImage], save: async () => "/generated.png",
    });
    expect(result[0]).toMatchObject({ status: "failed", errorCode: "IMAGE_SUBMISSION_UNKNOWN" });
    expect(dispatch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
