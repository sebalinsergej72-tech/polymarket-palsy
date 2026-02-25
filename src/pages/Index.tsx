import { useBotState } from "@/hooks/useBotState";
import StatusIndicator from "@/components/bot/StatusIndicator";
import ControlPanel from "@/components/bot/ControlPanel";
import ActionButtons from "@/components/bot/ActionButtons";
import LogPanel from "@/components/bot/LogPanel";
import { Activity, Zap } from "lucide-react";

const Index = () => {
  const { isRunning, config, logs, startBot, stopBot, clearLogs, updateConfig } = useBotState();

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <header className="space-y-2 text-center">
          <h1 className="font-display text-4xl font-bold tracking-tight md:text-5xl">
            🚀 Polymarket Market-Making Bot
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            Самая стабильная стратегия 2026 • Только Polymarket API • Работает 24/7 в облаке
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          {/* Sidebar */}
          <aside className="space-y-6 rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-accent">
              <Zap className="h-4 w-4" />
              <span className="font-display text-sm font-semibold uppercase tracking-widest">Панель управления</span>
            </div>

            <ControlPanel config={config} onUpdate={updateConfig} disabled={isRunning} />

            {/* API URL input */}
            <div className="space-y-2">
              <label className="text-sm text-secondary-foreground">🌐 API URL бота</label>
              <input
                type="text"
                value={config.apiUrl}
                onChange={(e) => updateConfig({ apiUrl: e.target.value })}
                disabled={isRunning}
                className="w-full rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                placeholder="http://localhost:8000"
              />
            </div>

            <div className="rounded-md border border-border bg-muted/50 p-3">
              <p className="font-mono text-xs text-muted-foreground leading-relaxed">
                ℹ️ Подключите этот дашборд к вашему Python-боту через REST API. Бот выполняет ордера через py-clob-client.
              </p>
            </div>
          </aside>

          {/* Main */}
          <main className="space-y-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <StatusIndicator isRunning={isRunning} />
              <div className="flex items-center gap-2 text-muted-foreground">
                <Activity className="h-4 w-4" />
                <span className="font-mono text-xs">{logs.length} записей в логе</span>
              </div>
            </div>

            <ActionButtons isRunning={isRunning} onStart={startBot} onStop={stopBot} />

            <LogPanel logs={logs} onClear={clearLogs} />
          </main>
        </div>

        <footer className="text-center font-mono text-xs text-muted-foreground">
          Polymarket MM Bot Dashboard © 2026 • React + Tailwind • Designed for 24/7 cloud deployment
        </footer>
      </div>
    </div>
  );
};

export default Index;
