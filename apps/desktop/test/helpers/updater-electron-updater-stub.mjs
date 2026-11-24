import { EventEmitter } from "node:events";

export class StubAutoUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;

  setFeedURL(feed) {
    this.feed = feed;
  }
}

export class NsisUpdater extends StubAutoUpdater {
  app = { getAppPath: () => process.cwd() };
}

export const autoUpdater = new StubAutoUpdater();

export class Provider {
  constructor(options) {
    this.executor = options.executor;
  }

  httpRequest(url, headers) {
    return this.executor.request(url, headers);
  }
}

export default { NsisUpdater, autoUpdater, Provider };
