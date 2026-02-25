interface StatusIndicatorProps {
  isRunning: boolean;
}

const StatusIndicator = ({ isRunning }: StatusIndicatorProps) => {
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-6 py-4 transition-all duration-500 ${
      isRunning
        ? "border-primary/30 bg-primary/5 glow-green"
        : "border-destructive/30 bg-destructive/5 glow-red"
    }`}>
      <div className={`h-4 w-4 rounded-full ${
        isRunning ? "bg-primary animate-pulse-glow" : "bg-destructive"
      }`} />
      <span className="font-display text-xl font-bold tracking-tight">
        {isRunning ? "🟢 БОТ РАБОТАЕТ" : "🔴 БОТ ОСТАНОВЛЕН"}
      </span>
    </div>
  );
};

export default StatusIndicator;
