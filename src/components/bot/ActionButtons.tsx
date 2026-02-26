import { Button } from "@/components/ui/button";
import { Play, Square, Trash2 } from "lucide-react";

interface ActionButtonsProps {
  isRunning: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}

const ActionButtons = ({ isRunning, onStart, onStop, onReset }: ActionButtonsProps) => {
  return (
    <div className="space-y-2">
      <div className="flex gap-3">
        <Button
          onClick={onStart}
          disabled={isRunning}
          className="flex-1 gap-2 bg-primary text-primary-foreground font-display font-semibold text-base py-6 hover:bg-primary/90 disabled:opacity-40 transition-all"
        >
          <Play className="h-5 w-5" />
          ▶ Запустить бота
        </Button>
        <Button
          onClick={onStop}
          disabled={!isRunning}
          variant="destructive"
          className="flex-1 gap-2 font-display font-semibold text-base py-6 disabled:opacity-40 transition-all"
        >
          <Square className="h-5 w-5" />
          ⏹ Остановить
        </Button>
      </div>
      <Button
        onClick={onReset}
        disabled={isRunning}
        variant="destructive"
        className="w-full gap-2 font-display font-semibold text-sm py-3 disabled:opacity-40 transition-all"
      >
        <Trash2 className="h-4 w-4" />
        Reset All Positions
      </Button>
      <p className="text-center font-mono text-[10px] text-muted-foreground">
        Сбрасывает все позиции в базе до 0 (полезно после тестов)
      </p>
    </div>
  );
};

export default ActionButtons;
