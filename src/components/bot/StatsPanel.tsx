import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { DollarSign, TrendingUp, ShoppingCart, Shield, AlertTriangle, BarChart3, Award } from "lucide-react";

interface Stats {
  balance: number;
  openPositions: number;
  totalValue: number;
  openOrders: number;
  pnl: number;
  cumulativePnl: number;
  circuitBreaker: boolean;
  positions: Array<{ market_id: string; market_name: string; net_position: number }>;
}

const EMPTY: Stats = {
  balance: 0, openPositions: 0, totalValue: 0, openOrders: 0,
  pnl: 0, cumulativePnl: 0, circuitBreaker: false, positions: [],
};

interface StatsPanelProps {
  isConnected: boolean;
  isRunning: boolean;
  circuitBreaker: boolean;
  sponsorStats?: { sponsored: number; total: number; avgSponsor: number };
}

const StatsPanel = ({ isConnected, isRunning, circuitBreaker, sponsorStats }: StatsPanelProps) => {
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
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [isConnected]);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 15_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(fetchStats, 8_000);
    return () => clearInterval(id);
  }, [isRunning, fetchStats]);

  const cards = [
    {
      label: "Ордера",
      value: stats.openOrders,
      icon: ShoppingCart,
      format: (v: number) => String(v),
    },
    {
      label: "Объём",
      value: stats.totalValue,
      icon: DollarSign,
      format: (v: number) => `$${v.toFixed(2)}`,
    },
    {
      label: "P&L (день)",
      value: stats.pnl,
      icon: TrendingUp,
      format: (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`,
      color: stats.pnl >= 0 ? "text-primary" : "text-destructive",
    },
    {
      label: "P&L (всего)",
      value: stats.cumulativePnl,
      icon: BarChart3,
      format: (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`,
      color: stats.cumulativePnl >= 0 ? "text-primary" : "text-destructive",
    },
    {
      label: "Позиции",
      value: stats.openPositions,
      icon: Shield,
      format: (v: number) => String(v),
    },
  ];

  const activePositions = stats.positions?.filter(
    (p) => Math.abs(p.net_position) > 0.01
  ) || [];

  return (
    <div className="space-y-3">
      {/* Circuit breaker alert */}
      {(circuitBreaker || stats.circuitBreaker) && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive bg-destructive/10 p-3">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <span className="text-sm font-semibold text-destructive">
            🚨 Circuit Breaker активен — торговля приостановлена
          </span>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-5 gap-2">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-card p-2.5 space-y-0.5">
            <div className="flex items-center gap-1 text-muted-foreground">
              <c.icon className="h-3 w-3" />
              <span className="font-mono text-[10px] uppercase tracking-wide">{c.label}</span>
            </div>
            <p className={`font-display text-base font-bold ${c.color || "text-foreground"}`}>
              {loading && !stats.openOrders ? "—" : c.format(c.value)}
            </p>
          </div>
        ))}
      </div>

      {/* Sponsor stats row */}
      {sponsorStats && sponsorStats.total > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-2.5">
          <Award className="h-4 w-4 text-primary" />
          <span className="font-mono text-xs text-muted-foreground">
            Рынки со спонсорами: <span className="font-semibold text-primary">{sponsorStats.sponsored}</span> / {sponsorStats.total}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            Avg sponsor: <span className="font-semibold text-foreground">${sponsorStats.avgSponsor.toFixed(0)}</span>
          </span>
        </div>
      )}

      {/* Active positions */}
      {activePositions.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h4 className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
            📊 Открытые позиции
          </h4>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {activePositions.slice(0, 8).map((p) => (
              <div key={p.market_id} className="flex items-center justify-between text-xs">
                <span className="text-secondary-foreground truncate max-w-[200px]">
                  {p.market_name || p.market_id.slice(0, 12)}
                </span>
                <span className={`font-mono font-semibold ${p.net_position >= 0 ? "text-primary" : "text-destructive"}`}>
                  {p.net_position >= 0 ? "+" : ""}{Number(p.net_position).toFixed(1)} USDC
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default StatsPanel;
