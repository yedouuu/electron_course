export type LogLevel = "debug" | "info" | "warn" | "error";

export interface WriteLogRequest {
  message: string;
  level?: LogLevel;
  channel?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface LogFileInfo {
  path: string;
  size: number;
  updatedAt: string;
}

export interface LogStatus {
  activeIndex: number;
  activeFilePath: string;
  maxFileBytes: number;
  fileCount: number;
  files: LogFileInfo[];
}

export interface LogServiceOptions {
  baseDir: string;
  filePrefix: string;
  maxFileBytes: number;
  fileCount: number;
}

export interface LogWriter {
  write(entry: WriteLogRequest): Promise<void>;
}
