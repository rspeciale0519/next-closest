import { cn } from "@/lib/utils";

const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";
const OSM_FIX = "https://www.openstreetmap.org/fixthemap";

export function OsrmAttribution({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11px] leading-snug text-pretty text-muted", className)}>
      Driving times ©{" "}
      <a
        href={OSM_COPYRIGHT}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-border underline-offset-2 hover:text-fg"
      >
        OpenStreetMap contributors
      </a>
      {" · "}
      routing by OSRM (FOSSGIS)
      {" · "}
      <a
        href={OSM_FIX}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-border underline-offset-2 hover:text-fg"
      >
        Fix the map
      </a>
    </p>
  );
}
