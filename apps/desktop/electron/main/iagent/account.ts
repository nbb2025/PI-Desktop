import { randomUUID } from "node:crypto";
import { IAGENT_ORIGIN } from "@pi-desktop/shared";
import { validId } from "./catalog.ts";

export type IagentHostCall = <T>(method: string, params?: unknown) => Promise<T>;

export type IagentSession = {
  user: { id: number; email: string };
  access: string;
  refresh?: string;
  expiresAt: number;
  expired?: boolean;
};

type AuthResponse = {
  user?: IagentSession["user"];
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  requires_2fa?: boolean;
  temp_token?: string;
};

export class IagentHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`iAgent request failed (HTTP ${status})`);
    this.status = status;
  }
}

const sessionRef = "iagent:desktop:session";

export class IagentAccount {
  private readonly call: IagentHostCall;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly language: () => string;
  private stored?: IagentSession;
  private loaded?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private challenge?: { id: string; token: string; expiresAt: number };

  constructor(options: { call: IagentHostCall; fetchImpl?: typeof fetch; now?: () => number; language: () => string }) {
    this.call = options.call;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.language = options.language;
  }

  async session(): Promise<IagentSession | undefined> {
    if (!this.loaded) {
      this.loaded = this.call<{ value?: string }>("secrets.getForRuntime", { secretRef: sessionRef }).then(({ value }) => {
        if (!value) return;
        const saved = JSON.parse(value) as IagentSession;
        if (validId(saved?.user?.id) && typeof saved.user.email === "string" &&
          typeof saved.access === "string" && saved.access && Number.isFinite(saved.expiresAt) &&
          (saved.refresh === undefined || typeof saved.refresh === "string")) {
          this.stored = { ...saved, user: { id: saved.user.id, email: saved.user.email } };
        }
      }).catch((error: unknown) => {
        this.loaded = undefined;
        throw error;
      });
    }
    await this.loaded;
    return this.stored;
  }

  assertSession(session: IagentSession) {
    if (this.stored !== session || session.expired) throw new Error("iAgent account changed or expired");
  }

  login(email: unknown, password: unknown) {
    return this.exclusive(async () => {
      const session = await this.session();
      if (session && !session.expired) throw new Error("Disconnect the active iAgent account first");
      if (typeof email !== "string" || !email.trim() || email.length > 320 ||
        typeof password !== "string" || !password || password.length > 4096) throw new Error("Invalid iAgent credentials");
      this.challenge = undefined;
      const result = await this.request<AuthResponse>("/api/v1/auth/login", { body: { email: email.trim(), password } });
      if (result.requires_2fa) {
        if (!result.temp_token) throw new Error("Invalid iAgent verification challenge");
        const id = randomUUID();
        this.challenge = { id, token: result.temp_token, expiresAt: this.now() + 5 * 60_000 };
        return { requiresTwoFactor: true as const, challengeId: id };
      }
      await this.save(this.authResponse(result));
      return { requiresTwoFactor: false as const };
    });
  }

  confirm(challengeId: unknown, code: unknown) {
    return this.exclusive(async () => {
      const challenge = this.challenge;
      if (!challenge || challenge.id !== challengeId || challenge.expiresAt <= this.now() ||
        typeof code !== "string" || !/^\d{6}$/.test(code.trim())) throw new Error("Invalid iAgent verification request");
      const result = await this.request<AuthResponse>("/api/v1/auth/login/2fa", {
        body: { temp_token: challenge.token, totp_code: code.trim() },
      });
      await this.save(this.authResponse(result));
      this.challenge = undefined;
    });
  }

  logout() {
    return this.exclusive(async () => {
      const session = await this.session();
      await this.call("secrets.delete", { secretRef: sessionRef });
      this.stored = undefined;
      this.challenge = undefined;
      // Local sign-out also succeeds when the remote revocation endpoint is offline.
      if (session?.refresh) {
        void this.request("/api/v1/auth/logout", { body: { refresh_token: session.refresh } }).catch(() => undefined);
      }
    });
  }

  catalog(force: boolean) {
    return this.request<unknown>(`/site-api/models${force ? "?refresh=1" : ""}`, { envelope: false });
  }

  async authenticated<T>(session: IagentSession, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const access = await this.access(session);
    this.assertSession(session);
    let result: T;
    try {
      result = await this.request<T>(path, { token: access, body, idempotencyKey });
    } catch (error) {
      if (!(error instanceof IagentHttpError) || error.status !== 401) throw error;
      const renewed = await this.access(session, access);
      this.assertSession(session);
      result = await this.request<T>(path, { token: renewed, body, idempotencyKey });
    }
    this.assertSession(session);
    return result;
  }

  private authResponse(result: AuthResponse, original?: IagentSession): IagentSession {
    const user = result.user ?? original?.user;
    if (!user || !validId(user.id) || typeof user.email !== "string" ||
      original && original.user.id !== user.id ||
      typeof result.access_token !== "string" || !result.access_token ||
      result.refresh_token != null && typeof result.refresh_token !== "string") throw new Error("Invalid iAgent session response");
    const expiresIn = validId(result.expires_in) ? result.expires_in : 3600;
    return {
      user: { id: user.id, email: user.email },
      access: result.access_token, refresh: result.refresh_token ?? original?.refresh,
      expiresAt: this.now() + expiresIn * 1000,
    };
  }

  private async save(session: IagentSession, current?: IagentSession) {
    await this.call("secrets.set", { secretRef: sessionRef, value: JSON.stringify(session) });
    if (current) Object.assign(current, session);
    else this.stored = session;
  }

  private access(session: IagentSession, rejected?: string) {
    this.assertSession(session);
    if (session.access !== rejected && session.expiresAt - this.now() > 60_000) return Promise.resolve(session.access);
    return this.exclusive(async () => {
      this.assertSession(session);
      if (session.access !== rejected && session.expiresAt - this.now() > 60_000) return session.access;
      if (!session.refresh) {
        if (!rejected && session.expiresAt > this.now()) return session.access;
        session.expired = true;
        throw new Error("iAgent session expired");
      }
      try {
        const result = await this.request<AuthResponse>("/api/v1/auth/refresh", {
          body: { refresh_token: session.refresh },
        });
        await this.save(this.authResponse(result, session), session);
        return session.access;
      } catch (error) {
        if (error instanceof IagentHttpError && [400, 401, 403].includes(error.status)) session.expired = true;
        throw error;
      }
    });
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async request<T>(path: string, options: {
    envelope?: boolean; token?: string; body?: unknown; idempotencyKey?: string;
  } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "Accept-Language": this.language() };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    const response = await this.fetchImpl(`${IAGENT_ORIGIN}${path}`, {
      headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
      method: options.body === undefined ? "GET" : "POST",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new IagentHttpError(response.status);
    }
    const payload: unknown = await response.json();
    if (options.envelope === false) return payload as T;
    const envelope = payload as { code?: number; data?: T } | null;
    if (envelope?.code !== 0) throw new Error("iAgent request was rejected");
    return envelope.data as T;
  }
}
