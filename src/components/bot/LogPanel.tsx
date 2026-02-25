import { useEffect, useRef } from "react";
import { LogEntry } from "@/hooks/useBotState";

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

const levelColors: Record<LogEntry["level"], string> = {
  info: "text-info",
  warn: "text-warning",
  error: "text-destructive",
  success: "text-primary",
};

const LogPanel = ({ logs, onClear }: LogPanelProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="flex flex-col rounded-lg border border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-destructive/70" />
            <div className="h-3 w-3 rounded-full bg-warning/70" />
            <div className="h-3 w-3 rounded-full bg-primary/70" />
          </div>
          <span className="font-mono text-xs text-muted-foreground">terminal — bot.log</span>
        </div>
        <button
          onClick={onClear}
          className="font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          clear
        </button>
      </div>

      <div className="h-[420px] overflow-y-auto p-4 font-mono text-[13px] leading-relaxed">
        {logs.length === 0 && (
          <p className="text-muted-foreground">Ожидание запуска бота...</p>
        )}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">[{log.timestamp}]</span>
            <span className={levelColors[log.level]}>{log.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default LogPanel;
