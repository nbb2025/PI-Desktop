import type { IagentAccount, IagentHostCall, IagentSession } from "./account.ts";
import { IagentHttpError } from "./account.ts";
import type { IagentGroup } from "./catalog.ts";
import { validId } from "./catalog.ts";

type Purpose = "chat" | "media";
type Key = {
  id: number;
  name: string;
  group_id?: number;
  group?: { id: number };
  key?: string;
  status: string;
  expires_at?: string | null;
  quota?: number;
  quota_used?: number;
};
type KeyPage = { items: Key[]; pages?: number; total?: number; page_size?: number };
type Binding = { id?: number; creating?: boolean };

function unavailable() {
  return new Error("The iAgent workspace key is unavailable. Check its status and quota on iAgent.");
}

function unknownCreation() {
  return new Error("iAgent could not confirm key creation. Check the existing workspace keys on iAgent.");
}

function usable(key: Key, now: number): key is Key & { key: string } {
  return key.status === "active" && typeof key.key === "string" && Boolean(key.key.trim()) &&
    (!key.expires_at || Date.parse(key.expires_at) > now) &&
    (!(typeof key.quota === "number" && key.quota > 0) || (key.quota_used ?? 0) < key.quota);
}

export function createIagentWorkspaceKeys(account: IagentAccount, call: IagentHostCall, now: () => number) {
  const pending = new Map<string, { session: IagentSession; promise: Promise<string> }>();
  const cached = new Map<string, { session: IagentSession; entry: Key; checked: number }>();

  return {
    clear() { cached.clear(); },
    resolve(session: IagentSession, group: IagentGroup, purpose: Purpose, verifyGroup: () => Promise<void>): Promise<string> {
      account.assertSession(session);
      const idempotencyKey = `iagent-workspace-v1-${session.user.id}-${group.id}-${purpose}`;
      const previous = pending.get(idempotencyKey);
      if (previous?.session === session) return previous.promise;
      const promise = (async () => {
        if (previous) await previous.promise.catch(() => undefined);
        const existing = cached.get(idempotencyKey);
        if (existing?.session === session && now() - existing.checked < 30_000 && usable(existing.entry, now())) {
          account.assertSession(session);
          return existing.entry.key;
        }
        const secretRef = `iagent:workspace:${session.user.id}:${group.id}:${purpose}`;
        const { value } = await call<{ value?: string }>("secrets.getForRuntime", { secretRef });
        const saved = value ? JSON.parse(value) as Binding : {};
        const name = purpose === "chat" ? "聊天" : "创意工坊";
        const persist = async (binding: Binding) => {
          account.assertSession(session);
          await call("secrets.set", { secretRef, value: JSON.stringify(binding) });
          account.assertSession(session);
        };
        const belongs = (key: Key) => validId(key?.id) && (key.group_id ?? key.group?.id) === group.id && key.name === name;
        const remember = async (entry: Key) => {
          await persist({ id: entry.id });
          if (!usable(entry, now())) throw unavailable();
          cached.set(idempotencyKey, { session, entry, checked: now() });
          return entry.key;
        };
        if (validId(saved.id)) {
          try {
            const key = await account.authenticated<Key>(session, `/api/v1/keys/${saved.id}`);
            if (belongs(key) && usable(key, now())) return remember(key);
          } catch (error) {
            if (!(error instanceof IagentHttpError) || ![403, 404].includes(error.status)) throw error;
          }
        }
        const matches: Key[] = [];
        let pages = 1;
        for (let page = 1; page <= pages; page++) {
          const result = await account.authenticated<KeyPage>(session, `/api/v1/keys?page=${page}&page_size=100&group_id=${group.id}`);
          if (!Array.isArray(result?.items)) throw new Error("Invalid iAgent workspace key list");
          const pageSize = validId(result.page_size) ? result.page_size : 100;
          pages = Math.max(pages, validId(result.pages) ? result.pages : 1, Math.ceil((result.total ?? 0) / pageSize));
          if (!Number.isSafeInteger(pages) || pages > 1000 || !result.items.length && (pages > 1 || (result.total ?? 0) > 0)) {
            throw new Error("Incomplete iAgent workspace key list");
          }
          matches.push(...result.items.filter(belongs));
        }
        matches.sort((left, right) => left.id - right.id);
        const active = matches.find((key) => usable(key, now()));
        if (active) return remember(active);
        if (matches[0]) return remember(matches[0]);
        if (validId(saved.id)) throw unavailable();
        if (saved.creating) throw unknownCreation();
        await verifyGroup();
        await persist({ creating: true });
        let created: Key;
        try {
          created = await account.authenticated<Key>(session, "/api/v1/keys", { name, group_id: group.id }, idempotencyKey);
        } catch (error) {
          if (error instanceof IagentHttpError && [400, 401, 403, 404, 422].includes(error.status)) {
            await persist({});
            throw error;
          }
          throw unknownCreation();
        }
        if (!belongs(created)) throw unknownCreation();
        return remember(created);
      })();
      pending.set(idempotencyKey, { session, promise });
      void promise.finally(() => {
        if (pending.get(idempotencyKey)?.promise === promise) pending.delete(idempotencyKey);
      }).catch(() => undefined);
      return promise;
    },
  };
}
