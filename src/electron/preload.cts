// const electron = require("electron");

import electron from "electron";

electron.contextBridge.exposeInMainWorld("electron", {
  subscribeStatistics: (callback) => {
    return ipcOn("statistics", (statistics) => {
      callback(statistics);
    });
  },
  subscribeChangeView: (callback) => {
    return ipcOn("changeView", (statistics) => {
      callback(statistics);
    });
  },
  getStaticData: () => ipcInvoke("getStaticData"),
  getAppVersion: () => ipcInvoke("getAppVersion"),
  sendFrameAction: (payload) => ipcSend("sendFrameAction", payload),
  // Serial Port functions
  listSerialPorts: () => ipcInvoke("list-serial-ports"),
  connectSerialPort: (portPath: string, config?: any) =>
    ipcInvoke("connect-serial-port", portPath, config),  disconnectSerialPort: () => ipcInvoke("disconnect-serial-port"),
  sendSerialData: (data: string) => ipcInvoke("send-serial-data", data),
  sendSerialHexData: (hexString: string) => ipcInvoke("send-serial-hex-data", hexString),
  getSerialConnectionStatus: () => ipcInvoke("get-serial-connection-status"),
  setSerialReceiveMode: (useRawMode: boolean) => ipcInvoke("set-serial-receive-mode", useRawMode),  // Serial Port event subscriptions
  // 通用日志API
  writeLog: (payload: WriteLogRequest) => ipcInvoke("write-log", payload),
  getLogStatus: () => ipcInvoke("get-log-status"),
  getLogFiles: () => ipcInvoke("get-log-files"),

  // Serial Port event subscriptions
  onSerialConnected: (callback: (data: SerialPortConnectionData) => void) => ipcOn("serial-connected", callback),
  onSerialDisconnected: (callback: () => void) => ipcOn("serial-disconnected", callback),
  onSerialDataReceived: (callback: (data: SerialDataReceived) => void) => ipcOn("serial-data-received", callback),
  onSerialError: (callback: (error: SerialError) => void) => ipcOn("serial-error", callback),
  
  // 文件管理函数
  exportExcel: (sessionData: any[], options?: any) => ipcInvoke("export-excel", sessionData, options),
  exportPDF: (sessionData: any[], options?: any) => ipcInvoke("export-pdf", sessionData, options),
  getExportHistory: () => ipcInvoke("get-export-history"),
  openFile: (filePath: string) => ipcInvoke("open-file", filePath),
  showInFolder: (filePath: string) => ipcInvoke("show-in-folder", filePath),
  deleteFile: (filePath: string) => ipcInvoke("delete-file", filePath),
  getDefaultExportDir: () => ipcInvoke("get-default-export-dir"),
  setDefaultExportDir: (dirPath: string) => ipcInvoke("set-default-export-dir", dirPath),
  
  // Excel导入函数
  importFromExcel: (filePath?: string, options?: any) => ipcInvoke("import-from-excel", filePath, options),
  importFromDirectory: (directory?: string, options?: any) => ipcInvoke("import-from-directory", directory, options),
  
  // 自动更新函数
  checkForUpdates: () => ipcInvoke("check-for-updates"),
  downloadUpdate: () => ipcInvoke("download-update"),
  installUpdate: () => ipcInvoke("install-update"),
  getUpdateStatus: () => ipcInvoke("get-update-status"),
  
  // 自动更新事件订阅
  onUpdateChecking: (callback: () => void) => {
    const cb = () => callback();
    electron.ipcRenderer.on("update-checking", cb);
    return () => electron.ipcRenderer.off("update-checking", cb);
  },
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
    const cb = (_: Electron.IpcRendererEvent, info: UpdateInfo) => callback(info);
    electron.ipcRenderer.on("update-available", cb);
    return () => electron.ipcRenderer.off("update-available", cb);
  },
  onUpdateNotAvailable: (callback: () => void) => {
    const cb = () => callback();
    electron.ipcRenderer.on("update-not-available", cb);
    return () => electron.ipcRenderer.off("update-not-available", cb);
  },
  onUpdateDownloadProgress: (callback: (progress: UpdateProgress) => void) => {
    const cb = (_: Electron.IpcRendererEvent, progress: UpdateProgress) => callback(progress);
    electron.ipcRenderer.on("update-download-progress", cb);
    return () => electron.ipcRenderer.off("update-download-progress", cb);
  },
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => {
    const cb = (_: Electron.IpcRendererEvent, info: UpdateInfo) => callback(info);
    electron.ipcRenderer.on("update-downloaded", cb);
    return () => electron.ipcRenderer.off("update-downloaded", cb);
  },
  onUpdateError: (callback: (error: UpdateError) => void) => {
    const cb = (_: Electron.IpcRendererEvent, error: UpdateError) => callback(error);
    electron.ipcRenderer.on("update-error", cb);
    return () => electron.ipcRenderer.off("update-error", cb);
  },

  ipcRenderer: {
    on: (channel: string, callback: (event: unknown, ...args: unknown[]) => void) => {
      electron.ipcRenderer.on(channel, callback);
    },
    removeAllListeners: (channel: string) => {
      electron.ipcRenderer.removeAllListeners(channel);
    },
    send: (channel: string, ...args: unknown[]) => {
      electron.ipcRenderer.send(channel, ...args);
    }
  }
} satisfies Window["electron"]);

function ipcInvoke<Key extends keyof EventPayloadMapping>(
  key: Key,
  ...args: unknown[]
): Promise<EventPayloadMapping[Key]> {
  return electron.ipcRenderer.invoke(key, ...args);
}

function ipcOn<Key extends keyof EventPayloadMapping>(
  key: Key,
  callback: (payload: EventPayloadMapping[Key]) => void
) {
  const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload);
  electron.ipcRenderer.on(key, cb);
  return () => electron.ipcRenderer.off(key, cb);
}

function ipcSend<Key extends keyof EventPayloadMapping>(
  key: Key,
  payload: EventPayloadMapping[Key]
) {
  electron.ipcRenderer.send(key, payload);
}
