import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { IagentStatus } from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { api } from "../../lib/api";
import { Button, Field, Input, PasswordInput } from "../ui";

export function IagentAccountCard() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<IagentStatus>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"login" | "account">();

  useEffect(() => {
    let subscribed = true;
    let receivedUpdate = false;
    const off = api.onIagentChanged((update) => {
      receivedUpdate = true;
      setStatus(update.status);
    });
    void api.iagentStatus().then((value) => {
      if (subscribed && !receivedUpdate) setStatus(value);
    }).catch(() => {
      if (subscribed && !receivedUpdate) setError("account");
    });
    return () => {
      subscribed = false;
      off();
    };
  }, []);

  async function run(action: () => Promise<void>, area: "login" | "account") {
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch { setError(area); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    void run(async () => {
      if (challenge) {
        setStatus(await api.iagentConfirm(challenge, code));
        setChallenge(undefined);
        setCode("");
      } else {
        const result = await api.iagentLogin(email, password);
        if (result.requiresTwoFactor) setChallenge(result.challengeId);
        else setStatus(result.status);
      }
    }, "login").finally(() => setPassword(""));
  }

  const connected = status?.account && status.sync !== "expired";
  const modelCount = status?.groups.reduce((total, group) => total + group.models, 0) ?? 0;
  const lastSync = status?.syncedAt && new Intl.DateTimeFormat(i18n.resolvedLanguage, { timeStyle: "short" }).format(status.syncedAt);
  return (
    <SettingsCard title={t("settings.iagent.title")} caption={t("settings.iagent.caption")}>
      {connected ? (
        <>
          <SettingsRow title={status.account?.email ?? ""} detail={
            [t(`settings.iagent.${status.sync}`), lastSync].filter(Boolean).join(" · ")
          }>
            <Button disabled={busy} onClick={() => void run(async () => setStatus(await api.iagentRefresh()), "account")}>
              {t("settings.iagent.refresh")}
            </Button>
            <Button disabled={busy} onClick={() => void run(async () => setStatus(await api.iagentLogout()), "account")}>
              {t("settings.iagent.disconnect")}
            </Button>
          </SettingsRow>
          <SettingsRow title={t("settings.iagent.chatModels")} detail={t("settings.iagent.catalogCount", { groups: status.groups.length, models: modelCount })}>
            {status.groups.length > 0 ? (
              <details>
                <summary>{t("settings.iagent.groups")}</summary>
                <ul>{status.groups.map((group) => <li key={group.id}>{group.name} · {group.models}</li>)}</ul>
              </details>
            ) : null}
          </SettingsRow>
          <SettingsRow title={t("settings.iagent.image")} detail={status.image
            ? `${status.image.group} · ${status.image.model}`
            : t("settings.iagent.noImage")}>{null}</SettingsRow>
        </>
      ) : (
        <form className="settings-stack p-4" onSubmit={submit}>
          {status?.sync === "expired" ? <p role="status">{t("settings.iagent.expired")}</p> : null}
          {challenge ? (
            <Field label={t("settings.iagent.code")}>
              <Input value={code} onChange={(event) => setCode(event.target.value)} disabled={busy}
                inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
            </Field>
          ) : (
            <>
              <Field label={t("settings.iagent.email")}>
                <Input value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy}
                  type="email" autoComplete="username" required />
              </Field>
              <Field label={t("settings.iagent.password")}>
                <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy}
                  autoComplete="current-password" required showLabel={t("settings.iagent.showPassword")}
                  hideLabel={t("settings.iagent.hidePassword")} />
              </Field>
            </>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {t(challenge ? "settings.iagent.verify" : "settings.iagent.connect")}
            </Button>
            {challenge ? <Button type="button" disabled={busy} onClick={() => {
              setChallenge(undefined);
              setCode("");
              setError(undefined);
            }}>{t("common.cancel")}</Button> : null}
          </div>
        </form>
      )}
      {error ? <p className="p-4" role="alert">{t(error === "login" ? "settings.iagent.loginError" : "settings.iagent.accountError")}</p> : null}
    </SettingsCard>
  );
}
