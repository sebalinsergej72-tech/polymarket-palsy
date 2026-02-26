import { useBotState } from "@/hooks/useBotState";
import StatusIndicator from "@/components/bot/StatusIndicator";
import ControlPanel from "@/components/bot/ControlPanel";
import ActionButtons from "@/components/bot/ActionButtons";
import LogPanel from "@/components/bot/LogPanel";
import StatsPanel from "@/components/bot/StatsPanel";
import { Activity, Zap, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const Index = () => {
  const { isRunning, isConnected, config, logs, startBot, stopBot, clearLogs, updateConfig, connectBot } = useBotState();

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <header className="space-y-2 text-center">
          <h1 className="font-display text-4xl font-bold tracking-tight md:text-5xl">
            🚀 Polymarket Market-Making Bot
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            Реальная торговля на Polymarket CLOB • L2 Auth • Работает 24/7 в облаке
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

            {/* Paper / Live toggle */}
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/50 p-3">
              <div className="space-y-0.5">
                <span className="text-sm font-semibold text-foreground">
                  {config.paperTrading ? "📝 Paper Trading" : "💰 Live Trading"}
                </span>
                <p className="font-mono text-xs text-muted-foreground">
                  {config.paperTrading ? "Ордера НЕ отправляются" : "⚠️ Реальные ордера!"}
                </p>
              </div>
              <Switch
                checked={!config.paperTrading}
                onCheckedChange={(live) => updateConfig({ paperTrading: !live })}
                disabled={isRunning}
              />
            </div>

            {/* Connection status */}
            <Button
              variant={isConnected ? "outline" : "secondary"}
              className="w-full gap-2"
              onClick={connectBot}
              disabled={isConnected || isRunning}
            >
              <Wifi className="h-4 w-4" />
              {isConnected ? "✅ Подключено к CLOB" : "🔑 Подключить кошелёк"}
            </Button>

            <div className="rounded-md border border-border bg-muted/50 p-3">
              <p className="font-mono text-xs text-muted-foreground leading-relaxed">
                ℹ️ Бот использует ваш приватный ключ для деривации L2 API credentials и торговли через Polymarket CLOB API.
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

            <StatsPanel isConnected={isConnected} isRunning={isRunning} />

            <ActionButtons isRunning={isRunning} onStart={startBot} onStop={stopBot} />

            <LogPanel logs={logs} onClear={clearLogs} />
          </main>
        </div>

        <footer className="text-center font-mono text-xs text-muted-foreground">
          Polymarket MM Bot Dashboard © 2026 • React + Lovable Cloud • Live CLOB Trading
        </footer>
      </div>
    </div>
  );
};

export default Index;
