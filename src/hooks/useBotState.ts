import { useState, useCallback, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface LogEntry {
  id: number;
  timestamp: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface BotConfig {
  orderSize: number;
  spread: number;
  interval: number;
  maxMarkets: number;
  paperTrading: boolean;
  maxPosition: number;
  minSponsorPool: number;
  minLiquidityDepth: number;
  minVolume24h: number;
  totalCapital: number;
  useExternalOracle: boolean;
  aggressiveShortTerm: boolean;
}

const DEFAULT_CONFIG: BotConfig = {
  orderSize: 6,
  spread: 22,
  interval: 6,
  maxMarkets: 12,
  paperTrading: true,
  maxPosition: 30,
  minSponsorPool: 0,
  minLiquidityDepth: 80,
  minVolume24h: 1500,
  totalCapital: 65,
  useExternalOracle: false,
  aggressiveShortTerm: true,
};

const MAX_LOGS = 200;

export function useBotState() {
  const [isRunning, setIsRunning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [config, setConfig] = useState<BotConfig>(DEFAULT_CONFIG);
  const [circuitBreaker, setCircuitBreaker] = useState(false);
  const [sponsorStats, setSponsorStats] = useState({ sponsored: 0, total: 0, avgSponsor: 0 });
  const logIdRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cycleInFlightRef = useRef(false);
  const lastOverlapLogAtRef = useRef(0);

  const addLog = useCallback((level: LogEntry["level"], message: string) => {
    const entry: LogEntry = {
      id: logIdRef.current++,
      timestamp: new Date().toLocaleTimeString("ru-RU", {
        hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      }),
      level,
      message,
    };
    setLogs((prev) => [...prev.slice(-(MAX_LOGS - 1)), entry]);
  }, []);

  const callApi = useCallback(
    async (action: string, params: Record<string, unknown> = {}) => {
      const { data, error } = await supabase.functions.invoke("polymarket-api", {
        body: { action, ...params },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    []
  );

  const connectBot = useCallback(async () => {
    addLog("info", "🔑 Деривация API credentials из приватного ключа...");
    try {
      const data = await callApi("derive_creds");
      setIsConnected(true);
      addLog("success", `✅ Подключено! API Key: ${data.address}`);
    } catch (e: any) {
      addLog("error", `❌ Ошибка подключения: ${e.message}`);
    }
  }, [addLog, callApi]);

  const runCycle = useCallback(async () => {
    if (cycleInFlightRef.current) {
      const now = Date.now();
      if (now - lastOverlapLogAtRef.current > 15000) {
        addLog("warn", "⏭️ Пропуск цикла: предыдущий цикл ещё выполняется");
        lastOverlapLogAtRef.current = now;
      }
      return;
    }

    cycleInFlightRef.current = true;
    addLog("info", "━━━ Новый цикл ━━━");
    try {
      const data = await callApi("run_cycle", {
        orderSize: config.orderSize,
        spread: config.spread,
        maxMarkets: config.maxMarkets,
        liveTrading: !config.paperTrading,
        maxPosition: config.maxPosition,
        minSponsorPool: config.minSponsorPool,
        minLiquidityDepth: config.minLiquidityDepth,
        minVolume24h: config.minVolume24h,
        totalCapital: config.totalCapital,
        useExternalOracle: config.useExternalOracle,
        aggressiveShortTerm: config.aggressiveShortTerm,
      });

      if (data.circuitBreaker) {
        setCircuitBreaker(true);
        setIsRunning(false);
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        addLog("error", "🚨 CIRCUIT BREAKER: бот остановлен автоматически!");
      }

      // Update sponsor stats from cycle response
      if (data.sponsoredMarkets !== undefined) {
        setSponsorStats({
          sponsored: data.sponsoredMarkets || 0,
          total: data.totalMarkets || 0,
          avgSponsor: data.avgSponsor || 0,
        });
      }

      if (data.logs) {
        data.logs.forEach((msg: string) => {
          const level = msg.includes("❌") || msg.includes("🚨")
            ? "error"
            : msg.includes("⚠️") || msg.includes("⏸️") || msg.includes("⏭️") || msg.includes("[SKIP]")
            ? "warn"
            : msg.includes("✅") || msg.includes("♻️")
            ? "success"
            : "info";
          addLog(level, msg);
        });
      }
    } catch (e: any) {
      addLog("error", `❌ Ошибка цикла: ${e.message}`);
    } finally {
      cycleInFlightRef.current = false;
    }
  }, [addLog, callApi, config]);

  const startBot = useCallback(async () => {
    setCircuitBreaker(false);
    setIsRunning(true);
    addLog("success", "🚀 Бот запущен! Подключение к Polymarket CLOB...");
    addLog("info", `⚙️ Конфигурация: ордер=${config.orderSize} USDC, спред=${config.spread}bp, интервал=${config.interval}с, рынков=${config.maxMarkets}, макс.позиция=${config.maxPosition} USDC, мин.глубина=${config.minLiquidityDepth}$`);

    if (!isConnected) {
      await connectBot();
    }

    await runCycle();

    intervalRef.current = setInterval(() => {
      runCycle();
    }, config.interval * 1000);
  }, [config, isConnected, connectBot, runCycle, addLog]);

  const stopBot = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    addLog("warn", "⏹ Остановка бота...");
    try {
      await callApi("cancel_all");
      addLog("success", "✅ Все ордера отменены. Бот остановлен.");
    } catch (e: any) {
      addLog("error", `⚠️ Ошибка отмены ордеров: ${e.message}`);
    }
    setIsRunning(false);
  }, [addLog, callApi]);

  const clearLogs = useCallback(() => setLogs([]), []);

  const updateConfig = useCallback((partial: Partial<BotConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  }, []);

  const resetPositions = useCallback(async () => {
    addLog("info", "🗑️ Сброс всех позиций...");
    try {
      const data = await callApi("reset_positions");
      addLog("success", data.message || "✅ Позиции сброшены");
    } catch (e: any) {
      addLog("error", `❌ Ошибка сброса: ${e.message}`);
    }
  }, [addLog, callApi]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { isRunning, isConnected, config, logs, startBot, stopBot, clearLogs, updateConfig, connectBot, circuitBreaker, sponsorStats, resetPositions };
}
