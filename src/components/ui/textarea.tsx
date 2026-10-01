import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-36 w-full resize-y rounded-md bg-surface px-3 py-3 text-base leading-relaxed text-fg shadow-border outline-none transition-[box-shadow] duration-150 placeholder:text-subtle squat:min-h-24",
        "focus-visible:ring-2 focus-visible:ring-primary/35",
        "disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}
