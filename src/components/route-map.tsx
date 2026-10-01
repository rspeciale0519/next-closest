import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Place } from "@/lib/geo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RouteMapProps = {
  start?: Place | null;
  stops?: Place[];
  polyline?: Array<[number, number]>;
  className?: string;
};

export function RouteMap({ start, stops = [], polyline = [], className }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layersRef = useRef<import("leaflet").LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const viewRef = useRef({ start, stops, polyline, expanded });
  viewRef.current = { start, stops, polyline, expanded };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    let map: import("leaflet").Map | undefined;

    void import("leaflet").then((mod) => {
      if (cancelled || !containerRef.current) return;
      const L = leafletFrom(mod);
      map = L.map(containerRef.current, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: true,
      });
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
        {
          attribution:
            'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, TomTom, Garmin, FAO, NOAA, USGS',
          maxZoom: 19,
        },
      ).addTo(map);
      const group = L.layerGroup().addTo(map);
      map.setView([39.8, -96.5], 4);
      mapRef.current = map;
      layersRef.current = group;
      setReady(true);
      requestAnimationFrame(() => map?.invalidateSize());
    });

    return () => {
      cancelled = true;
      setReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
      layersRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    const relayout = () => {
      map.invalidateSize({ animate: false });
      const view = viewRef.current;
      const points: Array<[number, number]> = [];
      if (view.start) points.push([view.start.lat, view.start.lng]);
      for (const stop of view.stops) points.push([stop.lat, stop.lng]);
      if (points.length === 1) {
        map.setView(points[0], 13);
      } else if (points.length > 1) {
        map.fitBounds(points, {
          padding: view.expanded ? [48, 48] : [36, 36],
          maxZoom: 15,
        });
      }
    };

    const onResize = () => {
      requestAnimationFrame(relayout);
    };
    const observer = new ResizeObserver(onResize);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    const mq = window.matchMedia("(orientation: landscape)");
    mq.addEventListener("change", onResize);
    onResize();
    const later = window.setTimeout(onResize, 200);
    return () => {
      observer.disconnect();
      window.clearTimeout(later);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      mq.removeEventListener("change", onResize);
    };
  }, [ready, expanded]);

  useEffect(() => {
    const map = mapRef.current;
    const group = layersRef.current;
    if (!ready || !map || !group) return;

    void import("leaflet").then((mod) => {
      const L = leafletFrom(mod);
      group.clearLayers();

      const bounds: import("leaflet").LatLngExpression[] = [];

      if (polyline.length > 1) {
        L.polyline(polyline, {
          className: "nc-route-line",
          weight: 4,
          opacity: 0.85,
          lineJoin: "round",
          lineCap: "round",
        }).addTo(group);
      }

      if (start) {
        bounds.push([start.lat, start.lng]);
        L.marker([start.lat, start.lng], {
          icon: L.divIcon({
            className: "nc-marker-wrap",
            html: `<span class="nc-marker nc-marker-start" title="Start"><span class="nc-marker-dot"></span></span>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        })
          .bindPopup(`<strong>Start</strong><br/>${escapeHtml(start.label)}`)
          .addTo(group);
      }

      stops.forEach((stop, i) => {
        bounds.push([stop.lat, stop.lng]);
        L.marker([stop.lat, stop.lng], {
          icon: L.divIcon({
            className: "nc-marker-wrap",
            html: `<span class="nc-marker nc-marker-stop">${i + 1}</span>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        })
          .bindPopup(`<strong>Stop ${i + 1}</strong><br/>${escapeHtml(stop.label)}`)
          .addTo(group);
      });

      requestAnimationFrame(() => {
        map.invalidateSize();
        if (bounds.length === 1) {
          map.setView(bounds[0], 13);
        } else if (bounds.length > 1) {
          map.fitBounds(L.latLngBounds(bounds), {
            padding: expanded ? [48, 48] : [36, 36],
            maxZoom: 15,
          });
        }
      });
    });
  }, [ready, start, stops, polyline, expanded]);

  return (
    <div className={cn("relative min-h-60 squat:min-h-0", className)}>
      <div
        className={cn(
          "bg-surface-2",
          expanded
            ? "fixed inset-0 z-[9999]"
            : "nc-map-shell absolute inset-0 overflow-hidden rounded-xl",
        )}
      >
        <div ref={containerRef} className="relative z-0 h-full min-h-60 w-full squat:min-h-0" />
        <div className="pointer-events-none absolute inset-0 z-[9999] isolate">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-pressed={expanded}
            aria-label={expanded ? "Exit full screen map" : "Full screen map"}
            className="pointer-events-auto absolute right-3 top-3 size-11 bg-surface shadow-border"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? <Minimize2 className="size-5" /> : <Maximize2 className="size-5" />}
          </Button>
        </div>
        {!start && stops.length === 0 ? (
          <p className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-sm rounded-md bg-surface/90 px-3 py-2 text-sm leading-snug text-muted shadow-border">
            Add a start and your stops — the driving order draws here.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&" + "amp;")
    .replaceAll("<", "&" + "lt;")
    .replaceAll(">", "&" + "gt;")
    .replaceAll('"', "&" + "quot;");
}

function leafletFrom(mod: typeof import("leaflet") & { default?: typeof import("leaflet") }) {
  return mod.default ?? mod;
}
