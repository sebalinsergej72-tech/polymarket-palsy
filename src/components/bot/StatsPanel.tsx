import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { DollarSign, TrendingUp, ShoppingCart, Activity } from "lucide-react";

interface Stats {
  balance: number;
  openPositions: number;
  totalValue: number;
  openOrders: number;
  pnl: number;
}

const EMPTY: Stats = { balance: 0, openPositions: 0, totalValue: 0, openOrders: 0, pnl: 0 };

interface StatsPanelProps {
  isConnected: boolean;
  isRunning: boolean;
}

const StatsPanel = ({ isConnected, isRunning }: StatsPanelProps) => {
  const [stats, setStats] = useState<Stats>(EMPTY);
  const [loading, setLoading] = useState(false);

  const fetchStats = useCallback(async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("polymarket-api", {
        body: { action: "get_stats" },
      });
      if (!error && data?.stats) {
        setStats(data.stats);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [isConnected]);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 15_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  // Extra poll when bot is running
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(fetchStats, 8_000);
    return () => clearInterval(id);
  }, [isRunning, fetchStats]);

  const cards = [
    {
      label: "Открытые ордера",
      value: stats.openOrders,
      icon: ShoppingCart,
      format: (v: number) => String(v),
    },
    {
      label: "Объём ордеров",
      value: stats.totalValue,
      icon: DollarSign,
      format: (v: number) => `$${v.toFixed(2)}`,
    },
    {
      label: "P&L (сессия)",
      value: stats.pnl,
      icon: TrendingUp,
      format: (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`,
      color: stats.pnl >= 0 ? "text-primary" : "text-destructive",
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-border bg-card p-3 space-y-1"
        >
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <c.icon className="h-3.5 w-3.5" />
            <span className="font-mono text-[11px] uppercase tracking-wide">{c.label}</span>
          </div>
          <p className={`font-display text-lg font-bold ${c.color || "text-foreground"}`}>
            {loading && !stats.openOrders ? "—" : c.format(c.value)}
          </p>
        </div>
      ))}
    </div>
  );
};

export default StatsPanel;
