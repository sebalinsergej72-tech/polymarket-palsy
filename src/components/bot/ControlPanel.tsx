import { Slider } from "@/components/ui/slider";
import { BotConfig } from "@/hooks/useBotState";

interface ControlPanelProps {
  config: BotConfig;
  onUpdate: (partial: Partial<BotConfig>) => void;
  disabled: boolean;
}

const controls = [
  { key: "orderSize" as const, label: "💰 Размер ордера (USDC)", min: 10, max: 500, step: 5, unit: "USDC" },
  { key: "spread" as const, label: "📐 Спред (basis points)", min: 5, max: 60, step: 1, unit: "bp" },
  { key: "interval" as const, label: "⏱️ Интервал обновления", min: 5, max: 30, step: 1, unit: "сек" },
  { key: "maxMarkets" as const, label: "📊 Макс. рынков", min: 1, max: 12, step: 1, unit: "" },
];

const ControlPanel = ({ config, onUpdate, disabled }: ControlPanelProps) => {
  return (
    <div className="space-y-5">
      <h3 className="font-display text-sm font-semibold uppercase tracking-widest text-muted-foreground">
        ⚙️ Параметры
      </h3>
      {controls.map((c) => (
        <div key={c.key} className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-secondary-foreground">{c.label}</label>
            <span className="font-mono text-sm font-semibold text-primary">
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
    </div>
  );
};

export default ControlPanel;
