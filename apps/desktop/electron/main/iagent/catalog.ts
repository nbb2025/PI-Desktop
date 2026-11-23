import {
  IAGENT_ORIGIN,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";

export type IagentGroup = {
  id: number;
  name: string;
  platform: string;
  status: string;
  claude_code_only?: boolean;
};

export type IagentCatalogModel = {
  id: string;
  name?: string;
  group_id: number;
  platform?: string;
  context_length?: number;
  max_output_tokens?: number;
};

type SortRule = {
  pattern: string;
  strategy?: string;
  keywords?: string[];
};

export type IagentCatalog = {
  models: IagentCatalogModel[];
  group_order?: number[];
  sort_rules?: SortRule[];
};

export type IagentImageModel = {
  group: IagentGroup;
  model: string;
  protocol: "openai" | "gemini" | "grok";
};

const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const videoGroup = new Set(["bailian", "video-lt", "video", "seedance", "deepwl"]);
const geminiGroup = new Set(["gemini", "google", "antigravity"]);
const grokGroup = new Set(["grok", "xai", "x-ai"]);
const imageName = /gpt[-_. ]?image|dall[-_. ]?e|imagegen|imagen|image[-_. ]?(?:preview|generation)|(?:flash|pro)[-_. ]image|nano[-_. ]?banana|stable[-_. ]?diffusion|midjourney|\bflux(?:[-_. ]|$)|seedream|ideogram|qwen[-_. ]?image|grok[-_. ]?imagine/i;
const videoName = /grok[-_. ]?imag(?:ine|en)[-_. ]?video|\b(?:sora|veo|seedance|wan[23](?:[._-]\d+)?[-_. ]video|sd-2[^ ]*-(?:480|720|1080)|minimax-h3|video[-_. ]generation)\b/i;
const excluded = /auto[\s._-]*review|embed(?:ding)?|rerank|whisper|transcri|moderation|\btts\b|\bspeech\b/i;
const providerPrefix = "iagent:";

export function isIagentProvider(id: string): boolean {
  return id.startsWith(providerPrefix);
}

export function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function platform(value?: string): string { return value?.trim().toLowerCase() ?? ""; }

function label(model: IagentCatalogModel): string {
  return model.name?.trim() || model.id;
}

function keyword(value: string) {
  return value.trim().toLowerCase().split(/[-._/\s]+/u).filter(Boolean).join("-");
}

function version(value: string): number[] {
  const id = (value.split("/").at(-1) ?? value).replace(/[-._]20\d{2}(?:[.-]\d{2}[.-]\d{2}|\d{4})(?=$|[-._]).*$/, "");
  return id.match(/(?:^|[\p{L}_.-])(\d{1,3}(?:[.-]\d{1,3})*)(?=$|[-._])/u)?.[1]?.split(/[.-]/).map(Number) ?? [];
}

function compareVersion(left: number[], right: number[]): number {
  if (!left.length || !right.length) return Number(Boolean(right.length)) - Number(Boolean(left.length));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function orderedIagentModels(models: IagentCatalogModel[], rules: readonly SortRule[]) {
  const ranked = models.map((model) => {
    const id = model.id.toLowerCase();
    const rule = rules.findIndex(({ pattern }) => {
      const term = pattern.trim().toLowerCase();
      return term.endsWith("*") ? id.startsWith(term.slice(0, -1)) : id === term;
    });
    const keys = rules[rule]?.keywords?.map(keyword).filter(Boolean) ?? [];
    const tier = keys.findIndex((key) => `-${keyword(id)}-`.includes(`-${key}-`));
    return { model, rank: rule < 0 ? rules.length : rule, tier: tier < 0 ? keys.length : tier, version: version(id) };
  });
  return ranked.sort((left, right) => {
    const strategy = rules[left.rank]?.strategy;
    const tier = left.tier - right.tier;
    const byVersion = compareVersion(left.version, right.version);
    const ruleOrder = strategy === "tier-version" ? tier || byVersion
      : strategy === "version-tier" ? byVersion || tier : strategy === "version" ? byVersion : 0;
    return left.rank - right.rank || ruleOrder || naturalOrder.compare(label(right.model), label(left.model))
      || naturalOrder.compare(right.model.id, left.model.id);
  }).map(({ model }) => model);
}

function imageProtocol(group: IagentGroup, model: IagentCatalogModel): IagentImageModel["protocol"] | null {
  const value = `${model.id} ${model.name ?? ""}`;
  if (!imageName.test(value)) return null;
  const route = platform(group.platform);
  if (geminiGroup.has(route) || /^(?:models\/)?(?:gemini-|nano[-_. ]?banana)/i.test(model.id)) return "gemini";
  if (grokGroup.has(route) || /^grok[-_. ]?imagine/i.test(model.id)) {
    // The desktop Images operation supports this family's generation/edit wire, not image output from Grok chat.
    return /grok[-_. ]?imagine[-_. ]?(?:image|edit)/i.test(model.id) ? "grok" : null;
  }
  if (route === "openai" || /^(?:gpt[-_. ]?image|dall[-_. ]?e)/i.test(model.id)) return "openai";
  return null;
}

function chatRoute(group: IagentGroup) {
  switch (platform(group.platform)) {
    case "anthropic":
    case "claude":
      return { vendorKey: "anthropic", baseUrl: IAGENT_ORIGIN, apiStyle: "anthropic_messages" };
    case "gemini":
    case "google":
    case "antigravity":
      return { vendorKey: "google", baseUrl: `${IAGENT_ORIGIN}/v1beta`, apiStyle: "google_generative_ai" };
    case "openai":
      return { vendorKey: "openai", baseUrl: `${IAGENT_ORIGIN}/v1`, apiStyle: "responses" };
    default:
      return { vendorKey: "custom", baseUrl: `${IAGENT_ORIGIN}/v1`, apiStyle: "chat_completions" };
  }
}

function binding(model: IagentCatalogModel): ModelBinding {
  return {
    id: model.id,
    alias: model.name || undefined,
    contextWindow: validId(model.context_length) ? model.context_length : 0,
    contextWindowSource: validId(model.context_length) ? "user" : "catalog",
    maxTokens: validId(model.max_output_tokens) ? model.max_output_tokens : 0,
    maxTokensSource: validId(model.max_output_tokens) ? "user" : "catalog",
    thinkingLevels: [],
    defaultThinkingLevel: null,
  };
}

export function projectIagentCatalog(owner: number, groups: readonly IagentGroup[], catalog: IagentCatalog, time: number) {
  const positions = new Map((catalog.group_order ?? []).map((id, index) => [id, index]));
  const visible = groups.filter((group) => group.status === "active" && !videoGroup.has(platform(group.platform)));
  const routes = new Map<string, IagentGroup>();
  const providers: ProviderPublic[] = [];
  const images: IagentImageModel[] = [];
  const date = new Date(time).toISOString();
  for (const group of visible.sort((left, right) =>
    (positions.get(left.id) ?? Infinity) - (positions.get(right.id) ?? Infinity) ||
    naturalOrder.compare(right.name, left.name) || left.id - right.id)) {
    const seen = new Set<string>();
    const chat: ModelBinding[] = [];
    for (const model of orderedIagentModels(catalog.models.filter((entry) => entry.group_id === group.id), catalog.sort_rules ?? [])) {
      const value = `${model.id} ${model.name ?? ""}`;
      const identity = model.id.toLowerCase();
      if (seen.has(identity) || excluded.test(value) || videoGroup.has(platform(model.platform)) || videoName.test(value)) continue;
      seen.add(identity);
      const protocol = imageProtocol(group, model);
      if (protocol) images.push({ group, model: model.id, protocol });
      if (!group.claude_code_only && !imageName.test(value)) chat.push(binding(model));
    }
    if (!chat.length) continue;
    const id = `${providerPrefix}${owner}:${group.id}`;
    const route = chatRoute(group);
    routes.set(id, group);
    providers.push({
      id, name: group.name, ...route, type: "openai_compatible", protocol: route.apiStyle, authKind: "api_key",
      enabled: true, managedBy: "iagent", hasSecret: true, models: chat,
      supportsReasoning: false, supportedThinkingLevels: ["off"], createdAt: date, updatedAt: date,
    });
  }
  return { routes, providers, images };
}

export function parseIagentGroups(value: unknown): IagentGroup[] {
  if (!Array.isArray(value) || value.some((group) => !group || !validId(group.id) ||
    typeof group.name !== "string" || typeof group.platform !== "string" || typeof group.status !== "string")) {
    throw new Error("Invalid iAgent group catalog");
  }
  return value;
}

export function parseIagentCatalog(value: unknown): IagentCatalog {
  const catalog = value as IagentCatalog | null;
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.some((model) =>
    !model || !validId(model.group_id) || typeof model.id !== "string" || !model.id.trim() ||
    model.name != null && typeof model.name !== "string" ||
    model.platform != null && typeof model.platform !== "string") ||
    catalog.group_order != null && (!Array.isArray(catalog.group_order) || !catalog.group_order.every(validId)) ||
    catalog.sort_rules != null && (!Array.isArray(catalog.sort_rules) || catalog.sort_rules.some((rule) =>
      !rule || typeof rule.pattern !== "string" || rule.keywords != null &&
        (!Array.isArray(rule.keywords) || rule.keywords.some((term) => typeof term !== "string"))))) {
    throw new Error("Invalid iAgent model catalog");
  }
  return catalog;
}
