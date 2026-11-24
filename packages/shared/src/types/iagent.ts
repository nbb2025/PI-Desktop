import type { SessionThinkingLevel, ThinkingLevel } from "./models.js";

export const IAGENT_ORIGIN = "https://ai.iagent.dev";

/** A pre-match session may have saved off before it had a reasoning ladder. */
export function iagentThinkingLevel(level: SessionThinkingLevel, supported: readonly ThinkingLevel[]): SessionThinkingLevel {
  return level === "off" && supported.length > 0 && !supported.includes("off") ? "omit" : level;
}

/** Standard iAgent chat prices after the signed-in account's group rate. */
export type IagentChatPrice = {
  source: "effective" | "reference";
  unit: "million-tokens" | "request";
  tiers: Array<{
    label?: string;
    minTokens?: number;
    maxTokens?: number | null;
    input?: number;
    output?: number;
    request?: number;
  }>;
};

export type IagentImageSelection = {
  accountId: number;
  groupId: number;
  model: string;
};

export type IagentImageOption = { groupId: number; group: string; model: string };

export type IagentStatus = {
  account?: { id: number; email: string };
  sync: "idle" | "ready" | "stale" | "expired";
  syncedAt?: number;
  groups: { id: string; name: string; models: number }[];
  image?: { group: string; model: string };
  imageModels?: IagentImageOption[];
};

export type IagentLoginResult =
  | { requiresTwoFactor: true; challengeId: string }
  | { requiresTwoFactor: false; status: IagentStatus };

export type IagentUpdate = { status: IagentStatus; catalogChanged: boolean };
