import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import "./CounterDashboard.css";
import {
  protocolManager,
  CountingProtocolData,
  getCountingStatus,
  isSessionStart,
  isSessionEnd,
  isSessionUpdate,
  generateSnowflakeId,
  generateSessionNoFromId,
  debugLog,
} from "./protocols";
import { initializeProtocols } from "./protocols/init";
import { SessionDetailDrawer } from "./components/SessionDetailDrawer";
import { VirtualCountingRecords } from "./components/VirtualCountingRecords";
import ExportPanel from "./components/ExportPanel";
import {
  formatAmount,
  formatCurrency,
  formatDenomination,
} from "./common/common";
import {
  SessionData,
  DenominationDetail,
  CounterData,
  CurrencyCountRecord,
  BaseProtocolData,
  ZMCommandCode,
} from "./common/types";
import { useAppConfigStore, usePageDataStore } from "./contexts/store";
import { getSerialPortManager } from "./utils/SerialPortManager";
import toast from "react-hot-toast";

export interface CounterStats {
  totalRecords: Map<string, CurrencyCountRecord>; // 改为必需字段，包含所有货币的统计信息
  totalSessions: number;
  totalNotes?: number;
  averageSpeed?: number;
  errorPcs?: number;

  /**
   * @deprecated 请使用 totalRecords 替代
   */
  totalAmount?: number;
}

interface CounterDashboardProps {
  className?: string;
}

/* 日志服务 */

function logProtocolEvent(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  metadata?: Record<string, unknown>
): void {
  const electronApi = window?.electron;
  if (!electronApi?.writeLog) return;

  void electronApi.writeLog({
    level,
    channel: "ui-protocol",
    source: "CounterDashboard",
    message,
    metadata,
  });
}

// Session管理函数 - 处理点钞会话
const handleSessionUpdate = (
  protocolData: CountingProtocolData,
  currentSession: SessionData | null | undefined,
  autoSave: boolean = true,
  setCurrentSession: (session: SessionData | null) => void,
  setSessionData: (updater: (prev: SessionData[]) => SessionData[]) => void
): SessionData => {
  const status = getCountingStatus(protocolData.status);
  const now = new Date();
  // 如果状态是开始刷新，创建新Session (开始协议不携带金额和面额)
  if (isSessionStart(protocolData.status)) {
    // 如果有已完成的Session，先保存到历史记录
    if (currentSession && currentSession.status === "completed") {
      console.log(
        "Previous completed session archived before starting new session"
      );
    }
    const id = generateSnowflakeId();
    const newSession: SessionData = {
      id: id,
      no: generateSessionNoFromId(id), //TODO: 这里需要根据实际情况生成会话编号
      timestamp: now.toLocaleString(),
      startTime: now.toLocaleString(),
      currencyCode: protocolData.currencyCode || "",
      totalCount: 0,
      totalAmount: 0,
      errorCount: 0,
      status: status,
      errorCode:
        protocolData.errorCode !== 0
          ? `E${protocolData.errorCode
              .toString(16)
              .padStart(3, "0")
              .toUpperCase()}`
          : undefined,
      denominationBreakdown: new Map(),
      currencyCountRecords: new Map<string, CurrencyCountRecord>(),
      details: [], // 初始化为空数组
    };

    setCurrentSession(newSession);
    return newSession;
  }

  // 如果没有当前Session但不是开始状态，说明有问题，创建一个临时Session
  if (!currentSession) {
    logProtocolEvent("warn", "No current session found, creating a temporary session", {
      protocolData,
    });
    const tempSession: SessionData = {
      id: generateSnowflakeId(),
      no: 999,
      timestamp: now.toLocaleString(),
      startTime: now.toLocaleString(),
      totalCount: isSessionUpdate(protocolData.status)
        ? protocolData.totalCount
        : 0,
      totalAmount: isSessionUpdate(protocolData.status)
        ? protocolData.totalAmount
        : 0,
      errorCount: 0, // 临时Session错误张数初始化为0
      status: status,
      errorCode:
        protocolData.errorCode !== 0
          ? `E${protocolData.errorCode
              .toString(16)
              .padStart(3, "0")
              .toUpperCase()}`
          : undefined,
      denominationBreakdown: new Map(),
      currencyCountRecords: new Map<string, CurrencyCountRecord>(),
    };

    setCurrentSession(tempSession);
    return tempSession;
  }

  // 更新当前Session
  const updatedSession: SessionData = {
    ...currentSession,
    status: status,
    errorCode:
      protocolData.errorCode !== 0
        ? `E${protocolData.errorCode
            .toString(16)
            .padStart(3, "0")
            .toUpperCase()}`
        : undefined,
  };

  // 只有在刷新中状态时才更新金额和张数 (因为只有这种协议携带有效的金额和面额数据)
  if (isSessionUpdate(protocolData.status)) {
    updatedSession.totalCount = protocolData.totalCount;
    updatedSession.totalAmount = protocolData.totalAmount;

    let currencyCode = protocolData.currencyCode || "";
    let denomination = protocolData.denomination || 0;

    // 如果有错误代码，累积错误张数, 并且货币代码和面额都有可能是错的，不能直接使用
    if (protocolData.errorCode !== 0) {
      currencyCode = "";
      denomination = 0;
      updatedSession.errorCount = (currentSession.errorCount || 0) + 1;
    }
    else if (protocolData.currencyCode === "" || protocolData.currencyCode.length < 3) {
      currencyCode = "-";
    }
    else 
    {
      // 没报错，则记录对应货币的计数记录
      const record = updatedSession.currencyCountRecords?.get(
        protocolData.currencyCode
      );
      if (record) {
        record.totalCount += 1;
        record.totalAmount += protocolData.denomination;
        // record.errorCount += protocolData.errorCode !== 0 ? 1 : 0;

        record.denominationBreakdown.set(protocolData.denomination, {
          denomination: protocolData.denomination,
          count:
            (record.denominationBreakdown.get(protocolData.denomination)
              ?.count || 0) + 1,
          amount:
            (record.denominationBreakdown.get(protocolData.denomination)
              ?.amount || 0) + protocolData.denomination,
        });
      } 
      else 
      {
        updatedSession.currencyCountRecords?.set(protocolData.currencyCode, {
          currencyCode: protocolData.currencyCode,
          totalCount: 1,
          totalAmount: protocolData.denomination,
          errorCount: protocolData.errorCode !== 0 ? 1 : 0,
          denominationBreakdown: new Map<number, DenominationDetail>().set(
            protocolData.denomination,
            {
              denomination: protocolData.denomination,
              count: 1,
              amount: protocolData.denomination,
            }
          ),
        });
      }
    }

    // 更新面额分布统计
    // updatedSession.denominationBreakdown.set(protocolData.currencyCode, {
    //   denomination: protocolData.denomination,
    //   count:
    //     (updatedSession.denominationBreakdown.get(protocolData.currencyCode)
    //       ?.count || 0) + 1,
    //   amount:
    //     (updatedSession.denominationBreakdown.get(protocolData.currencyCode)
    //       ?.amount || 0) + protocolData.denomination,
    // });

    // 创建计数记录详情
    updatedSession.details?.push({
      id: generateSnowflakeId(),
      no: (currentSession.details?.length || 0) + 1,
      timestamp: now.toLocaleString(),
      currencyCode: currencyCode,
      denomination: denomination,
      status: status,
      errorCode: "E" + protocolData.errorCode.toString(10),
      serialNumber: protocolData.serialNumber || "",
    });

    // 限制单个session的details数组大小，防止内存过度使用
    if (updatedSession.details && updatedSession.details.length > 2000) {
      updatedSession.details = updatedSession.details.slice(-2000);
    }

    logProtocolEvent("info", "Updated session with protocol data", {
      protocolData,
      updatedSession,
    });
  }

  // 如果Session完成，添加到历史记录但保留在当前Session显示 (结束协议不携带金额数据)
  if (isSessionEnd(protocolData.status)) 
  {
    updatedSession.endTime = now.toLocaleString();

    // 判断有无实际点钞数据
    if (
      updatedSession.totalCount <= 0 &&
      (updatedSession.currencyCountRecords?.size || 0) === 0
    ) {
      // toast.error("No valid counting data found in this session.");
      return updatedSession;
    }
    // 校验明细总数与协议totalCount是否一致（仅日志告警，不影响功能）
    const detailTotal = Array.from(
      updatedSession.currencyCountRecords?.values() || []
    ).reduce((sum, r) => sum + r.totalCount, 0) + (updatedSession.errorCount || 0);
    if (detailTotal !== updatedSession.totalCount) {
      logProtocolEvent("warn", "Detail count mismatch detected at session end", {
        totalCount: updatedSession.totalCount,
        detailTotal,
        diff: updatedSession.totalCount - detailTotal,
      });
    }

    setSessionData((prev) => [updatedSession, ...prev].slice(0, 50));
    setCurrentSession(null);
    if (autoSave) {
      autoSaveHandler(updatedSession); // 自动保存当前Session
    }
  } 
  else 
  {
    setCurrentSession(updatedSession);
  }
  return updatedSession;
};

const autoSaveHandler = async (session: SessionData) => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const ret = await window.electron.exportExcel(session ? [session] : [], {
    useDefaultDir: true,
    openAfterExport: false,
    customDir: undefined,
    filename: `CounterSession_#${session.no}_${timestamp}.xlsx`,
  });

  if ( ret.success ) {
    toast.success(`Auto-saved Excel Successfully`);
  }
  else {
    toast.error(`Auto-save Failed`);
  }
};

export const CounterDashboard: React.FC<CounterDashboardProps> = ({
  className,
}) => {
  const { t } = useTranslation();
  const serialManager = getSerialPortManager();

  // 初始化协议解析器
  useEffect(() => {
    initializeProtocols();
  }, []);
  const sessionData = usePageDataStore((state) => state.sessions);
  const setSessionData = usePageDataStore((state) => state.setSessions);
  const currentSession = usePageDataStore((state) => state.currentSession);
  const setCurrentSession = usePageDataStore(
    (state) => state.setCurrentSession
  );
  const stats = usePageDataStore((state) => state.stats);
  const setStats = usePageDataStore((state) => state.setStats);

  const autoSave = useAppConfigStore((state) => state.autoSave);
  const serialConnected = useAppConfigStore((state) => state.serialConnected);

  const [isConnected, setIsConnected] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [simulationInterval, setSimulationInterval] = useState<number | null>(
    null
  );
  const [simulationSession, setSimulationSession] =
    useState<SessionData | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<
    "1h" | "24h" | "7d" | "30d"
  >("24h");
  // 抽屉相关状态
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [isDetailDrawerOpen, setIsDetailDrawerOpen] = useState(false);
  const [isExportPanelOpen, setIsExportPanelOpen] = useState(false);
  // 面额显示Tab状态
  const [selectedCurrencyTab, setSelectedCurrencyTab] = useState<string>("");

  // 窗口宽度状态（用于响应式布局判断）
  const [windowWidth, setWindowWidth] = useState(() => {
    return typeof window !== "undefined" ? window.innerWidth : 1200;
  });

  // 数据列表容器高度状态（用于虚拟滚动）- 使用固定高度
  const [dataListHeight] = useState(392); // 7行 × 56px/行 = 392px，确保完整显示行数

  // 默认显示的货币数量
  const DEFAULT_CURRENCY_DISPLAY_COUNT = 3;
  // 两列布局下的显示数量
  const TWO_COLUMN_CURRENCY_DISPLAY_COUNT = 4;

  // 获取当前布局下的默认显示数量
  const getCurrentLayoutDisplayCount = () => {
    // 在宽屏幕下使用两列布局时，可以显示更多货币
    if (windowWidth >= 1200) {
      return TWO_COLUMN_CURRENCY_DISPLAY_COUNT;
    }
    return DEFAULT_CURRENCY_DISPLAY_COUNT;
  };

  // 判断是否有隐藏的货币
  const hasHiddenCurrencies = () => {
    return hasHiddenCurrenciesFlag;
  };

  // ===== 性能优化：缓存复杂计算结果 =====

  // 1. 缓存可用货币列表
  const availableCurrencies = useMemo(() => {
    return Array.from(stats.totalRecords.keys()).sort();
  }, [stats.totalRecords]);

  // 2. 缓存总计数（避免循环依赖）
  const totalCount = useMemo(() => {
    return Array.from(stats.totalRecords.values()).reduce(
      (sum, record) => sum + record.totalCount,
      0
    );
  }, [stats.totalRecords]);

  // 3. 缓存排序后的货币统计数据
  const sortedCurrencyStats = useMemo(() => {
    return Array.from(stats.totalRecords.entries())
      .map(([code, record]) => ({
        currencyCode: code,
        amount: record.totalAmount,
        noteCount: record.totalCount,
        errorCount: record.errorCount,
        percentage: totalCount > 0 ? (record.totalCount / totalCount) * 100 : 0,
      }))
      .sort((a, b) => b.noteCount - a.noteCount);
  }, [stats.totalRecords, totalCount]);

  // 4. 缓存布局相关计算
  const layoutDisplayCount = useMemo(() => {
    return windowWidth >= 1200
      ? TWO_COLUMN_CURRENCY_DISPLAY_COUNT
      : DEFAULT_CURRENCY_DISPLAY_COUNT;
  }, [windowWidth]);

  // 5. 缓存布局判断
  const shouldUseMultiCurrencyLayoutFlag = useMemo(() => {
    return availableCurrencies.length > 1;
  }, [availableCurrencies.length]);

  const hasHiddenCurrenciesFlag = useMemo(() => {
    return sortedCurrencyStats.length > layoutDisplayCount;
  }, [sortedCurrencyStats.length, layoutDisplayCount]);

  // 6. 缓存按货币分组的面额详情
  const denominationDetailsByCurrency = useMemo(() => {
    const currencyDetailsMap = new Map<string, DenominationDetail[]>();
    stats.totalRecords.forEach((record, currencyCode) => {
      const details = Array.from(record.denominationBreakdown.values()).sort(
        (a, b) => b.denomination - a.denomination
      );
      currencyDetailsMap.set(currencyCode, details);
    });
    return currencyDetailsMap;
  }, [stats.totalRecords]);

  // 7. 缓存当前选中货币的相关数据
  const currentCurrencyData = useMemo(() => {
    if (!selectedCurrencyTab) return null;

    const record = stats.totalRecords.get(selectedCurrencyTab);
    const details =
      denominationDetailsByCurrency.get(selectedCurrencyTab) || [];

    return {
      record,
      details,
      totalCount: record?.totalCount || 0,
      totalAmount: record?.totalAmount || 0,
    };
  }, [selectedCurrencyTab, stats.totalRecords, denominationDetailsByCurrency]);

  // ===== 辅助函数定义（需要在useMemo之前） =====

  // 获取Session的货币显示
  const getSessionCurrencyDisplay = useCallback(
    (session: SessionData): string => {
      // 如果有新的货币记录结构
      if (
        session.currencyCountRecords &&
        session.currencyCountRecords.size > 0
      ) {
        const currencies = Array.from(session.currencyCountRecords.keys());
        if (currencies.length === 1) {
          return currencies[0];
        } else if (currencies.length > 1) {
          return "MULTI";
        }
      }

      // 兼容旧数据结构
      return session.currencyCode || "-";
    },
    []
  );

  const getAmountDisplay = useCallback((session: SessionData): string => {
    if (session.currencyCountRecords && session.currencyCountRecords.size > 0) {
      const currencies = Array.from(session.currencyCountRecords.keys());
      if (currencies.length === 1) {
        return formatAmount(
          session.currencyCountRecords.get(currencies[0])?.totalAmount || 0,
          {
            currency: currencies[0],
          }
        );
      } else if (currencies.length > 1) {
        return currencies.length + " Currencies";
      }
    }

    const totalAmount = session.totalAmount || 0;
    return formatCurrency(totalAmount, { currency: session.currencyCode || "-" });
  }, []);

  // 8. 缓存渲染用的会话数据
  const renderSessionData = useMemo(() => {
    return sessionData.map((item) => ({
      ...item,
      displayCurrency: getSessionCurrencyDisplay(item),
      displayAmount:  getAmountDisplay(item),
      formattedCount: (item.totalCount - item.errorCount).toLocaleString(),
      formattedEndDate: item.endTime
        ? new Date(item.endTime).toLocaleDateString()
        : null,
      hasError: (item.errorCount || 0) > 0,
    }));
  }, [sessionData, getSessionCurrencyDisplay, getAmountDisplay]);

  // 监听窗口大小变化以支持响应式布局
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    if (typeof window !== "undefined") {
      window.addEventListener("resize", handleResize);
      // 初始计算一次
      handleResize();
      return () => window.removeEventListener("resize", handleResize);
    }
  }, []);

  // 监听真实的串口连接状态 - 使用 SerialPortManager
  useEffect(() => {
    // 初始化连接状态
    const initializeConnectionStatus = async () => {
      try {
        await serialManager.initialize();
        setIsConnected(serialManager.isConnected());
      } catch (error) {
        console.error("Failed to initialize SerialPortManager:", error);
      }
    };

    initializeConnectionStatus();

    // 设置事件监听器
    serialManager.addEventListener({
      onConnected: () => {
        setIsConnected(true);
      },
      onDisconnected: () => {
        setIsConnected(false);
      },
      onConnectionStateChanged: (connected) => {
        setIsConnected(connected);
      }
    });

    return () => {
      serialManager.removeEventListener();
    };
  }, [serialManager]); // 监听串口数据并解析协议 - 使用新的协议管理器

  // 使用策略模式对不同协议的不同模式码进行处理
  const handleProtocolData = useCallback((protocolDataArr: BaseProtocolData[]) => {
    console.log("Received protocol data:", protocolDataArr);
    let sessionInBatch: SessionData | null | undefined = currentSession;

    protocolDataArr.forEach((data) => {
      switch (data.protocolType) {
        case "ZMProtocol":
          if (data.cmdGroup == ZMCommandCode.HANDSHAKE) {
            console.log("----------Received ZM handshake data:", data);
            // setSerialConnected(true);
          } else if (data.cmdGroup === ZMCommandCode.COUNT_RESULT) {
            console.log("Received ZM count result data:", data);
            // 处理ZM点钞结果数据
            const updatedSession = handleSessionUpdate(
              data as CountingProtocolData,
              sessionInBatch,
              autoSave,
              setCurrentSession,
              setSessionData
            );

            // 关键修复：同一批协议里串行传递最新会话，避免“刷新+结束”同包时使用过期会话
            sessionInBatch = isSessionEnd((data as CountingProtocolData).status)
              ? null
              : updatedSession;

            console.log("Updated session from hex data:", updatedSession);
          }
          break;
        case "OtherProtocol":
          // 处理其他协议数据
          break;
        default:
          console.warn("Unknown protocol type:", data.protocolType);
      }
    });
  }, [currentSession, autoSave, setCurrentSession, setSessionData]);

  useEffect(() => {
    console.log("Dashboard Setting up serial data listener...");
    const unsubscribeDataReceived = window.electron.onSerialDataReceived(
      (data) => {
        // 只处理十六进制数据
        if (data.hexData && isConnected) {
          try {
            // 使用协议管理器解析数据
            const protocolDataArr = protocolManager.parseData(
              data.hexData
            ) as BaseProtocolData[];

            handleProtocolData(protocolDataArr);
          } catch (error) {
            console.error("Error parsing serial data:", error);
          }
        }
      }
    );
    return () => {
      unsubscribeDataReceived();
    };
  }, [isConnected, handleProtocolData]);

  const getFilteredData = useCallback(() => {
    const now = new Date();
    const timeRanges = {
      "1h": 1 * 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };

    const cutoffTime = now.getTime() - timeRanges[selectedTimeRange];
    const filteredSessionData = sessionData.filter((item) => {
      const itemTime = new Date(
        `${item.timestamp}`
      ).getTime();
      return itemTime >= cutoffTime;
    });
    console.log(`sessionData length: ${sessionData.length}`);
    console.log(`Filtered session data length: ${filteredSessionData.length}`);

    return filteredSessionData;
  }, [sessionData, selectedTimeRange]);
  // 计算统计数据
  useEffect(() => {
    const filteredData = getFilteredData();
    console.log("Filtered session data:", filteredData);

    // 构建totalRecords - 汇总所有Session的货币统计信息
    const totalRecords = new Map<string, CurrencyCountRecord>();
    let errorPcs = 0;
    let totalNotes = 0;
    let totalAmount = 0;

    filteredData.forEach((session) => {
      errorPcs += session.errorCount || 0;
      totalNotes += session.totalCount || 0;
      totalAmount += session.totalAmount || 0;
      if (session.currencyCountRecords) {
        // 使用新的货币记录结构
        session.currencyCountRecords.forEach((record, currencyCode) => {
          const existing = totalRecords.get(currencyCode);
          if (existing) {
            // 合并现有记录
            existing.totalCount += record.totalCount;
            existing.totalAmount += record.totalAmount;
            existing.errorCount += record.errorCount;


            // 合并面额分布
            record.denominationBreakdown.forEach((detail, denomination) => {
              const existingDetail =
                existing.denominationBreakdown.get(denomination);
              if (existingDetail) {
                existingDetail.count += detail.count;
                existingDetail.amount += detail.amount;
              } else {
                existing.denominationBreakdown.set(denomination, { ...detail });
              }
            });
          } else {
            // 创建新记录，深拷贝面额分布
            const newDenominationBreakdown = new Map<
              number,
              DenominationDetail
            >();
            record.denominationBreakdown.forEach((detail, denomination) => {
              newDenominationBreakdown.set(denomination, { ...detail });
            });

            totalRecords.set(currencyCode, {
              currencyCode: record.currencyCode,
              totalCount: record.totalCount,
              totalAmount: record.totalAmount,
              errorCount: record.errorCount,
              denominationBreakdown: newDenominationBreakdown,
            });
          }
        });
      } else {
        // 兼容旧数据结构
        const currencyCode = session.currencyCode || "CNY";
        const existing = totalRecords.get(currencyCode);

        if (existing) {
          existing.totalCount += session.totalCount;
          existing.totalAmount += session.totalAmount || 0;
          existing.errorCount += session.errorCount || 0;

          // 合并旧的面额分布
          if (session.denominationBreakdown) {
            session.denominationBreakdown.forEach((detail, denomination) => {
              const existingDetail =
                existing.denominationBreakdown.get(denomination);
              if (existingDetail) {
                existingDetail.count += detail.count;
                existingDetail.amount += detail.amount;
              } else {
                existing.denominationBreakdown.set(denomination, { ...detail });
              }
            });
          }
        } else {
          // 创建新记录
          const newDenominationBreakdown = new Map<
            number,
            DenominationDetail
          >();
          if (session.denominationBreakdown) {
            session.denominationBreakdown.forEach((detail, denomination) => {
              newDenominationBreakdown.set(denomination, { ...detail });
            });
          }

          totalRecords.set(currencyCode, {
            currencyCode,
            totalCount: session.totalCount,
            totalAmount: session.totalAmount || 0,
            errorCount: session.errorCount || 0,
            denominationBreakdown: newDenominationBreakdown,
          });
        }
      }
    });

    const newStats: CounterStats = {
      totalRecords,
      totalSessions: filteredData.length,
      totalAmount,
      totalNotes,
      averageSpeed: 0, // Session模式下暂不计算速度
      errorPcs,
    };
    setStats(newStats);
  }, [getFilteredData, setStats]);

  const clearData = () => {
    setSessionData(() => []);
    setCurrentSession(null);
    setSelectedSessionId(null); // 清除选中的session引用
    setSimulationSession(null); // 清除仿真session引用
    setIsDetailDrawerOpen(false); // 关闭抽屉
    // 重置统计数据
    setStats({
      totalRecords: new Map<string, CurrencyCountRecord>(),
      totalSessions: 0,
      totalAmount: 0,
      totalNotes: 0,
      averageSpeed: 0,
      errorPcs: 0,
    });
  };
  // 清空当前Session，但保留历史记录
  const clearCurrentSession = useCallback(() => {
    setCurrentSession(null);
  }, [setCurrentSession]);

  // 处理Session详情抽屉
  const handleSessionClick = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setIsDetailDrawerOpen(true);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setIsDetailDrawerOpen(false);
    setSelectedSessionId(null); // 清除选中的session引用，确保GC
  }, []);

  const handleExportPanelOpen = useCallback(() => {
    setIsExportPanelOpen(true);
  }, []);

  const handleExportPanelClose = useCallback(() => {
    setIsExportPanelOpen(false);
  }, []);

  const handleExportComplete = useCallback(
    (result: { success: boolean; message?: string }) => {
      console.log("Export completed in dashboard:", result);
      // 可以在这里添加导出完成后的处理逻辑
      // 比如显示成功消息、更新状态等
    },
    []
  );

  // 时间范围选择处理
  const handleTimeRangeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedTimeRange(e.target.value as "1h" | "24h" | "7d" | "30d");
    },
    []
  );

  // 货币Tab点击处理
  const handleCurrencyTabClick = useCallback((currencyCode: string) => {
    setSelectedCurrencyTab(currencyCode);
  }, []);

  // 仿真数据生成器
  const generateSimulationData = (): CountingProtocolData => {
    const denominations = [1, 5, 10, 20, 50, 100];
    const randomDenomination =
      denominations[Math.floor(Math.random() * denominations.length)];

    // 随机生成一些错误
    const hasError = Math.random() < 0.05; // 5% 错误率
    return {
      timestamp: new Date().toLocaleString(),
      protocolType: "simulation",
      rawData: "simulation_data",
      status: 0x02, // 刷新中状态
      totalCount: (simulationSession?.totalCount || 0) + 1,
      totalAmount: (simulationSession?.totalAmount || 0) + randomDenomination,
      denomination: randomDenomination,
      currencyCode: "CNY",
      errorCode: hasError ? Math.floor(Math.random() * 10) + 1 : 0,
      serialNumber: `SIM${Date.now().toString().slice(-6)}`,
      reserved1: [0, 0, 0, 0],
      reserved2: 0,
    };
  };

  // 开始仿真模式
  const startSimulation = () => {
    if (isSimulationMode) return;
    console.log("🎮 Starting simulation mode...");
    setIsSimulationMode(true);

    const currencyCode = "CNY"; // 默认货币代码

    // 创建新的仿真会话
    const newSession: SessionData = {
      id: generateSnowflakeId(),
      no: (currentSession ? currentSession.no + 1 : 1) || 1,
      timestamp: new Date().toLocaleTimeString(),
      startTime: new Date().toLocaleString(),
      totalCount: 0,
      totalAmount: 0,
      errorCount: 0,
      currencyCode: currencyCode,
      status: "counting",
      currencyCountRecords: new Map<string, CurrencyCountRecord>(),
      denominationBreakdown: new Map(),
      details: [],
    };

    setCurrentSession(newSession);
    setSimulationSession(newSession);

    // 每500ms生成一个仿真数据
    const interval = window.setInterval(() => {
      const simulationData = generateSimulationData();
      const updatedSession = handleSessionUpdate(
        simulationData,
        simulationSession,
        autoSave,
        setSimulationSession,
        setSessionData
      );

      setCurrentSession(updatedSession);

      console.log("Generated simulation data:", simulationData);
    }, 500);

    setSimulationInterval(interval);
  };

  // 停止仿真模式
  const stopSimulation = () => {
    if (!isSimulationMode) return;

    console.log("🛑 Stopping simulation mode...");
    setIsSimulationMode(false);

    if (simulationInterval) {
      clearInterval(simulationInterval);
      setSimulationInterval(null);
    }

    // 完成当前仿真会话
    if (simulationSession) {
      const completedSession: SessionData = {
        ...simulationSession,
        status: "completed",
        endTime: new Date().toLocaleString(),
      };

      setCurrentSession(completedSession);
      setSessionData((prev) => [completedSession, ...prev].slice(0, 50));
      setSimulationSession(null);
    }
  };

  // 生成批量测试数据
  const generateTestData = async () => {
    console.log("📊 Generating test data...");

    const testSessions: SessionData[] = [];
    const now = new Date();
    const currencyCodes = [
      "CNY",
      "USD",
      "EUR",
      "JPY",
      "GBP",
      "AUD",
      "CAD",
      "CHF",
      "HKD",
      "SGD",
    ];

    // 生成50个测试会话，确保有多货币数据
    for (let i = 0; i < 10; i++) {
      const sessionTime = new Date(now.getTime() + i * 60 * 60 * 1000); // 每小时一个会话
      const denominationBreakdown = new Map<number, DenominationDetail>();
      const currencyCountRecords = new Map<string, CurrencyCountRecord>();
      const details: CounterData[] = [];

      let totalCount = 0;
      let totalAmount = 0;
      let errorCount = 0;

      // 为每个会话生成随机数据
      const noteCount = Math.floor(Math.random() * 100) + 20; // 20-119张

      // 决定这个会话是单货币还是多货币
      const isMultiCurrency = i < 5; // 前5个会话使用多货币
      const sessionCurrencies = isMultiCurrency
        ? currencyCodes.slice(0, Math.floor(Math.random() * 3) + 2) // 2-4种货币
        : [currencyCodes[Math.floor(Math.random() * currencyCodes.length)]]; // 单一货币

      for (let j = 0; j < noteCount; j++) {
        const denominations = [1, 5, 10, 20, 50, 100];
        const denomination =
          denominations[Math.floor(Math.random() * denominations.length)];
        const hasError = Math.random() < 0.03; // 3% 错误率

        // 从当前会话的货币列表中随机选择一个货币
        const currencyCode =
          sessionCurrencies[
            Math.floor(Math.random() * sessionCurrencies.length)
          ];

        totalCount++;
        totalAmount += denomination;
        if (hasError) errorCount++;

        // 更新面额统计, 增加多个货币情况下面额统计处理
        const currencyRecord = currencyCountRecords.get(currencyCode);
        if (currencyRecord) {
          currencyRecord.totalCount++;
          currencyRecord.totalAmount += denomination;
          currencyRecord.errorCount += hasError ? 1 : 0;

          // 更新面额分布
          const existingDetail =
            currencyRecord.denominationBreakdown.get(denomination);
          if (existingDetail) {
            existingDetail.count++;
            existingDetail.amount += denomination;
          } else {
            currencyRecord.denominationBreakdown.set(denomination, {
              denomination,
              count: 1,
              amount: denomination,
            });
          }
        } else {
          currencyCountRecords.set(currencyCode, {
            currencyCode,
            totalCount: 1,
            totalAmount: denomination,
            errorCount: hasError ? 1 : 0,
            denominationBreakdown: new Map<number, DenominationDetail>([
              [
                denomination,
                {
                  denomination,
                  count: 1,
                  amount: denomination,
                },
              ],
            ]),
          });
        }

        const existing = denominationBreakdown.get(denomination);
        if (existing) {
          denominationBreakdown.set(denomination, {
            denomination,
            count: existing.count + 1,
            amount: existing.amount + denomination,
          });
        } else {
          denominationBreakdown.set(denomination, {
            denomination,
            count: 1,
            amount: denomination,
          });
        }

        // 添加详细记录
        details.push({
          id: generateSnowflakeId() + j,
          no: j + 1,
          timestamp: new Date(
            sessionTime.getTime() + j * 1000
          ).toLocaleString(),
          currencyCode: currencyCode,
          denomination,
          status: hasError ? "error" : "completed",
          errorCode: hasError
            ? `E${Math.floor(Math.random() * 10) + 1}`
            : undefined,
          serialNumber: `TEST${Date.now().toString().slice(-6)}${j}`,
        });
      }

      const id = generateSnowflakeId();
      const testSession: SessionData = {
        id,
        no: generateSessionNoFromId(id),
        timestamp: sessionTime.toLocaleString(),
        startTime: sessionTime.toLocaleString(),
        endTime: new Date(
          sessionTime.getTime() + 5 * 60 * 1000
        ).toLocaleString(), // 5分钟后结束
        machineMode: i % 2 === 0 ? "AUTO" : "MANUAL",
        currencyCode: sessionCurrencies[0], // 主要货币代码
        currencyCountRecords,
        totalCount,
        totalAmount,
        errorCount,
        status: "completed",
        denominationBreakdown,
        details,
      };

      testSessions.push(testSession);
      autoSaveHandler(testSession); // 自动保存测试数据
      await new Promise(resolve => setTimeout(resolve, 100)); // 延时
      debugLog(`Generated test session ${i + 1}:`, testSession);
    } // 添加到会话数据中
    setSessionData((prev) => [...testSessions, ...prev].slice(0, 50));

    debugLog(
      `✅ Generated ${testSessions.length} test sessions with total data`
    );
  };
  // 获取选中的Session数据
  const getSelectedSession = useCallback((): SessionData | null => {
    if (!selectedSessionId) return null;
    return (
      sessionData.find((session) => session.id === selectedSessionId) || null
    );
  }, [selectedSessionId, sessionData]);
  const exportData = () => {
    console.log("Exporting session data...");

    // 检查是否有数据可以导出
    // if (sessionData.length === 0) {
    //   console.warn("No session data to export");
    //   // 可以在这里显示一个提示消息
    //   return;
    // }

    // 打开导出面板
    handleExportPanelOpen();
  };
  // ===== 以下函数现在只用于兼容性，实际使用缓存结果 =====

  // 计算总张数（所有货币）
  const getTotalCount = (): number => {
    return totalCount;
  };

  // 获取可用的货币代码列表
  const getAvailableCurrencies = (): string[] => {
    return availableCurrencies;
  };
  // 获取当前选中Tab的面额数据
  const getCurrentTabDenominationDetails = (): DenominationDetail[] => {
    return currentCurrencyData?.details || [];
  };

  // 获取当前选中Tab的总张数
  const getCurrentTabTotalCount = (): number => {
    return currentCurrencyData?.totalCount || 0;
  };

  // 获取当前选中Tab的总金额
  const getCurrentTabTotalAmount = (): number => {
    return currentCurrencyData?.totalAmount || 0;
  }; // 当有新的货币数据时，自动切换到第一个货币Tab
  useEffect(() => {
    if (availableCurrencies.length > 0) {
      // 如果当前选中的货币不存在，切换到第一个可用货币
      if (!availableCurrencies.includes(selectedCurrencyTab)) {
        setSelectedCurrencyTab(availableCurrencies[0]);
      }
    } else {
      // 如果没有货币数据，重置为空
      setSelectedCurrencyTab("");
    }
  }, [availableCurrencies, selectedCurrencyTab]);

  // 自动清除对已丢弃session的引用，确保GC能回收内存
  useEffect(() => {
    if (selectedSessionId !== null) {
      // 检查当前选中的session是否还存在于sessionData中
      const sessionExists = sessionData.some(
        (session) => session.id === selectedSessionId
      );
      if (!sessionExists) {
        // 如果session不存在，清除引用
        setSelectedSessionId(null);
        setIsDetailDrawerOpen(false); // 同时关闭抽屉
      }
    }
  }, [selectedSessionId, sessionData]);

  // 判断是否使用多货币布局
  const shouldUseMultiCurrencyLayout = () => {
    return shouldUseMultiCurrencyLayoutFlag;
  };

  // 获取排序后的货币统计数据
  const getSortedCurrencyStats = () => {
    return sortedCurrencyStats;
  };

  // 根据金额大小动态调整字体大小 - 使用缓存
  const getAmountFontSize = useCallback((amount: number) => {
    const formattedAmount = formatCurrency(amount);
    const length = formattedAmount.length;

    if (length <= 8) return "1.5rem"; // 默认大小，例如：¥1,234.00
    if (length <= 12) return "1.3rem"; // 中等金额，例如：¥12,345,678.00
    if (length <= 15) return "1.1rem"; // 较大金额，例如：¥123,456,789.00
    if (length <= 18) return "0.95rem"; // 很大金额，例如：¥1,234,567,890.00
    return "0.85rem"; // 超大金额
  }, []);

  const getStatusIcon = useCallback((status: CounterData["status"]) => {
    switch (status) {
      case "counting":
        return "⏳";
      case "completed":
        return "✅";
      case "error":
        return "❌";
      case "paused":
        return "⏸️";
      default:
        return "⭕";
    }
  }, []);

  const getStatusText = useCallback(
    (status: CounterData["status"]) => {
      switch (status) {
        case "counting":
          return t("counter.sessionStatus.counting");
        case "completed":
          return t("counter.sessionStatus.completed");
        case "error":
          return t("counter.sessionStatus.error");
        case "paused":
          return t("counter.sessionStatus.paused");
        default:
          return status;
      }
    },
    [t]
  );

  const getStatusColor = useCallback((status: CounterData["status"]) => {
    switch (status) {
      case "counting":
        return "#ffa500";
      case "completed":
        return "#28a745";
      case "error":
        return "#dc3545";
      case "paused":
        return "#ffa500";
      default:
        return "#6c757d";
    }
  }, []);

  const handleAutoConnect = useCallback(async () => {
    if ( autoConnecting ) {
      return; // 如果正在连接中，直接返回
    }
    // 直接使用 SerialPortManager 执行自动连接
    if ( serialConnected ) 
    {
      const isSuccess =  await serialManager.disconnect();
      if ( isSuccess ) {
        toast.success(t("counter.autoDisconnectSuccess", "Successfully disconnected from serial port."), { position: "top-right" });
      } else {
        toast.error(t("counter.autoDisconnectFailed", "Failed to disconnect from serial port."), { position: "top-right" });
      }
    } 
    else {
      const toastId = toast.loading(
        t("counter.autoConnectInfo", "Connecting to serial port..."),
        { position: "top-right" }
      );

      try {
        setAutoConnecting(true);
        const success = await serialManager.autoConnect();
        setAutoConnecting(false);
        
        if (success) {
          toast.success(
            t("counter.autoConnectSuccess", "Successfully connected to serial port."),
            { id: toastId }
          );
        } else {
          toast.error(
            t("counter.autoConnectFailed", "Failed to auto-connect to any serial port."),
            { id: toastId }
          );
        }
      } catch {
        toast.error(
          t("counter.autoConnectFailed", "Failed to auto-connect to any serial port."),
          { id: toastId }
        );
      }
    }
  },[serialConnected, serialManager, t, autoConnecting]);



  return (
    <div className={`counter-dashboard ${className || ""}`}>
      {" "}
      {/* 头部控制区 */}
      <div className="dashboard-header">
        <div className="dashboard-title">
          <h2>💰 {t("counter.title")}</h2>

          <button
            className="connection-status"
            onClick={handleAutoConnect}
            title={
              serialConnected ? t("counter.connected") : t("counter.disconnected")
            }
          >
            <span
              className={`status-indicator ${
                serialConnected ? "connected" : "disconnected"
              }`}
            ></span>
            <span>
              {
              autoConnecting ? (
                t("counter.autoConnecting", "Connecting...")
              ) : (
                serialConnected ? t("counter.connected") : t("counter.disconnected")
              )
              }
            </span>
          </button>
        </div>{" "}
        <div className="dashboard-controls">
          <select
            value={selectedTimeRange}
            onChange={handleTimeRangeChange}
            className="time-range-select"
          >
            <option value="1h">{t("counter.lastHour")}</option>
            <option value="24h">{t("counter.last24Hours")}</option>
            <option value="7d">{t("counter.last7Days")}</option>
            <option value="30d">{t("counter.last30Days")}</option>
          </select>{" "}
          {/* 开发模式下显示仿真控制按钮 */}
          {import.meta.env.DEV && (
            <div className="simulation-controls">
              {!isSimulationMode ? (
                <>
                  <button
                    onClick={startSimulation}
                    className="control-btn simulation-start"
                    title="Start simulation mode"
                  >
                    🎮 Start Simulation
                  </button>
                  <button
                    onClick={generateTestData}
                    className="control-btn test-data"
                    title="Generate batch test data"
                  >
                    📊 Generate Test Data
                  </button>
                </>
              ) : (
                <button
                  onClick={stopSimulation}
                  className="control-btn simulation-stop"
                  title="Stop simulation mode"
                >
                  🛑 Stop Simulation
                </button>
              )}
              {isSimulationMode && (
                <div className="simulation-status">
                  <span className="simulation-indicator">🎮</span>
                  <span>Simulation Active</span>
                </div>
              )}
            </div>
          )}
          <button onClick={clearData} className="control-btn clear">
            {t("counter.clearData")}
          </button>
          <button
            onClick={exportData}
            className={`control-btn export`}
            title={
              renderSessionData.length === 0
                ? t("counter.noDataToExport", "No data to export")
                : t("counter.exportData")
            }
          >
            {t("counter.exportData")}
          </button>
        </div>
      </div>
      {/* 统计卡片区 */}
      <div
        className={`stats-grid ${
          shouldUseMultiCurrencyLayout() ? "multi-currency" : ""
        }`}
      >
        {shouldUseMultiCurrencyLayout() ? (
          // 多货币时使用垂直堆叠行式展示
          <>
            {/* Session统计行 */}
            <div className="session-summary-row">
              <div className="session-summary-item">
                <span className="session-summary-icon">📊</span>
                <span className="session-summary-value">
                  {stats.totalSessions}
                </span>
                <span className="session-summary-label">
                  {t("counter.stats.totalSessions")}
                </span>
              </div>
              <div className="session-summary-item">
                <span className="session-summary-icon">📄</span>
                <span className="session-summary-value">
                  {getTotalCount().toLocaleString()}
                </span>
                <span className="session-summary-label">
                  {t("counter.stats.totalNotes")}
                </span>
              </div>
              <div className="session-summary-item">
                <span className="session-summary-icon">⚠️</span>
                <span className="session-summary-value">
                  {(stats.errorPcs || 0).toLocaleString()}
                </span>
                <span className="session-summary-label">
                  {t("counter.stats.errorPcs")}
                </span>
              </div>
            </div>

            {/* 货币统计行列表 - 支持层叠悬浮展开 */}
            <div
              className={`currency-stats-container ${
                hasHiddenCurrencies() ? "has-stacked" : ""
              }`}
            >
              {getSortedCurrencyStats().map((currencyStats, index) => {
                const visibleCount = getCurrentLayoutDisplayCount();
                const isLastVisible = index === visibleCount - 1;
                const isStacked = index >= visibleCount;
                const stackedCount =
                  getSortedCurrencyStats().length - visibleCount;

                return (
                  <div
                    key={currencyStats.currencyCode}
                    className={`currency-stats-row ${
                      isStacked ? "stacked" : "visible"
                    } ${
                      isLastVisible && hasHiddenCurrencies()
                        ? "last-visible"
                        : ""
                    }`}
                    data-currency={currencyStats.currencyCode}
                    data-stack-index={
                      isStacked ? index - visibleCount + 1 : undefined
                    }
                    onClick={() =>
                      handleCurrencyTabClick(currencyStats.currencyCode)
                    }
                    role="button"
                    tabIndex={0}
                    title={t(
                      "counter.clickToViewCurrencyDetails",
                      "Click to view currency details"
                    )}
                  >
                    <div className="currency-info">
                      <div className="currency-code">
                        {/* <span className="currency-flag">{getCurrencyFlag(currencyStats.currencyCode)}</span> */}
                        <span className="currency-text">
                          {currencyStats.currencyCode}
                        </span>
                      </div>
                      <div className="currency-amount">
                        {formatCurrency(currencyStats.amount, { currency: currencyStats.currencyCode })}
                      </div>
                      <div className="currency-notes">
                        {currencyStats.noteCount.toLocaleString()}{" "}
                        {t("counter.detailTable.pcs", "notes")}
                      </div>
                      {/* <div className="currency-errors">
                        ⚠️ {currencyStats.errorCount.toLocaleString()}
                      </div> */}
                      {/* <div className="currency-percentage">
                        {currencyStats.percentage.toFixed(1)}%
                      </div> */}
                    </div>

                    {/* 层叠角标 - 仅在最后一个可见卡片上显示 */}
                    {isLastVisible && hasHiddenCurrencies() && (
                      <div
                        className="stacked-badge"
                        title={t(
                          "counter.stackedCurrencies",
                          `${stackedCount} more currencies`
                        )}
                      >
                        <span className="stacked-count">+{stackedCount}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          // 单货币时使用传统4卡片展示
          <>
            <div className="stat-card">
              <div className="stat-icon">📊</div>
              <div className="stat-info">
                <div className="stat-value">{stats.totalSessions}</div>
                <div className="stat-label">
                  {t("counter.stats.totalSessions")}
                </div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon">💴</div>
              <div className="stat-info">
                <div
                  className="stat-value"
                  style={{
                    fontSize: getAmountFontSize(stats.totalAmount || 0),
                  }}
                >
                  {formatCurrency(stats.totalAmount || 0, { showCurrencySymbol: false })}
                </div>
                <div className="stat-label">
                  {t("counter.stats.totalAmount")}
                </div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon">📄</div>
              <div className="stat-info">
                <div className="stat-value">
                  {(() => {
                    const availableCurrencies = getAvailableCurrencies();
                    if (availableCurrencies.length === 1) {
                      // 单一货币时显示当前Tab张数
                      return getCurrentTabTotalCount().toLocaleString();
                    } else {
                      // 无数据时显示0
                      return "0";
                    }
                  })()}
                </div>
                <div className="stat-label">
                  {t("counter.stats.totalNotes")}
                </div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon">⚠️</div>
              <div className="stat-info">
                <div className="stat-value error-stat">
                  {(stats.errorPcs || 0).toLocaleString()}
                </div>
                <div className="stat-label">{t("counter.stats.errorPcs")}</div>
              </div>
            </div>
          </>
        )}
      </div>
      {/* 当前会话显示 - 有内容时显示 */}
      {currentSession && currentSession.totalCount > 0 && (
        <div className="current-session">
          <div className="session-header">
            <h3>{t("counter.currentSession")}</h3>
            {currentSession && (
              <button
                className="clear-session-btn"
                onClick={clearCurrentSession}
                title={t("counter.clearCurrentSession")}
              >
                <span className="clear-icon">🗑️</span>
                {t("counter.clearSession")}
              </button>
            )}
          </div>
          <div className="dashboard-session-info">
            {currentSession ? (
              <>
                <div className="session-item">
                  <span className="session-label">
                    {t("counter.session.status")}:
                  </span>
                  <span
                    className="session-value"
                    style={{ color: getStatusColor(currentSession.status) }}
                  >
                    {getStatusIcon(currentSession.status)}{" "}
                    {getStatusText(currentSession.status)}
                  </span>
                </div>
                <div className="session-item">
                  <span className="session-label">
                    {t("counter.session.count")}:
                  </span>
                  <span className="session-value">
                    {currentSession.totalCount - (currentSession.errorCount || 0)}
                  </span>
                </div>{" "}
                <div className="session-item">
                  <span className="session-label">
                    {t("counter.session.amount")}:
                  </span>
                  <span className="session-value">
                    {formatCurrency(currentSession.totalAmount || 0, { showCurrencySymbol: false })}
                  </span>
                </div>
                <div className="session-item">
                  <span className="session-label">
                    {t("counter.session.errorCount")}:
                  </span>
                  <span className="session-value error-count">
                    {currentSession.errorCount || 0}
                  </span>
                </div>
                {currentSession.endTime && (
                  <div className="session-item">
                    <span className="session-label">
                      {t("counter.session.date")}:
                    </span>
                    <span className="session-value end-time">
                      {currentSession.endTime}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="session-item no-session">
                <span className="session-value">
                  {t("counter.noCurrentSession")}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      {/* 数据记录区域 - 分离的Card布局 */}
      <div className="data-section">
        <div className="records-grid">
          {" "}
          {/* 详细面额统计 Card */}
          <div className="record-card detailed-records-card">
            {" "}
            <div className="card-header">
              <h3>
                <span className="section-icon">💰</span>
                {t("counter.detailedRecords") + ` (${selectedCurrencyTab})`}
                <span className="record-count">
                  {getAvailableCurrencies().length > 1
                    ? `(${t(
                        "counter.totalNotes",
                        "Total"
                      )}: ${getTotalCount()})`
                    : getCurrentTabDenominationDetails().length > 0 &&
                      `(${getCurrentTabTotalCount()} ${t(
                        "counter.detailTable.bills"
                      )})`}
                </span>
              </h3>
            </div>
            {/* 货币Tab切换 */}
            {/* {getAvailableCurrencies().length > 1 && (
              <div className="currency-tabs">
                {getAvailableCurrencies().map((currencyCode) => (
                  <button
                    key={currencyCode}
                    className={`currency-tab ${
                      selectedCurrencyTab === currencyCode ? "active" : ""
                    }`}
                    onClick={() => setSelectedCurrencyTab(currencyCode)}
                  >
                    {currencyCode}
                  </button>
                ))}
              </div>
            )} */}
            <div className="card-content">
              <div className="details-list">
                {getCurrentTabDenominationDetails().length === 0 ? (
                  <div className="no-data enhanced">
                    <div className="no-data-illustration">
                      <div className="illustration-circle">
                        <span className="no-data-icon">📝</span>
                      </div>
                      <div className="illustration-dots">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                    </div>
                    <div className="no-data-content">
                      <div className="no-data-text">
                        {t("counter.noData.noDetailedRecords")}
                      </div>
                      <div className="no-data-hint">
                        {t("counter.noData.startCountingHint")}
                      </div>
                      <div className="no-data-suggestion">
                        💰{" "}
                        {t(
                          "counter.noData.denominationSuggestion",
                          "Denomination details will appear here once counting begins"
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="details-table">
                    <div className="details-header">
                      <div className="col-denom">
                        {t("counter.detailTable.denomination")}
                      </div>
                      <div className="col-pcs">
                        {t("counter.detailTable.count")}
                      </div>
                      <div className="col-amount">
                        {t("counter.detailTable.total")}
                      </div>
                    </div>
                    <div className="details-content">
                      {getCurrentTabDenominationDetails().map((detail) => (
                        <div key={detail.denomination} className="details-row">
                          <div className="col-denom">
                            <span className="denom-value">
                              {formatDenomination(detail.denomination, { showCurrencySymbol: false })}
                            </span>
                          </div>
                          <div className="col-pcs">
                            <span className="count-value">{detail.count}</span>
                            <span className="count-label">
                              {t("counter.detailTable.pcs")}
                            </span>
                          </div>
                          <div className="col-amount">
                            {formatCurrency(detail.amount, { currency: selectedCurrencyTab })}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* 总计行 - 固定在底部 */}
                    {getCurrentTabDenominationDetails().length > 0 && (
                      <div className="details-total-container">
                        <div className="details-row total-row">
                          <div className="col-denom">
                            <strong>{t("counter.detailTable.totalRow")}</strong>
                          </div>
                          <div className="col-pcs">
                            <strong>{getCurrentTabTotalCount()}</strong>
                            <span className="count-label">
                              {t("counter.detailTable.pcs")}
                            </span>
                          </div>
                          <div className="col-amount">
                            <strong>
                              {formatCurrency(getCurrentTabTotalAmount(), { currency: selectedCurrencyTab})}
                            </strong>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* 计数记录 Card */}
          <div className="record-card counting-records-card">
            {" "}
            <div className="card-header">
              <h3>
                <span className="section-icon">📝</span>
                {t("counter.records")}
                <span className="record-count">
                  {renderSessionData.length > 0 &&
                    `(${renderSessionData.length} ${t(
                      "counter.stats.totalSessions"
                    )})`}
                </span>
              </h3>
            </div>
            <div className="card-content">
              <div className="data-list">
                <VirtualCountingRecords
                  sessions={renderSessionData}
                  height={dataListHeight}
                  onSessionClick={handleSessionClick}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Session详情抽屉 */}
      <SessionDetailDrawer
        isOpen={isDetailDrawerOpen}
        sessionData={getSelectedSession()}
        onClose={handleCloseDrawer}
      />
      {/* 导出面额统计面板 */}
      <ExportPanel
        isOpen={isExportPanelOpen}
        sessionData={sessionData}
        onExportComplete={handleExportComplete}
        onClose={handleExportPanelClose}
      />
    </div>
  );
};
