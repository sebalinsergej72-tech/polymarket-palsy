import { useState, useCallback, useRef, useEffect } from "react";

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
  apiUrl: string;
}

const DEFAULT_CONFIG: BotConfig = {
  orderSize: 50,
  spread: 15,
  interval: 8,
  maxMarkets: 5,
  apiUrl: "http://localhost:8000",
};

const MAX_LOGS = 100;

export function useBotState() {
  const [isRunning, setIsRunning] = useState(false);
  const [config, setConfig] = useState<BotConfig>(DEFAULT_CONFIG);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = useCallback((level: LogEntry["level"], message: string) => {
    const entry: LogEntry = {
      id: logIdRef.current++,
      timestamp: new Date().toLocaleTimeString("ru-RU", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      level,
      message,
    };
    setLogs((prev) => [...prev.slice(-(MAX_LOGS - 1)), entry]);
  }, []);

  const startBot = useCallback(() => {
    setIsRunning(true);
    addLog("success", "🚀 Бот запущен! Подключение к API...");
    addLog("info", `⚙️ Конфигурация: ордер=${config.orderSize} USDC, спред=${config.spread}bp, интервал=${config.interval}с, рынков=${config.maxMarkets}`);

    // Simulate bot cycles (replace with real API calls)
    const markets = ["US Election 2026", "Bitcoin > $150k", "ETH Merge v2", "Fed Rate Cut", "AI Regulation Bill"];
    let cycle = 0;

    intervalRef.current = setInterval(() => {
      cycle++;
      addLog("info", `━━━ Цикл #${cycle} ━━━`);
      addLog("info", "🗑️ Отмена всех открытых ордеров...");
      addLog("success", "✅ Все ордера отменены");
      addLog("info", `📊 Загрузка топ-${config.maxMarkets} рынков с Gamma API...`);

      const selected = markets.slice(0, config.maxMarkets);
      selected.forEach((market) => {
        const mid = (0.3 + Math.random() * 0.4).toFixed(4);
        const buy = (parseFloat(mid) - config.spread / 20000).toFixed(4);
        const sell = (parseFloat(mid) + config.spread / 20000).toFixed(4);
        addLog("info", `📈 ${market}: mid=${mid}`);
        addLog("success", `  ✅ BUY YES @ ${buy} (${config.orderSize} USDC)`);
        addLog("success", `  ✅ SELL YES @ ${sell} (${config.orderSize} USDC)`);
      });

      addLog("info", `⏳ Ожидание ${config.interval}с до следующего цикла...`);
    }, config.interval * 1000);
  }, [config, addLog]);

  const stopBot = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    addLog("warn", "⏹ Остановка бота...");
    addLog("info", "🗑️ Отмена всех открытых ордеров...");
    addLog("success", "✅ Все ордера отменены. Бот остановлен.");
    setIsRunning(false);
  }, [addLog]);

  const clearLogs = useCallback(() => setLogs([]), []);

  const updateConfig = useCallback((partial: Partial<BotConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  }, []);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { isRunning, config, logs, startBot, stopBot, clearLogs, updateConfig };
}
