import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { BotConfig } from "@/hooks/useBotState";

interface ControlPanelProps {
  config: BotConfig;
  onUpdate: (partial: Partial<BotConfig>) => void;
  disabled: boolean;
}

const sliders = [
  { key: "orderSize" as const, label: "💰 Размер ордера (USDC)", min: 1, max: 500, step: 1, unit: "USDC" },
  { key: "spread" as const, label: "📐 Спред (basis points)", min: 5, max: 60, step: 1, unit: "bp" },
  { key: "interval" as const, label: "⏱️ Интервал обновления", min: 5, max: 30, step: 1, unit: "сек" },
  { key: "maxMarkets" as const, label: "📊 Макс. рынков", min: 1, max: 125, step: 1, unit: "" },
  { key: "maxPosition" as const, label: "🛡️ Макс. позиция / рынок", min: 100, max: 1000, step: 10, unit: "USDC" },
  { key: "minVolume24h" as const, label: "📈 Мин. 24ч объём", min: 2000, max: 50000, step: 1000, unit: "USDC" },
  { key: "minSponsorPool" as const, label: "🏆 Мин. спонсорский пул", min: 0, max: 2000, step: 50, unit: "$" },
  { key: "minLiquidityDepth" as const, label: "💧 Мин. глубина ликвидности", min: 100, max: 2000, step: 50, unit: "$" },
  { key: "totalCapital" as const, label: "💼 Общий капитал", min: 100, max: 10000, step: 100, unit: "USDC" },
];

const ControlPanel = ({ config, onUpdate, disabled }: ControlPanelProps) => {
  return (
    <div className="space-y-4">
      <h3 className="font-display text-sm font-semibold uppercase tracking-widest text-muted-foreground">
        ⚙️ Параметры
      </h3>
      {sliders.map((c) => (
        <div key={c.key} className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-secondary-foreground">{c.label}</label>
            <span className="font-mono text-xs font-semibold text-primary">
              {config[c.key]} {c.unit}
            </span>
          </div>
          <Slider
            min={c.min}
            max={c.max}
            step={c.step}
            value={[config[c.key]]}
            onValueChange={([v]) => onUpdate({ [c.key]: v })}
            disabled={disabled}
            className="cursor-pointer"
          />
        </div>
      ))}

      {/* Oracle toggle */}
      <div className="flex items-center justify-between rounded-md border border-border bg-muted/50 p-2.5">
        <div className="space-y-0.5">
          <span className="text-xs font-semibold text-foreground">
            🔮 Внешний оракул (крипто)
          </span>
          <p className="font-mono text-[10px] text-muted-foreground">
            Binance для BTC/ETH/SOL
          </p>
        </div>
        <Switch
          checked={config.useExternalOracle}
          onCheckedChange={(v) => onUpdate({ useExternalOracle: v })}
          disabled={disabled}
        />
      </div>
    </div>
  );
};

export default ControlPanel;
