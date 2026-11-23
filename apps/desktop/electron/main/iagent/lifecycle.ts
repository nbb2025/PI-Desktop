import type { App } from "electron";
import type { IagentUpdate } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import { createIagentIntegration } from "./integration";

export function installIagentRuntime(options: {
  app: App;
  getHost: () => HostProcess | null;
  onChange: (update: IagentUpdate) => void;
  onRefreshError: () => void;
}) {
  const { app, getHost, onChange, onRefreshError } = options;
  const iagent = createIagentIntegration({
    call: <T,>(method: string, params?: unknown): Promise<T> => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      return host.call<T>(method, params);
    },
    language: () => app.getLocale(),
    onChange,
  });
  const refresh = () => {
    if (getHost()?.isAvailable()) void iagent.refresh().catch(onRefreshError);
  };
  app.on("browser-window-focus", refresh);
  const timer = setInterval(refresh, 60_000).unref();
  app.once("will-quit", () => {
    clearInterval(timer);
    app.removeListener("browser-window-focus", refresh);
  });
  return {
    iagent,
    managedProviders: () => {
      refresh();
      return iagent.providers();
    },
  };
}
