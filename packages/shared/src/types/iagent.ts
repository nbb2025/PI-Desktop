export const IAGENT_ORIGIN = "https://ai.iagent.dev";

export type IagentStatus = {
  account?: { id: number; email: string };
  sync: "idle" | "ready" | "stale" | "expired";
  syncedAt?: number;
  groups: { id: string; name: string; models: number }[];
  image?: { group: string; model: string };
};

export type IagentLoginResult =
  | { requiresTwoFactor: true; challengeId: string }
  | { requiresTwoFactor: false; status: IagentStatus };

export type IagentUpdate = { status: IagentStatus; catalogChanged: boolean };
