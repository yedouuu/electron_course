import { SerialPort } from "serialport";
import { ReadlineParser } from "serialport";
import { BrowserWindow, app } from "electron";
import { ipcWebContentsSend } from "./utils.js";
import * as fs from "fs/promises";
import * as path from "path";

// 定义扩展的端口信息接口
interface PortDetails {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
  friendlyName?: string;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
  friendlyName?: string;
  displayName: string;
}

export interface SerialPortConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: "none" | "even" | "odd" | "mark" | "space";
}

export class SerialPortManager {
  private serialPort: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private mainWindow: BrowserWindow;
  private isConnected = false;
  private hexBuffer: Buffer = Buffer.alloc(0); // 用于hex数据缓冲
  private dataTimeout: NodeJS.Timeout | null = null; // 用于延时发送缓冲数据
  private useRawMode = true; // 默认使用原始数据模式（hex模式）
  private protocolLogMaxBytes = 4 * 1024 * 1024; // 4MB日志文件大小限制，超过后切换到另一个文件继续记录
  // private protocolLogMaxBytes = 4 * 1024; // 测试用4KB，实际使用时请使用4MB
  private protocolLogFilePaths: string[];
  private protocolLogActiveIndex = 0;
  private protocolLogWriteQueue: Promise<void> = Promise.resolve();

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    const dataDir = this.getDataDirPath();
    this.protocolLogFilePaths = [
      path.join(dataDir, "serial-protocol-0.log"),
      path.join(dataDir, "serial-protocol-1.log"),
    ];
    this.initializeProtocolLogFile();
  }

  private getDataDirPath(): string {
    const isDevelopment = process.env.NODE_ENV === "development";
    const projectRoot = isDevelopment
      ? process.cwd()
      : path.dirname(app.getPath("exe"));
    return path.join(projectRoot, "Data");
  }

  private async initializeProtocolLogFile(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.protocolLogFilePaths[0]), {
        recursive: true,
      });
      this.protocolLogActiveIndex = await this.detectActiveLogFileIndex();
      await fs.appendFile(
        this.protocolLogFilePaths[this.protocolLogActiveIndex],
        `\n===== Serial log started at ${new Date().toISOString()} =====\n`,
        "utf8"
      );
    } catch (error) {
      console.error("Failed to initialize serial protocol log file:", error);
    }
  }

  private async detectActiveLogFileIndex(): Promise<number> {
    try {
      const stats = await Promise.all(
        this.protocolLogFilePaths.map(async (filePath) => {
          try {
            return await fs.stat(filePath);
          } catch {
            return null;
          }
        })
      );

      const firstTime = stats[0]?.mtimeMs ?? 0;
      const secondTime = stats[1]?.mtimeMs ?? 0;
      return secondTime > firstTime ? 1 : 0;
    } catch {
      return 0;
    }
  }

  private async getFileSizeSafe(filePath: string): Promise<number> {
    try {
      const stat = await fs.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  private appendProtocolLog(line: string): void {
    this.protocolLogWriteQueue = this.protocolLogWriteQueue
      .then(async () => {
        const entry = `${line}\n`;
        const entryBytes = Buffer.byteLength(entry, "utf8");

        let activePath =
          this.protocolLogFilePaths[this.protocolLogActiveIndex];
        let currentSize = await this.getFileSizeSafe(activePath);

        if (currentSize + entryBytes > this.protocolLogMaxBytes) {
          this.protocolLogActiveIndex = (this.protocolLogActiveIndex + 1) % 2;
          activePath = this.protocolLogFilePaths[this.protocolLogActiveIndex];
          await fs.writeFile(activePath, "", "utf8");
          currentSize = 0;
        }

        if (entryBytes > this.protocolLogMaxBytes) {
          const truncated = entry.slice(
            entry.length - this.protocolLogMaxBytes,
            entry.length
          );
          await fs.writeFile(activePath, truncated, "utf8");
          return;
        }

        if (currentSize + entryBytes > this.protocolLogMaxBytes) {
          return;
        }

        await fs.appendFile(activePath, entry, "utf8");
      })
      .catch((error) => {
        console.error("Failed to write serial protocol log:", error);
      });
  }

  /**
   * 获取所有可用的串口列表
   */ async listPorts(): Promise<SerialPortInfo[]> {
    try {
      const ports = await SerialPort.list();
      return ports.map((port) => {
        const portDetails = port as PortDetails;
        return {
          path: portDetails.path,
          manufacturer: portDetails.manufacturer,
          serialNumber: portDetails.serialNumber,
          pnpId: portDetails.pnpId,
          locationId: portDetails.locationId,
          productId: portDetails.productId,
          vendorId: portDetails.vendorId,
          friendlyName: portDetails.friendlyName,
          displayName: this.createDisplayName(portDetails),
        };
      });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Error listing serial ports:", error);
      throw new Error(`Failed to list serial ports: ${errorMessage}`);
    }
  }
  /**
   * 连接到指定串口
   */
  async connect(
    portPath: string,
    config: Partial<SerialPortConfig> = {},
    retryCount: number = 2
  ): Promise<boolean> {
    // 验证端口路径
    if (!portPath || typeof portPath !== "string") {
      throw new Error("Invalid port path provided");
    }

    // 检查端口是否存在
    const availablePorts = await this.listPorts();
    const portExists = availablePorts.some((port) => port.path === portPath);
    if (!portExists) {
      throw new Error(
        `Port ${portPath} is not available. Please refresh the port list.`
      );
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        // 如果已连接，先断开
        if (this.serialPort && this.isConnected) {
          await this.disconnect();
          // 等待一下确保端口完全释放
          await this.delay(100);
        }
        const defaultConfig: SerialPortConfig = {
          baudRate: 115200, // 修改默认波特率为115200
          dataBits: 8,
          stopBits: 1,
          parity: "none",
        };

        const finalConfig = { ...defaultConfig, ...config };

        console.log(
          `Attempting to connect to ${portPath} (attempt ${attempt + 1}/${
            retryCount + 1
          })`
        );
        console.log("Connection config:", finalConfig);

        this.serialPort = new SerialPort({
          path: portPath,
          baudRate: finalConfig.baudRate,
          dataBits: finalConfig.dataBits,
          stopBits: finalConfig.stopBits,
          parity: finalConfig.parity,
          // 添加更多配置选项以提高兼容性
          autoOpen: false, // 手动控制打开
          highWaterMark: 64 * 1024, // 增加缓冲区大小
        });

        // 设置事件监听器
        this.setupEventListeners();

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(
              new Error(
                `Connection timeout after 5 seconds for port ${portPath}`
              )
            );
          }, 5000);

          this.serialPort!.on("open", () => {
            clearTimeout(timeout);
            this.isConnected = true;
            console.log(`Successfully connected to serial port: ${portPath}`);
            ipcWebContentsSend(
              "serial-connected",
              this.mainWindow.webContents,
              {
                portPath,
                config: finalConfig,
              }
            );
            resolve(true);
          });

          this.serialPort!.on("error", (error) => {
            clearTimeout(timeout);
            console.error(
              `Serial port connection error (attempt ${attempt + 1}):`,
              error
            );
            this.isConnected = false;
            this.serialPort = null;

            // 解析错误信息
            const errorMessage = this.parseSerialPortError(error);
            reject(new Error(errorMessage));
          });

          // 手动打开端口
          this.serialPort!.open((error) => {
            if (error) {
              clearTimeout(timeout);
              console.error(`Failed to open port ${portPath}:`, error);
              this.serialPort = null;
              const errorMessage = this.parseSerialPortError(error);
              reject(new Error(errorMessage));
            }
          });
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(
          `Connection attempt ${attempt + 1} failed:`,
          lastError.message
        );

        if (this.serialPort) {
          try {
            this.serialPort.destroy();
          } catch (destroyError) {
            console.error("Error destroying failed serial port:", destroyError);
          }
          this.serialPort = null;
        }

        // 如果不是最后一次尝试，等待一下再重试
        if (attempt < retryCount) {
          console.log(`Retrying in 1 second...`);
          await this.delay(1000);
        }
      }
    }

    // 所有重试都失败了
    throw (
      lastError ||
      new Error(
        `Failed to connect to ${portPath} after ${retryCount + 1} attempts`
      )
    );
  }
  /**
   * 解析串口错误信息
   */
  private parseSerialPortError(error: Error | unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Unknown error code 31")) {
      return (
        `Port is busy or access denied. The device may be in use by another application. Please:\n` +
        `1. Close any other programs using this port\n` +
        `2. Disconnect and reconnect the device\n` +
        `3. Try a different baud rate`
      );
    }

    if (message.includes("Unknown error code 2")) {
      return `Port not found. The device may have been disconnected.`;
    }

    if (message.includes("Unknown error code 5")) {
      return `Access denied. Try running the application as administrator.`;
    }

    if (message.includes("Unknown error code 1167")) {
      return `Device not ready. Please reconnect the device and try again.`;
    }

    if (
      message.includes("File not found") ||
      message.includes("No such file")
    ) {
      return `Port does not exist. Please refresh the port list and select a valid port.`;
    }

    if (message.includes("Permission denied")) {
      return `Permission denied. Please check if another application is using this port.`;
    }

    return `Connection error: ${message}`;
  }

  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /**
   * 断开串口连接
   */ 
  async disconnect(): Promise<void> {
    // 清理解析器
    if (this.parser) {
      this.parser.removeAllListeners();
      this.parser = null;
    }
    // 清理缓冲区
    if (this.dataTimeout) {
      clearTimeout(this.dataTimeout);
      this.dataTimeout = null;
    }
    this.hexBuffer = Buffer.alloc(0);

    if (this.serialPort && this.isConnected) {
      return new Promise((resolve, reject) => {
        this.serialPort!.close((error) => {
          if (error) {
            console.error("Error closing serial port:", error);
            reject(error);
          } else {
            this.isConnected = false;
            this.serialPort = null;
            console.log("Serial port disconnected");
            ipcWebContentsSend(
              "serial-disconnected",
              this.mainWindow.webContents,
              {}
            );
            resolve();
          }
        });
      });
    }
  }

  /**
   * 向串口发送数据
   */
  async sendData(data: string | Buffer): Promise<void> {
    if (!this.serialPort || !this.isConnected) {
      throw new Error("Serial port is not connected");
    }

    return new Promise((resolve, reject) => {
      this.serialPort!.write(data, (error) => {
        if (error) {
          console.error("Error sending data:", error);
          reject(error);
        } else {
          console.log("Data sent:", data);
          resolve();
        }
      });
    });
  }

  /**
   * 发送十六进制字符串数据到串口
   * @param hexString 十六进制字符串，如 "48656C6C6F" 或 "48 65 6C 6C 6F"
   */
  async sendHexData(hexString: string): Promise<void> {
    if (!this.serialPort || !this.isConnected) {
      throw new Error("Serial port is not connected");
    }

    try {
      // 移除空格和其他分隔符，只保留十六进制字符
      const cleanHex = hexString.replace(/[^0-9A-Fa-f]/g, "");

      // 检查是否为有效的十六进制字符串
      if (cleanHex.length === 0) {
        throw new Error("Invalid hex string: no valid hex characters found");
      }

      // 确保长度为偶数（每两个字符表示一个字节）
      if (cleanHex.length % 2 !== 0) {
        throw new Error("Invalid hex string: length must be even");
      }

      // 转换为Buffer
      const buffer = Buffer.from(cleanHex, "hex");

      return new Promise((resolve, reject) => {
        this.serialPort!.write(buffer, (error) => {
          if (error) {
            console.error("Error sending hex data:", error);
            reject(error);
          } else {
            console.log(
              "Hex data sent:",
              cleanHex,
              "-> Buffer:",
              Array.from(buffer)
            );
            resolve();
          }
        });
      });
    } catch (error) {
      console.error("Error processing hex data:", error);
      throw error;
    }
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(): { isConnected: boolean; portPath?: string } {
    return {
      isConnected: this.isConnected,
      portPath: this.serialPort?.path,
    };
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    if (!this.serialPort) return;

    // 清除之前的监听器
    this.serialPort.removeAllListeners("data");
    if (this.parser) {
      this.parser.removeAllListeners("data");
      this.parser.destroy();
      this.parser = null;
    }

    if (this.useRawMode) {
      // 原始数据模式 - 适合hex数据接收
      this.setupRawDataListeners();
    } else {
      // 行模式 - 适合文本数据接收
      this.setupLineDataListeners();
    }

    // 设置公共的错误和关闭事件监听器
    this.setupCommonListeners();
  }  /**
   * 设置原始数据监听器 - 只处理原始数据收发
   */
  private setupRawDataListeners(): void {
    if (!this.serialPort) return;

    this.serialPort.on("data", (data: Buffer) => {
      // 将新数据追加到缓冲区
      this.hexBuffer = Buffer.concat([this.hexBuffer, data]);

      // 清除之前的超时
      if (this.dataTimeout) {
        clearTimeout(this.dataTimeout);
      }

      // 设置延时发送，合并连续的数据包
      this.dataTimeout = setTimeout(() => {
        this.flushHexBuffer();
      }, 10); // 10ms延时，合并数据包
    });
  }  /**
   * 设置行数据监听器（文本模式）- 包含消息类型识别
   */
  private setupLineDataListeners(): void {
    if (!this.serialPort) return;

    // 创建读行解析器
    this.parser = this.serialPort.pipe(
      new ReadlineParser({ delimiter: "\r\n" })
    );

    // 监听解析后的行数据
    this.parser.on("data", (line: string) => {
      const timestamp = new Date().toLocaleTimeString();
      const messageType = this.identifyMessageType(line);
      const receivedAt = new Date().toISOString();
      
      console.log(`Received line data [${messageType}]:`, line);
      this.appendProtocolLog(
        `[${receivedAt}] [RX] [TEXT] [${messageType}] ${line.replace(/\r?\n/g, "\\n")}`
      );
      
      // 发送原始文本数据到React端
      ipcWebContentsSend("serial-data-received", this.mainWindow.webContents, {
        textData: line,
        hexData: "", // 行模式下不发送hex数据
        timestamp: `[${timestamp}]`,
        messageType: messageType
      });
    });
  }/**
   * 刷新hex缓冲区，发送原始数据到前端
   */ 
  private flushHexBuffer(): void {
    if (this.hexBuffer.length === 0) return;

    const timestamp = new Date().toLocaleTimeString();
    const receivedAt = new Date().toISOString();
    const hexData = this.hexBuffer.toString("hex").toUpperCase();
    const formattedHexData = this.formatHexString(hexData);

    console.log("Received hex data:", formattedHexData);
    this.appendProtocolLog(`[${receivedAt}] [RX] [HEX] ${formattedHexData}`);
    
    // 只发送原始数据到React端，让React处理所有协议逻辑
    ipcWebContentsSend("serial-data-received", this.mainWindow.webContents, {
      hexData: formattedHexData,
      textData: "", // 行模式下不发送文本数据
      messageType: "normal", // hex模式下不识别消息类型
      timestamp: `[${timestamp}]`
    });

    // 清空缓冲区
    this.hexBuffer = Buffer.alloc(0);
  }

  /**
   * 设置公共事件监听器
   */
  private setupCommonListeners(): void {
    if (!this.serialPort) return;

    // 串口错误
    this.serialPort.on("error", (error) => {
      console.error("Serial port error:", error);
      ipcWebContentsSend("serial-error", this.mainWindow.webContents, {
        error: error.message,
      });
    });    // 串口关闭
    this.serialPort.on("close", () => {
      console.log("Serial port closed");
      this.isConnected = false;
      if (this.parser) {
        this.parser.removeAllListeners();
        this.parser = null;
      }
      // 清理缓冲区
      this.hexBuffer = Buffer.alloc(0);
      if (this.dataTimeout) {
        clearTimeout(this.dataTimeout);
        this.dataTimeout = null;
      }
      ipcWebContentsSend(
        "serial-disconnected",
        this.mainWindow.webContents,
        {}
      );
    });
  }
  /**
   * 创建显示名称
   */
  private createDisplayName(port: PortDetails): string {
    if (port.friendlyName) {
      return port.friendlyName;
    }

    const parts = [];
    if (port.manufacturer) {
      parts.push(port.manufacturer);
    }
    parts.push(port.path);

    return parts.join(" - ");
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    try {
      await this.disconnect();
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }  /**
   * 设置数据接收模式
   * @param useRawMode true为原始数据模式（适合hex），false为行模式（适合文本）
   */
  public setReceiveMode(useRawMode: boolean): void {
    if (this.useRawMode === useRawMode) return; // 模式未改变，直接返回

    this.useRawMode = useRawMode;
    // 如果串口已连接，重新设置事件监听器
    if (this.isConnected && this.serialPort) {
      this.setupEventListeners();
    }
  }

  /**
   * 识别消息类型 - 仅用于行模式
   * 基于消息内容判断是否为警告、错误、成功或信息类型
   */
  private identifyMessageType(
    message: string
  ): "normal" | "warning" | "error" | "success" | "info" {
    const upperMessage = message.toUpperCase();

    // 错误关键词
    const errorKeywords = [
      "ERROR",
      "ERR",
      "FAIL",
      "FAILED",
      "EXCEPTION",
      "FATAL",
      "CRITICAL",
      "错误",
      "失败",
      "异常",
      "故障",
      "CRASH",
      "ABORT",
      "TIMEOUT",
    ];

    // 警告关键词
    const warningKeywords = [
      "WARNING",
      "WARN",
      "CAUTION",
      "ALERT",
      "ATTENTION",
      "警告",
      "注意",
      "小心",
      "DEPRECATED",
      "UNSTABLE",
    ];

    // 成功关键词
    const successKeywords = [
      "SUCCESS",
      "OK",
      "PASS",
      "PASSED",
      "COMPLETE",
      "COMPLETED",
      "DONE",
      "成功",
      "完成",
      "通过",
      "READY",
      "CONNECTED",
      "STARTED",
    ];

    // 信息关键词
    const infoKeywords = [
      "INFO",
      "STATUS",
      "DEBUG",
      "LOG",
      "NOTICE",
      "MESSAGE",
      "信息",
      "状态",
      "调试",
      "消息",
      "INIT",
      "CONFIG",
    ];

    // 检查错误关键词
    if (errorKeywords.some((keyword) => upperMessage.includes(keyword))) {
      return "error";
    }

    // 检查警告关键词
    if (warningKeywords.some((keyword) => upperMessage.includes(keyword))) {
      return "warning";
    }

    // 检查成功关键词
    if (successKeywords.some((keyword) => upperMessage.includes(keyword))) {
      return "success";
    }

    // 检查信息关键词
    if (infoKeywords.some((keyword) => upperMessage.includes(keyword))) {
      return "info";
    }

    // 默认为普通消息
    return "normal";
  }
  /**
   * 格式化十六进制字符串，每两个字符之间添加空格
   * @param hexString 原始十六进制字符串
   * @returns 格式化后的字符串，如 "FDDF0802" -> "FD DF 08 02"
   */
  private formatHexString(hexString: string): string {
    return hexString.replace(/(.{2})/g, "$1 ").trim();
  }
}

/**
 * 导出便捷函数
 */
export async function getAvailablePorts(): Promise<SerialPortInfo[]> {
  try {
    const ports = await SerialPort.list();
    return ports.map((port) => {
      const portDetails = port as PortDetails;
      return {
        path: portDetails.path,
        manufacturer: portDetails.manufacturer,
        serialNumber: portDetails.serialNumber,
        pnpId: portDetails.pnpId,
        locationId: portDetails.locationId,
        productId: portDetails.productId,
        vendorId: portDetails.vendorId,
        friendlyName: portDetails.friendlyName,
        displayName:
          portDetails.friendlyName ||
          `${portDetails.manufacturer || "Unknown"} (${portDetails.path})`,
      };
    });
  } catch (error) {
    console.error("Error getting available ports:", error);
    return [];
  }
}
