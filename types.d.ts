// Excel导入相关类型定义
type ImportOptions = {
  directory?: string;
  filePattern?: string;
  validateData?: boolean;
  mergeWithExisting?: boolean;
  skipDuplicates?: boolean;
};

type ImportResult = {
  success: boolean;
  cancelled?: boolean; // 表示用户是否取消了操作
  sessionData?: SessionData[]; // 导入的会话数据数组
  importedCount?: number;
  skippedCount?: number;
  errorCount?: number;
  errors?: string[];
  filePath?: string;
};

type Statistics = {
  cpuUsage: number;
  ramUsage: number;
  storageUsage: number;
};

type StaticData = {
  totalStorage: number;
  cpuModel: string;
  totalMemoryGB: number;
};

type View = "CPU" | "RAM" | "STORAGE";

type FrameWindowAction = "MINIMIZE" | "MAXIMIZE" | "CLOSE";

type SerialPortConnectionData = {
  portPath: string;
  config: {
    baudRate: number;
    dataBits: number;
    stopBits: number;
    parity: string;
  };
};

type SerialDataReceived = {
  hexData: string; // hex模式下的十六进制数据
  textData: string; // 行模式下的文本数据
  timestamp: string;
  messageType?: 'normal' | 'warning' | 'error' | 'success' | 'info'; // 行模式下可能包含消息类型
};

type SerialError = {
  error: string;
};

type SerialPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
  friendlyName?: string;
  displayName: string;
};

type SerialConnectionStatus = {
  isConnected: boolean;
  portPath?: string;
};

type SerialPortConfig = {
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
};

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type WriteLogRequest = {
  message: string;
  level?: LogLevel;
  channel?: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

type LogFileInfo = {
  path: string;
  size: number;
  updatedAt: string;
};

type LogStatus = {
  activeIndex: number;
  activeFilePath: string;
  maxFileBytes: number;
  fileCount: number;
  files: LogFileInfo[];
};

// 自动更新相关类型
type UpdateInfo = {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
};

type UpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  total: number;
  transferred: number;
};

type UpdateStatus = {
  isUpdateAvailable: boolean;
  isUpdateDownloaded: boolean;
};

type UpdateError = {
  message: string;
};

type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  getAppVersion: string;
  changeView: View;
  sendFrameAction: FrameWindowAction;
  "serial-connected": SerialPortConnectionData;
  "serial-disconnected": Record<string, never>;
  "serial-data-received": SerialDataReceived;
  "serial-error": SerialError;
  "list-serial-ports": SerialPortInfo[];
  "connect-serial-port": boolean;
  "disconnect-serial-port": void;
  "send-serial-data": void;
  "send-serial-hex-data": void;
  "get-serial-connection-status": SerialConnectionStatus;
  "set-serial-receive-mode": boolean;
  "write-log": boolean;
  "get-log-status": LogStatus;
  "get-log-files": string[];
  // 文件管理相关事件
  "export-excel": ExportResult;
  "export-pdf": ExportResult;
  "get-export-history": ExportFileInfo[];
  "open-file": boolean;
  "show-in-folder": boolean;
  "delete-file": boolean;
  "get-default-export-dir": string;
  "set-default-export-dir": boolean;
  // Excel导入相关事件
  "import-from-excel": ImportResult;
  "import-from-directory": ImportResult;
  // 自动更新相关事件 - IPC 调用
  "check-for-updates": boolean;
  "download-update": boolean;
  "install-update": boolean;
  "get-update-status": UpdateStatus;
  // 自动更新相关事件 - 从主进程发送的事件
  "update-checking": void;
  "update-available": UpdateInfo;
  "update-not-available": void;
  "update-download-progress": UpdateProgress;
  "update-downloaded": UpdateInfo;
  "update-error": UpdateError;
};

type UnsubscribeFunction = () => void;

interface Window {
  electron: {
    subscribeStatistics: (
      callback: (statistics: Statistics) => void
    ) => UnsubscribeFunction;

    subscribeChangeView: (
      callback: (view: View) => void
    ) => UnsubscribeFunction;

    getStaticData: () => Promise<StaticData>;
    getAppVersion: () => Promise<string>;
    sendFrameAction: (payload: FrameWindowAction) => void;
    
    // Serial Port functions
    listSerialPorts: () => Promise<SerialPortInfo[]>;
    connectSerialPort: (portPath: string, config?: SerialPortConfig) => Promise<boolean>;
    disconnectSerialPort: () => Promise<void>;
    sendSerialData: (data: string) => Promise<void>;
    sendSerialHexData: (hexString: string) => Promise<void>;
    getSerialConnectionStatus: () => Promise<SerialConnectionStatus>;
    setSerialReceiveMode: (useRawMode: boolean) => Promise<boolean>;
    writeLog: (payload: WriteLogRequest) => Promise<boolean>;
    getLogStatus: () => Promise<LogStatus>;
    getLogFiles: () => Promise<string[]>;
    
    // Serial Port event subscriptions
    onSerialConnected: (callback: (data: SerialPortConnectionData) => void) => UnsubscribeFunction;
    onSerialDisconnected: (callback: () => void) => UnsubscribeFunction;
    onSerialDataReceived: (callback: (data: SerialDataReceived) => void) => UnsubscribeFunction;
    onSerialError: (callback: (error: SerialError) => void) => UnsubscribeFunction;
    
    // 文件管理函数
    exportExcel: (sessionData: SessionData[], options?: ExportOptions) => Promise<ExportResult>;
    exportPDF: (sessionData: SessionData[], options?: ExportOptions) => Promise<ExportResult>;
    getExportHistory: () => Promise<ExportFileInfo[]>;
    openFile: (filePath: string) => Promise<boolean>;
    showInFolder: (filePath: string) => Promise<boolean>;
    deleteFile: (filePath: string) => Promise<boolean>;
    getDefaultExportDir: () => Promise<string>;
    setDefaultExportDir: (dirPath: string) => Promise<boolean>;
    // Excel导入函数
    importFromExcel: (filePath?: string, options?: ImportOptions) => Promise<ImportResult>;
    importFromDirectory: (directory?: string, options?: ImportOptions) => Promise<ImportResult>;
    // 自动更新函数
    checkForUpdates: () => Promise<boolean>;
    downloadUpdate: () => Promise<boolean>;
    installUpdate: () => Promise<boolean>;
    getUpdateStatus: () => Promise<UpdateStatus>;
    
    // 自动更新事件订阅
    onUpdateChecking: (callback: () => void) => UnsubscribeFunction;
    onUpdateAvailable: (callback: (info: UpdateInfo) => void) => UnsubscribeFunction;
    onUpdateNotAvailable: (callback: () => void) => UnsubscribeFunction;
    onUpdateDownloadProgress: (callback: (progress: UpdateProgress) => void) => UnsubscribeFunction;
    onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => UnsubscribeFunction;
    onUpdateError: (callback: (error: UpdateError) => void) => UnsubscribeFunction;

    ipcRenderer: {
      on: (channel: string, callback: (event: unknown, ...args: unknown[]) => void) => void;
      removeAllListeners: (channel: string) => void;
      send: (channel: string, ...args: unknown[]) => void;
    };
  };
}

// 文件管理相关类型
type ExportFileInfo = {
  id: string;
  filename: string;
  filePath: string;
  fileType: 'excel' | 'pdf';
  size: number;
  createdAt: string;
  sessionCount: number;
};

type ExportOptions = {
  format?: 'excel' | 'pdf';
  filename?: string;
  useDefaultDir?: boolean;
  customDir?: string;
  openAfterExport?: boolean;
};

type ExportResult = {
  success: boolean;
  filePath?: string;
  fileInfo?: ExportFileInfo;
  error?: string;
};
