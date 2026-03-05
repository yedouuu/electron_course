import { ipcMainHandle } from "../utils.js";
import { RotatingLogService } from "./LogService.js";
import { LogStatus, WriteLogRequest } from "./types.js";

export function registerLogIpcHandlers(logService: RotatingLogService): void {
  ipcMainHandle("write-log", async (...args: unknown[]) => {
    const [payload] = args as [WriteLogRequest | undefined];

    if (!payload || typeof payload.message !== "string") {
      throw new Error("Invalid write-log payload");
    }

    await logService.write({
      level: payload.level ?? "info",
      channel: payload.channel ?? "ui",
      source: payload.source ?? "ui",
      message: payload.message,
      metadata: payload.metadata,
    });

    return true;
  });

  ipcMainHandle("get-log-status", async (): Promise<LogStatus> => {
    return await logService.getStatus();
  });

  ipcMainHandle("get-log-files", async (): Promise<string[]> => {
    return await logService.getFilePaths();
  });
}
