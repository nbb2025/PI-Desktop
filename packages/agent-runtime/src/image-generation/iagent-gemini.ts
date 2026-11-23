import type { AssistantImages, ProviderImages } from "@earendil-works/pi-ai";
import { generatedImageType, imageError, type ImageDownloadOptions } from "./download.js";
import { requestIagentImage } from "./iagent-tasks.js";
import { decodeImageBase64, imageSourceBytes, safeImageError } from "./openai-images.js";

export const IAGENT_GEMINI_IMAGES_API = "pi-desktop-iagent-gemini-images";

/** iAgent's Gemini image endpoint uses inline parts rather than Images multipart. */
export function iagentGeminiImages(downloads: ImageDownloadOptions): ProviderImages {
  return {
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
        const signal = options.signal ?? new AbortController().signal;
        const { response, payload, taskId } = await requestIagentImage({
          route: "gemini", model: modelId,
          syncPath: `/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
          headers: new Headers({
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
            "x-goog-api-key": options.apiKey,
          }),
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ["IMAGE"] },
          }),
          signal,
          fetchImpl: options.fetch ?? fetch,
        });
        if (taskId) result.responseId = taskId;
        await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
        type ImagePart = { data?: unknown; url?: unknown };
        type InlinePart = { inlineData?: ImagePart; inline_data?: ImagePart };
        const data = payload as { candidates?: { content?: { parts?: InlinePart[] } }[] };
        for (const candidate of data.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            const { data: encoded, url } = part.inlineData ?? part.inline_data ?? {};
            if (typeof encoded !== "string" && typeof url !== "string") continue;
            if (result.output.length >= 10) throw imageError("IMAGE_INVALID_RESPONSE");
            const bytes = typeof url === "string" && typeof encoded !== "string"
              ? await imageSourceBytes(url, signal, {
                  ...downloads, fetchImpl: downloads.fetchImpl ?? options.fetch,
                })
              : decodeImageBase64(typeof encoded === "string" ? encoded : "");
            const type = generatedImageType(bytes);
            result.output.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type.mimeType });
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
}
