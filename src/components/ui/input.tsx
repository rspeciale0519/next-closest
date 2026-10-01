import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-md bg-surface px-3 text-base text-fg shadow-border outline-none transition-[box-shadow,background-color] duration-150 placeholder:text-subtle",
        "focus-visible:ring-2 focus-visible:ring-primary/35",
        "disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}
