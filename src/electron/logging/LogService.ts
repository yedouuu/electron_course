import * as fs from "fs/promises";
import * as path from "path";
import {
  LogFileInfo,
  LogServiceOptions,
  LogStatus,
  LogWriter,
  WriteLogRequest,
} from "./types.js";

export class RotatingLogService implements LogWriter {
  private readonly options: LogServiceOptions;
  private readonly filePaths: string[];
  private activeIndex = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly initPromise: Promise<void>;

  constructor(options: LogServiceOptions) {
    this.options = options;
    this.filePaths = Array.from({ length: options.fileCount }, (_, index) =>
      path.join(options.baseDir, `${options.filePrefix}-${index}.log`)
    );
    this.initPromise = this.initialize();
  }

  async write(entry: WriteLogRequest): Promise<void> {
    const line = this.formatLogLine(entry);

    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.initPromise;
        await this.writeLineWithRotation(line);
      })
      .catch((error) => {
        console.error("Failed to write rotating log:", error);
      });

    return this.writeQueue;
  }

  async getStatus(): Promise<LogStatus> {
    await this.initPromise;
    const files = await Promise.all(
      this.filePaths.map((filePath) => this.getFileInfo(filePath))
    );

    return {
      activeIndex: this.activeIndex,
      activeFilePath: this.filePaths[this.activeIndex],
      maxFileBytes: this.options.maxFileBytes,
      fileCount: this.options.fileCount,
      files,
    };
  }

  async getFilePaths(): Promise<string[]> {
    await this.initPromise;
    return [...this.filePaths];
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.options.baseDir, { recursive: true });
    this.activeIndex = await this.detectActiveLogFileIndex();

    await this.writeLineWithRotation(
      `===== Log started at ${new Date().toISOString()} =====`
    );
  }

  private async detectActiveLogFileIndex(): Promise<number> {
    const stats = await Promise.all(
      this.filePaths.map(async (filePath) => {
        try {
          return await fs.stat(filePath);
        } catch {
          return null;
        }
      })
    );

    let latestIndex = 0;
    let latestTime = 0;

    stats.forEach((stat, index) => {
      const mtime = stat?.mtimeMs ?? 0;
      if (mtime > latestTime) {
        latestTime = mtime;
        latestIndex = index;
      }
    });

    return latestIndex;
  }

  private async writeLineWithRotation(line: string): Promise<void> {
    const entry = `${line}\n`;
    const entryBytes = Buffer.byteLength(entry, "utf8");

    let activePath = this.filePaths[this.activeIndex];
    let currentSize = await this.getFileSizeSafe(activePath);

    if (currentSize + entryBytes > this.options.maxFileBytes) {
      this.activeIndex = (this.activeIndex + 1) % this.options.fileCount;
      activePath = this.filePaths[this.activeIndex];
      await fs.writeFile(activePath, "", "utf8");
      currentSize = 0;
    }

    if (entryBytes > this.options.maxFileBytes) {
      const truncatedBytes = Buffer.from(entry, "utf8").subarray(
        Math.max(0, entryBytes - this.options.maxFileBytes)
      );
      await fs.writeFile(activePath, truncatedBytes, "utf8");
      return;
    }

    if (currentSize + entryBytes > this.options.maxFileBytes) {
      return;
    }

    await fs.appendFile(activePath, entry, "utf8");
  }

  private async getFileSizeSafe(filePath: string): Promise<number> {
    try {
      const stat = await fs.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  private async getFileInfo(filePath: string): Promise<LogFileInfo> {
    try {
      const stat = await fs.stat(filePath);
      return {
        path: filePath,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      return {
        path: filePath,
        size: 0,
        updatedAt: "",
      };
    }
  }

  private formatLogLine(entry: WriteLogRequest): string {
    const time = new Date().toISOString();
    const level = (entry.level ?? "info").toUpperCase();
    const channel = entry.channel ?? "general";
    const source = entry.source ?? "unknown";
    const message = (entry.message ?? "").replace(/\r?\n/g, "\\n");
    const metadata = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";

    return `[${time}] [${level}] [${channel}] [${source}] ${message}${metadata}`;
  }
}
