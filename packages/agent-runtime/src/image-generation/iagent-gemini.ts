import type { AssistantImages, ProviderImages } from "@earendil-works/pi-ai";
import { IAGENT_ORIGIN } from "@pi-desktop/shared";
import { boundedBytes, generatedImageType, imageError, MAX_IMAGE_BYTES } from "./download.js";
import { decodeImageBase64, safeImageError } from "./openai-images.js";

export const IAGENT_GEMINI_IMAGES_API = "pi-desktop-iagent-gemini-images";

/** iAgent's Gemini image endpoint uses inline parts rather than Images multipart. */
export const iagentGeminiImages: ProviderImages = {
  async generateImages(model, context, options) {
    const result: AssistantImages = {
      api: model.api, provider: model.provider, model: model.id,
      output: [], stopReason: "stop", timestamp: Date.now(),
    };
    try {
      options?.signal?.throwIfAborted();
      const modelId = model.id.split("/").filter(Boolean).at(-1);
      if (!modelId || !options?.apiKey) throw imageError("IMAGE_AUTH_FAILED");
      const parts = context.input.map((part) => part.type === "text"
        ? { text: part.text }
        : { inlineData: { mimeType: part.mimeType, data: part.data } });
      const response = await (options.fetch ?? fetch)(
        `${IAGENT_ORIGIN}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
        {
          method: "POST", redirect: "error", signal: options.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
            "x-goog-api-key": options.apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ["IMAGE"] },
          }),
        },
      );
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.ok) {
        await response.body?.cancel();
        throw imageError(response.status === 401 || response.status === 403 ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${response.status}`);
      }
      const raw = await boundedBytes(response, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) * 10 + 65536);
      type InlinePart = { inlineData?: { data?: unknown }; inline_data?: { data?: unknown } };
      const data = JSON.parse(Buffer.from(raw).toString("utf8")) as { candidates?: { content?: { parts?: InlinePart[] } }[] };
      for (const candidate of data.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const encoded = (part.inlineData ?? part.inline_data)?.data;
          if (typeof encoded !== "string") continue;
          if (result.output.length >= 10) throw imageError("IMAGE_INVALID_RESPONSE");
          const type = generatedImageType(decodeImageBase64(encoded));
          result.output.push({ type: "image", data: encoded, mimeType: type.mimeType });
        }
      }
      if (!result.output.length) throw imageError("IMAGE_INVALID_RESPONSE");
    } catch (error) {
      result.stopReason = options?.signal?.aborted ? "aborted" : "error";
      result.errorMessage = safeImageError(error);
    }
    return result;
  },
};
