import { useTranslation } from "react-i18next";
import type { IagentImageOption, IagentImageSelection, IagentStatus } from "@pi-desktop/shared";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

const automatic = "auto";
const optionId = ({ groupId, model }: Pick<IagentImageOption, "groupId" | "model">) => `${groupId}/${model}`;

export function IagentImageModelRow({
  status, selection, customImage, busy, onSelect,
}: {
  status: IagentStatus;
  selection?: IagentImageSelection | null;
  customImage: boolean;
  busy: boolean;
  onSelect: (option: IagentImageOption | null) => void;
}) {
  const { t } = useTranslation();
  const images = status.imageModels ?? [];
  const currentId = selection?.accountId === status.account?.id && selection ? optionId(selection) : automatic;
  const selected = images.find((option) => optionId(option) === currentId);
  const unavailable = currentId !== automatic && !selected;
  const effective = currentId === automatic ? status.image : selected;
  const detail = unavailable
    ? t("settings.iagent.imageUnavailable")
    : effective ? `${effective.group} · ${effective.model}` : t("settings.iagent.noImage");

  return (
    <SettingsRow title={t("settings.iagent.image")} detail={
      customImage ? `${detail} · ${t("settings.iagent.imageCustomOverride")}` : detail
    }>
      {images.length || unavailable ? (
        <SettingsMenuSelect
          className="model-image-selector settings-model-select"
          label={t("settings.iagent.image")}
          value={currentId}
          options={[
            { id: automatic, label: t("settings.iagent.imageAuto") },
            ...images.map((option) => ({ id: optionId(option), label: `${option.group} · ${option.model}` })),
            ...(unavailable ? [{ id: currentId, label: t("settings.iagent.imageUnavailable"), disabled: true }] : []),
          ]}
          busy={busy}
          onChange={(id) => {
            if (id === automatic) onSelect(null);
            else {
              const next = images.find((option) => optionId(option) === id);
              if (next) onSelect(next);
            }
          }}
        />
      ) : null}
    </SettingsRow>
  );
}
