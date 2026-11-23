import { describe, expect, it, vi } from "vitest";
import { IAGENT_ORIGIN } from "@pi-desktop/shared";
import { generateImageBatch } from "./index.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";
const inputImage = { bytes: Buffer.from(png, "base64"), mimeType: "image/png", extension: "png" };
const base = { baseUrl: `${IAGENT_ORIGIN}/v1`, apiKey: "fixture", vendorKey: "iagent" };

describe("iAgent image routes", () => {
  it("uses Gemini inline image parts for a reference edit", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, init) => {
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
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses the Grok JSON edit wire and does not re-submit failures", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(`${IAGENT_ORIGIN}/v1/images/edits`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
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
    expect(result[0]).toMatchObject({ status: "failed", errorCode: "IMAGE_HTTP_503" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
