import type { IagentChatPrice } from "@pi-desktop/shared";
import type { IagentCatalogModel, IagentGroup } from "./catalog.ts";

type RecordValue = Record<string, unknown>;
type ChannelQuote = { pricing: RecordValue; intervals: RecordValue[] };
type PriceTier = IagentChatPrice["tiers"][number];

function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.flatMap<RecordValue>((item: unknown) => object(item) ?? []) : [];
}

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function name(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/^\/+/, "");
  return normalized.includes("/models/")
    ? normalized.slice(normalized.lastIndexOf("/models/") + "/models/".length)
    : normalized.replace(/^models\//, "");
}

function platform(value: unknown) {
  const key = name(value);
  return key === "claude" ? "anthropic" : key;
}

function channelKey(groupId: number, platformName: string, model: string) {
  return JSON.stringify([groupId, platformName, model]);
}

function quotation(value: unknown): ChannelQuote | undefined {
  const pricing = object(value);
  if (!pricing) return undefined;
  const intervals = rows(pricing.intervals).sort((a, b) => (amount(a.min_tokens) ?? 0) - (amount(b.min_tokens) ?? 0));
  return { pricing, intervals };
}

export function indexIagentPrices(ratesPayload: unknown, plazaPayload: unknown, channelPayload: unknown) {
  const rates = object(ratesPayload);
  const plazaGroups = new Map<number, RecordValue>();
  const channels = new Map<string, ChannelQuote[]>();
  for (const group of rows(object(plazaPayload)?.groups)) {
    if (typeof group.id === "number" && Array.isArray(group.models)) plazaGroups.set(group.id, group);
  }
  for (const section of rows(channelPayload).flatMap((channel) => rows(channel.platforms))) {
    const platformName = platform(section.platform);
    for (const model of rows(section.supported_models)) {
      const quote = quotation(model.pricing);
      if (!quote) continue;
      const names = new Set([model.id, model.name, model.model, model.model_name].map(name).filter(Boolean));
      const scoped = Array.isArray(model.group_ids) ? model.group_ids.filter((id: unknown) => typeof id === "number") : [];
      const groupIds = scoped.length ? scoped : typeof model.group_id === "number"
        ? [model.group_id] : rows(section.groups).map((group) => group.id);
      for (const id of groupIds) {
        if (typeof id !== "number") continue;
        for (const modelName of names) {
          const key = channelKey(id, platformName, modelName);
          const existing = channels.get(key);
          if (existing) existing.push(quote);
          else channels.set(key, [quote]);
        }
      }
    }
  }
  return { rates, plazaGroups, channels };
}

export type IagentPrices = ReturnType<typeof indexIagentPrices>;

export function iagentGroupRate(group: IagentGroup, prices?: IagentPrices): number | undefined {
  const quote = prices?.plazaGroups.get(group.id);
  return amount(quote?.user_rate_multiplier) ?? amount(prices?.rates?.[String(group.id)]) ??
    amount(group.user_rate_multiplier) ?? amount(quote?.rate_multiplier) ?? amount(group.rate_multiplier);
}

const tokenFields = ["input_price", "output_price", "cache_write_price", "cache_read_price",
  "image_input_price", "image_output_price"] as const;

function channelRank({ pricing, intervals }: ChannelQuote, defaults: RecordValue | undefined) {
  const mode = name(pricing.billing_mode);
  const override = mode && mode !== "token" || amount(pricing.per_request_price) !== undefined ||
    intervals.some((tier) => amount(tier.per_request_price) !== undefined);
  const changed = tokenFields.filter((field) => {
    const value = amount(pricing[field]);
    const base = amount(defaults?.[field]);
    return value !== undefined && (base === undefined || Math.abs(value - base) > Math.max(1e-15, base * 1e-9));
  }).length;
  const complete = tokenFields.filter((field) => amount(pricing[field]) !== undefined).length + intervals.length * 2;
  return [override ? 100 : changed * 10, complete];
}

function plazaModel(group: RecordValue | undefined, names: string[], platformName: string) {
  const models = rows(group?.models);
  for (const id of names) {
    const matches = models.filter((model) => name(model.name) === id);
    if (!matches.length) continue;
    return matches.find((model) => platform(model.platform) === platformName) ??
      (platformName === "composite" && matches.length === 1 ? matches[0] : undefined);
  }
  return undefined;
}

function tierInfo(interval: RecordValue | undefined): PriceTier {
  if (!interval) return {};
  const label = typeof interval.tier_label === "string" ? interval.tier_label.trim() : "";
  const min = amount(interval.min_tokens);
  const max = amount(interval.max_tokens);
  return {
    ...(label ? { label } : {}),
    ...(min === undefined ? {} : { minTokens: min }),
    ...(max === undefined && interval.max_tokens !== null ? {} : { maxTokens: max ?? null }),
  };
}

function pricedTiers(quote: ChannelQuote, rate: number, longContext: boolean) {
  const { pricing, intervals } = quote;
  const mode = name(pricing.billing_mode);
  if (mode && mode !== "token" && mode !== "per_request") return undefined;
  const unit = mode === "per_request" ? "request" as const : "million-tokens" as const;
  const selected = longContext || unit === "request" ? intervals : intervals.slice(0, 1);
  const tiers = (selected.length ? selected : [undefined]).flatMap<PriceTier>((interval) => {
    const info = tierInfo(interval);
    if (unit === "request") {
      const perRequest = amount(interval?.per_request_price) ?? amount(pricing.per_request_price);
      const request = perRequest === undefined ? undefined : amount(perRequest * rate);
      return request === undefined ? [] : [{ ...info, request }];
    }
    const scale = (field: "input" | "output") => {
      const base = amount(pricing[`${field}_price`]);
      const factor = amount(interval?.[`${field}_multiplier`]) || 1;
      const value = amount(interval?.[`${field}_price`]) ?? (base === undefined ? undefined : base * factor);
      return value === undefined ? undefined : amount(value * 1_000_000 * rate);
    };
    const input = scale("input");
    const output = scale("output");
    return input === undefined && output === undefined ? [] : [{ ...info, input, output }];
  });
  return tiers.length ? { tiers, unit } : undefined;
}

export function iagentChatPrice(
  group: IagentGroup,
  model: IagentCatalogModel,
  rate: number | undefined,
  priceUnit: string | undefined,
  prices?: IagentPrices,
): IagentChatPrice | undefined {
  if (rate === undefined) return undefined;
  const names = [...new Set([name(model.id), name(model.name)].filter(Boolean))];
  const platformName = platform(model.platform ?? group.platform);
  const plaza = prices?.plazaGroups.get(group.id);
  const effective = plazaModel(plaza, names, platformName);
  const longContext = (plaza?.long_context_pricing_enabled ?? group.long_context_pricing_enabled) !== false;
  if (effective) {
    const quote = quotation(effective.pricing);
    const computed = quote && pricedTiers(quote, rate, longContext);
    return computed && { ...computed, source: "effective" };
  }

  const defaults = object(model.default_pricing);
  const candidates = names.flatMap((id) => prices?.channels.get(channelKey(group.id, platformName, id)) ?? []);
  const ranked = candidates.map((quote) => ({ quote, rank: channelRank(quote, defaults) }));
  ranked.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1]);
  const channel = ranked[0]?.quote;
  const computed = (channel && pricedTiers(channel, rate, longContext)) ??
    (defaults?.found === true && priceUnit === "USD/token"
      ? pricedTiers({ pricing: defaults, intervals: [] }, rate, false) : undefined);
  return computed && { ...computed, source: "reference" };
}
