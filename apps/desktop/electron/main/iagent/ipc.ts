import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "../ipc/types";
import type { IagentIntegration } from "./integration";

export function registerIagentIpc(registrar: IpcRegistrar, iagent: IagentIntegration) {
  const handle = <Input>(channel: string, action: (input: Input) => Promise<unknown>) => {
    registrar.handleWithEvent(channel, async (event, input: Input) => {
      registrar.assertMainWindowSender(event);
      return action(input);
    });
  };
  handle(IPC.invoke.iagentStatus, () => iagent.status());
  handle(IPC.invoke.iagentLogin, iagent.login);
  handle(IPC.invoke.iagentConfirm, iagent.confirm);
  handle(IPC.invoke.iagentLogout, iagent.logout);
  handle(IPC.invoke.iagentRefresh, () => iagent.refresh(true));
  handle(IPC.invoke.iagentSetImageModel, iagent.setImageModel);
}
