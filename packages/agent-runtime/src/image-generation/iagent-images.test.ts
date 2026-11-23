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
          expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-image-2", n: 1 });
          return Response.json({ task_id: task, status: "processing", poll_url: "https://example.test/credential-trap" }, { status: 202 });
        }
        expect(path).toBe(`/site-api/image-tasks/${task}`);
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
        endpoint: { ...base, iagentProtocol: "openai", modelId: "gpt-image-2" },
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
