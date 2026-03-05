import { app, BrowserWindow, screen, dialog } from "electron";
import { ipcMainHandle, ipcMainOn, isDev } from "./utils.js";
import { getStaticData, pollResources } from "./resourceManager.js";
import { getPreloadPath, getUIPath } from "./pathResolver.js";
import { createTray } from "./tray.js";
import { createMenu } from "./menu.js";
import { SerialPortManager, getAvailablePorts } from "./serialPort.js";
import { createSplashWindow } from "./splashWindow.js";
import { StartupOptimizer } from "./startupOptimizer.js";
import { startupConfig } from "./startupConfig.js";
import { fileManager } from "./fileManage.js";
import { AutoUpdaterManager } from "./autoUpdater.js";
import { RotatingLogService } from "./logging/LogService.js";
import { registerLogIpcHandlers } from "./logging/ipc.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";

// 获取应用版本
function getAppVersion(): string {
  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version || '1.0.0';
  } catch (error) {
    console.error('Error reading package.json:', error);
    return '1.0.0';
  }
}

// 全局变量
let autoUpdaterManager: AutoUpdaterManager | null = null;
// app.commandLine.appendSwitch("enable-lcp");
// app.commandLine.appendSwitch('disable-features', 'OutOfProcessPdf');
// app.enableSandbox(); // 必须启用沙箱

// 启动性能优化
app.commandLine.appendSwitch("--enable-features", "VaapiVideoDecoder");
app.commandLine.appendSwitch("--disable-background-timer-throttling");
app.commandLine.appendSwitch("--disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("--disable-renderer-backgrounding");

// Menu.setApplicationMenu(null);

app.on("ready", async () => {
  // 记录启动时间
  const startTime = Date.now();
  const minSplashDuration = isDev()
    ? startupConfig.minSplashDuration.development
    : startupConfig.minSplashDuration.production;
  // 创建启动画面 - 在开发和生产环境都显示
  let splash: BrowserWindow | null = null;
  if (startupConfig.showSplashInDev || !isDev()) {
    splash = createSplashWindow(); // 启动画面会在内容加载完成后自动显示
    console.log(`启动画面将显示至少 ${minSplashDuration}ms`);
  }
  const mainWindow = new BrowserWindow({
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 需要禁用沙箱以访问串口
    },
    frame: isDev(),
    show: false, // 初始隐藏，等待弹出放大动画
     // 设置为深色，与启动画面一致，避免切换时的颜色跳跃
      width: Math.floor(screen.getPrimaryDisplay().workAreaSize.width * 0.6), // 屏幕宽度的60%
      height: Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 0.7), // 屏幕高度的70%
    // 初始位置将由弹出动画设置
  }); // 等待页面准备好后再显示窗口
  mainWindow.once("ready-to-show", async () => {
    // 计算已经过去的时间
    const elapsedTime = Date.now() - startTime;
    const remainingTime = Math.max(0, minSplashDuration - elapsedTime);

    // 如果还没有达到最小显示时间，等待剩余时间
    if (remainingTime > 0) {
      console.log(`启动画面将再显示 ${remainingTime}ms 以确保流畅体验`);
      await new Promise((resolve) => setTimeout(resolve, remainingTime));
    } // 使用简单的淡入淡出动画
    if (splash) {
      try {
        console.log(`启动画面淡出，主窗口淡入`);

        // 启动画面淡出
        StartupOptimizer.simpleFade(
          splash,
          1,
          0,
          startupConfig.animations.splashFadeOut,
          () => {
            if (splash && !splash.isDestroyed()) {
              splash.close();
            }
            // 延迟后显示主窗口
            setTimeout(() => {
              showMainWindowFadeIn();
            }, startupConfig.animations.delayBetween);
          }
        );
      } catch (error) {
        console.error("启动画面淡出失败:", error);
        if (splash && !splash.isDestroyed()) {
          splash.close();
        }
        showMainWindowFadeIn();
      }
    } else {
      showMainWindowFadeIn();
    }

    function showMainWindowFadeIn() {
      try {
        // 主窗口淡入动画
        mainWindow.setOpacity(0);
        mainWindow.show();
        mainWindow.center(); // 居中显示

        StartupOptimizer.simpleFade(
          mainWindow,
          0,
          1,
          startupConfig.animations.mainFadeIn,
          () => {
            mainWindow.setOpacity(1);
            console.log(`主窗口淡入完成，总耗时: ${Date.now() - startTime}ms`);
          }
        );
      } catch (error) {
        console.error("主窗口淡入失败:", error);
        mainWindow.setOpacity(1);
        mainWindow.show();
        mainWindow.center();
      }
    }
  });

  if (isDev()) {
    mainWindow.loadURL("http://localhost:5123");
  } else {
    mainWindow.loadFile(getUIPath());
  }

  pollResources(mainWindow);
  // 窗口尺寸和位置现在由弹出动画设置，移除这里的设置

  ipcMainHandle("getStaticData", () => {
    return getStaticData();
  });

  // 获取应用版本
  ipcMainHandle("getAppVersion", () => {
    return getAppVersion();
  });

  ipcMainOn("sendFrameAction", (payload) => {
    switch (payload) {
      case "MINIMIZE":
        mainWindow.minimize();
        break;
      case "MAXIMIZE":
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
        break;
      case "CLOSE":
        mainWindow.close();
        break;
    }
  });

  const dataDir = join(
    isDev() ? process.cwd() : dirname(app.getPath("exe")),
    "Data"
  );
  const logService = new RotatingLogService({
    baseDir: dataDir,
    filePrefix: "serial-protocol",
    maxFileBytes: 4 * 1024 * 1024, // 4MB
    fileCount: 2,
  });

  // 初始化串口管理器
  const serialPortManager = new SerialPortManager(mainWindow, logService);
  registerLogIpcHandlers(logService);

  // 初始化自动更新管理器
  autoUpdaterManager = new AutoUpdaterManager(mainWindow);

  // 注册串口相关的IPC处理程序
  ipcMainHandle("list-serial-ports", async () => {
    return await serialPortManager.listPorts();
  });
  ipcMainHandle("connect-serial-port", async (...args: unknown[]) => {
    const [portPath, config] = args as [string, SerialPortConfig?];
    return await serialPortManager.connect(portPath, config);
  });

  ipcMainHandle("disconnect-serial-port", async () => {
    return await serialPortManager.disconnect();
  });

  ipcMainHandle("send-serial-data", async (...args: unknown[]) => {
    const [data] = args as [string];
    return await serialPortManager.sendData(data);
  });

  ipcMainHandle("send-serial-hex-data", async (...args: unknown[]) => {
    const [hexString] = args as [string];
    return await serialPortManager.sendHexData(hexString);
  });

  ipcMainHandle("get-serial-connection-status", () => {
    return serialPortManager.getConnectionStatus();
  });

  ipcMainHandle("set-serial-receive-mode", (...args: unknown[]) => {
    const [useRawMode] = args as [boolean];
    serialPortManager.setReceiveMode(useRawMode);
    return true;
  });

  // ========== 自动更新 IPC 处理程序 ==========
  // 手动检查更新
  ipcMainHandle("check-for-updates", () => {
    if (autoUpdaterManager) {
      autoUpdaterManager.checkForUpdates();
    }
    return true;
  });

  // 开始下载更新
  ipcMainHandle("download-update", () => {
    if (autoUpdaterManager) {
      autoUpdaterManager.downloadUpdate();
    }
    return true;
  });

  // 安装更新并重启
  ipcMainHandle("install-update", () => {
    if (autoUpdaterManager) {
      autoUpdaterManager.installUpdate();
    }
    return true;
  });

  // 获取更新状态
  ipcMainHandle("get-update-status", () => {
    if (autoUpdaterManager) {
      return autoUpdaterManager.getUpdateStatus();
    }
    return { isUpdateAvailable: false, isUpdateDownloaded: false };
  });

  // ========== 文件管理 IPC 处理程序 ==========  // 导出 Excel 文件
  ipcMainHandle("export-excel", async (...args: unknown[]) => {
    const [sessionData, options = {}] = args as [any[], any];
    return await fileManager.exportExcel(sessionData, options);
  });

  // 导出 PDF 文件
  ipcMainHandle("export-pdf", async (...args: unknown[]) => {
    const [sessionData, options = {}] = args as [any[], any];
    return await fileManager.exportPDF(sessionData, options);
  });

  // 获取导出历史
  ipcMainHandle("get-export-history", async () => {
    return await fileManager.getExportHistory();
  });

  // 打开文件
  ipcMainHandle("open-file", async (...args: unknown[]) => {
    const [filePath] = args as [string];
    return await fileManager.openFile(filePath);
  });

  // 在文件夹中显示文件
  ipcMainHandle("show-in-folder", async (...args: unknown[]) => {
    const [filePath] = args as [string];
    await fileManager.showInFolder(filePath);
    return true;
  });

  // 删除文件
  ipcMainHandle("delete-file", async (...args: unknown[]) => {
    const [filePath] = args as [string];
    return await fileManager.deleteFile(filePath);
  });

  // 获取默认导出目录
  ipcMainHandle("get-default-export-dir", () => {
    return fileManager.getDefaultExportDir();
  });

  // 设置默认导出目录
  ipcMainHandle("set-default-export-dir", async (...args: unknown[]) => {
    const [dirPath] = args as [string];
    return await fileManager.setDefaultExportDir(dirPath);
  });

  // Excel导入相关处理器
  ipcMainHandle("import-from-excel", async (...args: unknown[]) => {
    const [filePath, options] = args as [string | undefined, any];
    return await fileManager.importFromExcel(filePath, options);
  });

  ipcMainHandle("import-from-directory", async (...args: unknown[]) => {
    const [directory, options] = args as [string | undefined, any];
    
    let targetDirectory = directory;
    
    // 如果没有提供目录路径，打开目录选择对话框
    if (!targetDirectory) {
      const result = await dialog.showOpenDialog({
        title: 'Select Directory to Import',
        defaultPath: fileManager.getDefaultExportDir(),
        properties: ['openDirectory']
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false, cancelled: true, errors: ['User cancelled import'] };
      }

      targetDirectory = result.filePaths[0];
    }
    
    return await fileManager.importFromDirectory(targetDirectory, options);
  });

  // ==========================================

  createTray(mainWindow);
  createMenu(mainWindow);
  handleCloseEvenets(mainWindow);
  // 获取串口列表
  // try {
  //   const ports = await getAvailablePorts();
  //   console.log("Serial ports detected:");

  //   // 使用简单的日志格式避免编码问题
  //   ports.forEach((port, index) => {
  //     console.log(`Port ${index + 1}:`);
  //     console.log(`  Path: ${port.path}`);
  //     console.log(`  Manufacturer: ${port.manufacturer || "Unknown"}`);
  //     console.log(`  Vendor ID: ${port.vendorId || "N/A"}`);
  //     console.log(`  Product ID: ${port.productId || "N/A"}`);
  //     console.log(`  Serial Number: ${port.serialNumber || "N/A"}`);
  //     console.log("---");
  //   });
  // } catch (error) {
  //   console.error("Error getting serial ports:", error);
  // }
});

function handleCloseEvenets(mainWindow: BrowserWindow) {
  let willClose = false;

  mainWindow.on("close", (e) => {
    if (willClose) {
      return;
    }

    e.preventDefault();
    mainWindow.hide();
    if (app.dock) {
      app.dock.hide();
    }
  });

  app.on("before-quit", () => {
    willClose = true;
    // 清理自动更新管理器
    if (autoUpdaterManager) {
      autoUpdaterManager.destroy();
    }
  });

  mainWindow.on("show", () => {
    willClose = false;
  });
}
