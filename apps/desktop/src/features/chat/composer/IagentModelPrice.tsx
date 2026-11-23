import { formatTokenCount, type IagentChatPrice } from "@pi-desktop/shared";
import type { TFunction } from "i18next";

function tierName(tier: IagentChatPrice["tiers"][number]) {
  if (tier.label) return tier.label;
  if (tier.minTokens === undefined) return "";
  const min = tier.minTokens === 0 ? "0" : formatTokenCount(tier.minTokens);
  return tier.maxTokens == null ? `${min}+` : `${min}–${formatTokenCount(tier.maxTokens)}`;
}

export function IagentModelPrice({
  t, price,
}: { t: TFunction; price?: IagentChatPrice }) {
  if (!price?.tiers.length) {
    return <span className="composer-iagent-price">{t("chat.iagentPriceUnavailable")}</span>;
  }
  const currency = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumSignificantDigits: 6,
  });
  const money = (value: number | undefined) => value === undefined ? "—" : currency.format(value);
  const describe = ({ input, output, request }: IagentChatPrice["tiers"][number]) =>
    price.unit === "request"
      ? t("chat.iagentPricePerRequest", { price: money(request) })
      : t("chat.iagentTokenPrice", { input: money(input), output: money(output) });
  const qualifier = t(price.source === "effective" ? "chat.iagentPriceStandard" : "chat.iagentPriceReference");
  const title = [
    qualifier,
    ...price.tiers.map((tier) => [tierName(tier), describe(tier)].filter(Boolean).join(" · ")),
  ].join("\n");
  return (
    <span className="composer-iagent-price" title={title}>
      {describe(price.tiers[0])}
      {price.tiers.length > 1 ? <span>{t("chat.iagentPriceTiered")}</span> : null}
      {price.source === "reference" ? <span>{qualifier}</span> : null}
    </span>
  );
}
