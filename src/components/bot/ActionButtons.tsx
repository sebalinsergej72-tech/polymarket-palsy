import { Button } from "@/components/ui/button";
import { Play, Square } from "lucide-react";

interface ActionButtonsProps {
  isRunning: boolean;
  onStart: () => void;
  onStop: () => void;
}

const ActionButtons = ({ isRunning, onStart, onStop }: ActionButtonsProps) => {
  return (
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
  );
};

export default ActionButtons;
