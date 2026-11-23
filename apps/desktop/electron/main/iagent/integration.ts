import {
  ErrorCodes, IAGENT_ORIGIN, type IagentLoginResult, type IagentStatus, type IagentUpdate,
} from "@pi-desktop/shared";
import { IagentAccount, type IagentHostCall, type IagentSession } from "./account.ts";
import {
  type IagentCatalog, type IagentGroup, type IagentImageModel, isIagentProvider, parseIagentCatalog, parseIagentGroups, projectIagentCatalog,
} from "./catalog.ts";
import { createIagentWorkspaceKeys } from "./workspace-keys.ts";

const refreshInterval = 60_000;
const accessAge = 30_000;
const nowDefault = Date.now;
type Projection = ReturnType<typeof projectIagentCatalog>;
type Snapshot = {
  session: IagentSession;
  catalog: IagentCatalog;
  groups: IagentGroup[];
  projection: Projection;
  accessAt: number;
  syncedAt?: number;
  stale: boolean;
};

function modelUnavailable() {
  return Object.assign(new Error("This iAgent model is no longer available. Select a model from an active group."), {
    errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
  });
}

function defaultImage(images: readonly IagentImageModel[], edit = false) {
  return images.find((image) => /^gpt[-_. ]?image/i.test(image.model)) ??
    images.find((image) => image.protocol !== "grok" || /grok[-_. ]?imagine[-_. ]?edit/i.test(image.model) === edit);
}

export function createIagentIntegration(options: {
  call: IagentHostCall;
  language: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onChange?: (update: IagentUpdate) => void;
}) {
  const now = options.now ?? nowDefault;
  const account = new IagentAccount(options);
  const keys = createIagentWorkspaceKeys(account, options.call, now);
  let snapshot: Snapshot | undefined;
  let pending: { session: IagentSession; promise: Promise<void> } | undefined;
  let attemptedAt = -Infinity;
  let catalogVersion = "";

  function publicStatus(session: IagentSession | undefined): IagentStatus {
    const current = snapshot?.session === session && !session?.expired ? snapshot : undefined;
    const image = defaultImage(current?.projection.images ?? []);
    return {
      account: session?.user,
      sync: session?.expired ? "expired" : current?.stale ? "stale" : current?.syncedAt !== undefined ? "ready" : "idle",
      syncedAt: current?.syncedAt,
      groups: current?.projection.providers.map((provider) => ({ id: provider.id, name: provider.name, models: provider.models.length })) ?? [],
      image: image && { group: image.group.name, model: image.model },
    };
  }

  function publish(session: IagentSession | undefined) {
    const projection = snapshot?.session === session && !session?.expired ? snapshot?.projection : undefined;
    const updated = JSON.stringify(projection?.providers.map(({ id, name, models, apiStyle }) => ({ id, name, models, apiStyle })) ?? []);
    const catalogChanged = updated !== catalogVersion;
    catalogVersion = updated;
    options.onChange?.({ status: publicStatus(session), catalogChanged });
  }

  async function load(session: IagentSession, force: boolean) {
    attemptedAt = now();
    const [membership, published] = await Promise.allSettled([
      account.authenticated<unknown>(session, "/api/v1/groups/available").then(parseIagentGroups),
      account.catalog(force).then(parseIagentCatalog),
    ]);
    const current = await account.session();
    if (current !== session) return;
    if (session.expired) {
      snapshot = undefined;
      keys.clear();
      publish(session);
      return;
    }
    const old = snapshot?.session === session ? snapshot : undefined;
    const groups = membership.status === "fulfilled" ? membership.value : old?.groups ?? [];
    const catalog = membership.status === "fulfilled" && published.status === "fulfilled"
      ? published.value : old?.catalog ?? { models: [] };
    const stale = membership.status !== "fulfilled" || published.status !== "fulfilled";
    snapshot = {
      session, groups, catalog, stale,
      projection: projectIagentCatalog(session.user.id, groups, catalog, now()),
      accessAt: membership.status === "fulfilled" ? now() : old?.accessAt ?? -Infinity,
      syncedAt: stale ? old?.syncedAt : now(),
    };
    publish(session);
  }

  async function refresh(force = false, forDispatch = false): Promise<IagentStatus> {
    const session = await account.session();
    if (!session || session.expired) return publicStatus(session);
    if (force) keys.clear();
    if (pending?.session === session) await pending.promise;
    else if (force || !snapshot || snapshot.session !== session ||
      now() - attemptedAt >= refreshInterval || forDispatch && now() - snapshot.accessAt >= accessAge) {
      const promise = load(session, force);
      pending = { session, promise };
      try { await promise; } finally { if (pending?.promise === promise) pending = undefined; }
    }
    return publicStatus(await account.session());
  }

  async function forDispatch() {
    await refresh(false, true);
    const session = await account.session();
    if (!session || session.expired || snapshot?.session !== session ||
      now() - snapshot.accessAt >= accessAge) return undefined;
    return snapshot;
  }

  async function key(session: IagentSession, group: IagentGroup, purpose: "chat" | "media") {
    return keys.resolve(session, group, purpose, async () => {
      const groups = parseIagentGroups(await account.authenticated(session, "/api/v1/groups/available"));
      if (!groups.some((item) => item.id === group.id && item.status === "active" &&
        item.platform === group.platform && (purpose === "media" || !item.claude_code_only))) throw modelUnavailable();
    });
  }

  return {
    async status() { return publicStatus(await account.session()); },
    refresh,
    async login(input: { email?: unknown; password?: unknown } | undefined): Promise<IagentLoginResult> {
      const result = await account.login(input?.email, input?.password);
      return result.requiresTwoFactor ? result : { requiresTwoFactor: false, status: await refresh(true) };
    },
    async confirm(input: { challengeId?: unknown; code?: unknown } | undefined) {
      await account.confirm(input?.challengeId, input?.code);
      return refresh(true);
    },
    async logout() {
      await account.logout();
      snapshot = undefined;
      keys.clear();
      publish(undefined);
      return publicStatus(undefined);
    },
    providers() {
      return !snapshot?.session.expired ? snapshot?.projection.providers ?? [] : [];
    },
    async resolveChat(providerId: string, selectedModel: string) {
      if (!isIagentProvider(providerId)) throw modelUnavailable();
      const current = await forDispatch();
      const group = current?.projection.routes.get(providerId);
      const provider = current?.projection.providers.find(({ id }) => id === providerId);
      const model = provider?.models.find(({ id }) => id.toLowerCase() === selectedModel.toLowerCase());
      if (!current || !group || !provider || !model) throw modelUnavailable();
      const value = await key(current.session, group, "chat");
      account.assertSession(current.session);
      const latest = snapshot?.projection.providers.find(({ id }) => id === providerId);
      if (!latest || latest.apiStyle !== provider.apiStyle || !latest.models.some(({ id }) => id === model.id)) throw modelUnavailable();
      return { provider: latest, modelId: model.id, value };
    },
    modelChoices(providerId: string) {
      const provider = snapshot?.projection.providers.find(({ id }) => id === providerId);
      if (!provider || snapshot?.session.expired) return [];
      return provider.models.map((binding) => ({
        modelId: binding.id,
        displayName: binding.alias || binding.id,
        providerId,
        contextWindow: binding.contextWindow || undefined,
        maxTokens: binding.maxTokens || undefined,
        capabilities: ["text" as const],
        discoveryState: "published" as const,
      }));
    },
    async imageEndpoint(edit: boolean) {
      const current = await forDispatch();
      const selected = defaultImage(current?.projection.images ?? [], edit);
      if (!current || !selected) return undefined;
      const { group, model, protocol } = selected;
      const apiKey = await key(current.session, group, "media");
      const assertCurrent = () => {
        account.assertSession(current.session);
        if (!snapshot?.projection.images.some((image) => image.group.id === group.id && image.model === model &&
          image.protocol === protocol)) throw modelUnavailable();
      };
      assertCurrent();
      return {
        endpoint: {
          providerId: `iagent-image:${current.session.user.id}:${group.id}`,
          vendorKey: "iagent", baseUrl: `${IAGENT_ORIGIN}/v1`, modelId: model, apiKey, authKind: "api_key",
          iagentProtocol: protocol,
        },
        assertCurrent,
      };
    },
  };
}

export type IagentIntegration = ReturnType<typeof createIagentIntegration>;
