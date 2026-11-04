import { useEffect, useRef } from "react";
import { planProgressView, type PlanProgress } from "@/lib/plan";
import { cn } from "@/lib/utils";

export function PlanProgressBar({
  progress,
  className,
}: {
  progress: PlanProgress;
  className?: string;
}) {
  const view = planProgressView(progress);
  const held = useRef(0);
  if (view.percent + 1e-6 >= held.current) held.current = view.percent;
  const percent = held.current;

  useEffect(() => {
    return () => {
      held.current = 0;
    };
  }, []);

  return (
    <div className={cn("w-full", className)}>
      <p className="text-sm tabular-nums leading-snug text-fg">{view.label}</p>
      <div
        role="progressbar"
        aria-label={view.label}
        aria-valuemin={0}
        aria-valuenow={view.now}
        aria-valuemax={view.max}
        aria-valuetext={view.label}
        className="mt-2 h-3 w-full overflow-hidden rounded-full bg-surface-2 shadow-border"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
