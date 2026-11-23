import { IAGENT_ORIGIN, IMAGE_GENERATION_TIMEOUT_MS } from "@pi-desktop/shared";
import { boundedBytes, imageError, MAX_IMAGE_BYTES } from "./download.js";

/** The website gives the upstream 30 minutes, followed by result publication. */
export const IAGENT_IMAGE_TIMEOUT_MS = 31 * 60_000;
const readTimeout = 20_000;
const sendTimeout = 60_000;
const maxResultBytes = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) * 10 + 65536;
const terminalSuccess = new Set(["completed", "complete", "done", "succeeded", "success"]);
const terminalFailure = new Set(["failed", "error", "cancelled", "canceled", "expired"]);
const noAsyncRoute = new Set([404, 405, 501]);

type ImageRoute = "openai-generation" | "openai-edit" | "gemini" | "grok-generation" | "grok-edit";
type TaskPayload = Record<string, unknown>;
type ImageSubmission = {
  route: ImageRoute;
  model: string;
  syncPath: string;
  headers: Headers;
  body: BodyInit;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
};

function object(payload: unknown): TaskPayload | undefined {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as TaskPayload : undefined;
}

async function readPayload(response: Response, limit = maxResultBytes): Promise<TaskPayload> {
  const raw = await boundedBytes(response, limit);
  try {
    const value = object(JSON.parse(Buffer.from(raw).toString("utf8")));
    if (value) return value.code === 0 ? object(value.data) ?? value : value;
  } catch {
    throw imageError("IMAGE_INVALID_RESPONSE");
  }
  throw imageError("IMAGE_INVALID_RESPONSE");
}

function statusError(status: number) {
  return imageError(status === 401 || status === 403 ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${status}`);
}

function transient(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfter(response: Response, fallback = 3000) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : fallback;
}

function waitToPoll(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function taskResult(task: TaskPayload): TaskPayload {
  let result = task.result;
  if (typeof result === "string") {
    try { result = JSON.parse(result) as unknown; }
    catch { throw imageError("IMAGE_INVALID_RESPONSE"); }
  }
  const payload = object(result);
  if (payload) return payload;
  if (typeof task.image_url === "string") return { data: [{ url: task.image_url }] };
  throw imageError("IMAGE_INVALID_RESPONSE");
}

export async function requestIagentImage({
  route, model, syncPath, headers, body, signal, fetchImpl,
}: ImageSubmission): Promise<{ response: Response; payload: TaskPayload; taskId?: string }> {
  const request = (path: string, timeout: number, init?: RequestInit) =>
    fetchImpl(`${IAGENT_ORIGIN}${path}`, {
      ...init,
      method: init?.method ?? "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });

  const config = await request("/site-api/image-config", readTimeout);
  let asyncEnabled = false;
  if (config.ok) {
    asyncEnabled = (await readPayload(config, 65_536)).async_enabled === true;
  } else {
    await config.body?.cancel();
    if (config.status !== 404) throw statusError(config.status);
  }

  const post = async (path: string, timeout: number) => {
    signal.throwIfAborted();
    try {
      return await request(path, timeout, { method: "POST", headers, body });
    } catch {
      signal.throwIfAborted();
      throw imageError("IMAGE_SUBMISSION_UNKNOWN");
    }
  };

  if (asyncEnabled) {
    headers.set("X-Iagent-Image-Route", route);
    headers.set("X-Iagent-Image-Model", model);
    const openai = route === "openai-generation" || route === "openai-edit";
    const asyncPath = openai ? `${syncPath.replace(/^\/v1\//, "/")}/async` : "/site-api/image-tasks";
    const accepted = await post(asyncPath, sendTimeout);
    if (accepted.ok) {
      const task = await readPayload(accepted).catch(() => { throw imageError("IMAGE_SUBMISSION_UNKNOWN"); });
      const id = task.task_id ?? task.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        // Older gateways may still return an immediate image.
        if (Array.isArray(task.data) || Array.isArray(task.candidates)) return { response: accepted, payload: task };
        throw imageError("IMAGE_SUBMISSION_UNKNOWN");
      }
      // Construct the owner-scoped path from the ID. Never forward a key to
      // a response-supplied URL, including a redirect from the same website.
      const path = `/site-api/image-tasks/${id}`;
      const queryHeaders = { Authorization: headers.get("Authorization") ?? "" };
      let payload = task;
      let response = accepted;
      let failures = 0;
      let delay = retryAfter(accepted);
      while (true) {
        const state = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
        if (terminalSuccess.has(state)) return { response, payload: taskResult(payload), taskId: id };
        if (terminalFailure.has(state)) throw imageError("IMAGE_TASK_FAILED");
        await waitToPoll(delay, signal);
        let next: Response | undefined;
        try {
          next = await request(path, readTimeout, { headers: queryHeaders });
        } catch {
          signal.throwIfAborted();
        }
        if (!next || transient(next.status)) {
          await next?.body?.cancel();
          if (++failures >= 5) throw imageError("IMAGE_TASK_QUERY_INTERRUPTED");
          delay = Math.min(delay * 2, 30_000);
          continue;
        }
        if (!next.ok) {
          await next.body?.cancel();
          throw statusError(next.status);
        }
        payload = await readPayload(next);
        if ((payload.task_id ?? payload.id) !== id) throw imageError("IMAGE_INVALID_RESPONSE");
        response = next;
        failures = 0;
        delay = retryAfter(response);
      }
    }
    await accepted.body?.cancel();
    if (!openai || !noAsyncRoute.has(accepted.status)) {
      throw transient(accepted.status) ? imageError("IMAGE_SUBMISSION_UNKNOWN") : statusError(accepted.status);
    }
    headers.delete("X-Iagent-Image-Route");
    headers.delete("X-Iagent-Image-Model");
  }

  const response = await post(syncPath, IMAGE_GENERATION_TIMEOUT_MS);
  if (!response.ok) {
    await response.body?.cancel();
    throw transient(response.status) ? imageError("IMAGE_SUBMISSION_UNKNOWN") : statusError(response.status);
  }
  return { response, payload: await readPayload(response) };
}
