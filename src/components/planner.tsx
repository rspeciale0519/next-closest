import {
  Copy,
  ImagePlus,
  LoaderCircle,
  LocateFixed,
  MapPin,
  Navigation,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { RouteMap } from "@/components/route-map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  planRoute,
  reverseGeocode,
  suggestPlaces,
  type PlanResult,
  type Suggestion,
} from "@/lib/geo-api";
import { extractAddressesFromImage } from "@/lib/vision-api";
import { fileToImageDataUrl } from "@/lib/image-file";
import { formatDuration, formatMiles, parseAddressList, type Place } from "@/lib/geo";
import { appleMapsDirUrl, copyableStopList, copyPlainText, googleMapsDirUrl } from "@/lib/maps-links";
import { SAMPLE_START, SAMPLE_STOPS } from "@/lib/samples";
import { loadPlanner, savePlanner } from "@/lib/storage";
import { cn } from "@/lib/utils";

type LocateStatus = "idle" | "locating" | "ready" | "denied" | "error";

export function Planner() {
  const [startQuery, setStartQuery] = useState("");
  const [startPlace, setStartPlace] = useState<Place | null>(null);
  const [locateStatus, setLocateStatus] = useState<LocateStatus>("idle");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [stopsText, setStopsText] = useState("");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [readingImage, setReadingImage] = useState(false);
  const suggestTimer = useRef<number | null>(null);
  const startBoxRef = useRef<HTMLDivElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const stopCount = parseAddressList(stopsText).length;
  const canPlan = startQuery.trim().length > 0 && stopCount > 0 && !planning && !readingImage;

  useEffect(() => {
    const stored = loadPlanner();
    if (stored) {
      setStartQuery(stored.startQuery);
      setStopsText(stored.stopsText);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    savePlanner({ startQuery, stopsText });
  }, [hydrated, startQuery, stopsText]);

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!startBoxRef.current?.contains(event.target as Node)) {
        setSuggestOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function onStartChange(value: string) {
    setStartQuery(value);
    setStartPlace(null);
    setPlan(null);
    setError(null);
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    if (value.trim().length < 3) {
      setSuggestions([]);
      setSuggestOpen(false);
      return;
    }
    suggestTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = await suggestPlaces({
            data: { query: value.trim() },
          });
          setSuggestions(hits);
          setSuggestOpen(hits.length > 0);
        } catch {
          setSuggestions([]);
        }
      })();
    }, 280);
  }

  function clearStart() {
    onStartChange("");
    setLocateStatus("idle");
  }

  function pickSuggestion(place: Suggestion) {
    setStartQuery(place.label);
    setStartPlace(place);
    setSuggestions([]);
    setSuggestOpen(false);
    setLocateStatus("idle");
  }

  async function useMyLocation() {
    if (!navigator.geolocation) {
      setLocateStatus("error");
      setError("This browser cannot share a location. Enter a start address instead.");
      return;
    }
    setLocateStatus("locating");
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        try {
          const place = await reverseGeocode({ data: coords });
          setStartPlace(place);
          setStartQuery(place.label);
          setLocateStatus("ready");
        } catch {
          const fallback: Place = {
            ...coords,
            query: "Current location",
            label: "Current location",
          };
          setStartPlace(fallback);
          setStartQuery(fallback.label);
          setLocateStatus("ready");
        }
      },
      (err) => {
        setLocateStatus(err.code === err.PERMISSION_DENIED ? "denied" : "error");
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location access was blocked. Type the address you’ll start from."
            : "Could not read your location. Type a start address instead.",
        );
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }

  function loadSample() {
    setStartQuery(SAMPLE_START);
    setStartPlace(null);
    setStopsText(SAMPLE_STOPS);
    setPlan(null);
    setError(null);
    setLocateStatus("idle");
  }

  async function onPhotoSelected(file: File | undefined) {
    if (!file) return;
    setReadingImage(true);
    setError(null);
    try {
      const imageDataUrl = await fileToImageDataUrl(file);
      const result = await extractAddressesFromImage({ data: { imageDataUrl } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.addresses.length === 0) {
        setError("No street addresses found in that photo. Try a clearer screenshot.");
        return;
      }
      const existing = parseAddressList(stopsText);
      const seen = new Set(existing.map((line) => line.toLowerCase()));
      const added = result.addresses.filter((address) => !seen.has(address.toLowerCase()));
      if (added.length === 0) {
        toast.message("Those addresses are already in the list");
        return;
      }
      setStopsText([...existing, ...added].join("\n"));
      setPlan(null);
      toast.success(
        added.length === 1 ? "Added 1 address from photo" : `Added ${added.length} addresses from photo`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that photo.");
    } finally {
      setReadingImage(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  async function onPlan() {
    const stops = parseAddressList(stopsText);
    if (!startQuery.trim() || stops.length === 0) return;
    setPlanning(true);
    setError(null);
    try {
      const result = await planRoute({
        data: {
          start: {
            query: startQuery.trim(),
            coords: startPlace
              ? { lat: startPlace.lat, lng: startPlace.lng }
              : undefined,
            label: startPlace?.label,
          },
          stops,
        },
      });
      setPlan(result);
      if (result.ordered.length === 0) {
        setError("None of those addresses could be found. Check spelling and try again.");
      }
    } catch (err) {
      setPlan(null);
      setError(err instanceof Error ? err.message : "Could not order those stops.");
    } finally {
      setPlanning(false);
    }
  }

  const navPlaces = plan ? plan.ordered.map((s) => s.place) : [];

  async function copyList() {
    if (!plan) return;
    try {
      await copyPlainText(copyableStopList(plan.ordered.map((s) => s.place)));
      toast.success("Addresses copied");
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-screen-xl flex-col md:h-dvh md:max-h-dvh md:overflow-hidden squat:h-dvh squat:max-h-dvh squat:overflow-hidden squat:pl-[env(safe-area-inset-left)] squat:pr-[env(safe-area-inset-right)]">
      <header className="flex items-start justify-between gap-4 px-4 pb-4 pt-4 md:px-6 md:pt-6 squat:items-center squat:px-3 squat:py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Mark />
            <p className="font-display text-xl leading-tight tracking-tight text-fg md:text-2xl squat:text-lg">
              Next Closest
            </p>
          </div>
          <p className="mt-1 max-w-md text-pretty text-sm leading-snug text-muted squat:hidden">
            Drop in your stops. We’ll line them up so each one is the nearest remaining stop.
          </p>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0 text-muted" onClick={loadSample}>
          Try a sample
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row md:gap-4 md:px-6 md:pb-6 squat:flex-row squat:gap-3 squat:px-3 squat:pb-3">
        <section className="flex min-h-0 w-full shrink-0 flex-col gap-4 px-4 pb-4 md:w-96 md:overflow-y-auto md:px-0 md:pr-1 squat:w-[min(20rem,44vw)] squat:overflow-y-auto squat:px-0 squat:pb-0 squat:pr-1">
          <div className="rounded-xl bg-surface p-4 shadow-border">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-fg">Starting point</h2>
              {locateStatus === "ready" ? (
                <span className="text-xs font-medium text-ok">Using your location</span>
              ) : null}
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                className="shrink-0"
                onClick={() => void useMyLocation()}
                disabled={locateStatus === "locating"}
              >
                {locateStatus === "locating" ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <LocateFixed className="size-4" />
                )}
                Use my location
              </Button>
            </div>
            <div ref={startBoxRef} className="relative mt-3">
              <label className="sr-only" htmlFor="start-address">
                Start address
              </label>
              <Input
                id="start-address"
                value={startQuery}
                onChange={(e) => onStartChange(e.target.value)}
                onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
                placeholder="Or type a start address"
                autoComplete="off"
                className={startQuery ? "pr-10" : undefined}
              />
              {startQuery ? (
                <button
                  type="button"
                  aria-label="Clear start address"
                  className="absolute right-1.5 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                  onClick={clearStart}
                >
                  <X className="size-4" strokeWidth={2.25} />
                </button>
              ) : null}
              {suggestOpen && suggestions.length > 0 ? (
                <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-lg bg-surface py-1 shadow-border-hover">
                  {suggestions.map((hit) => (
                    <li key={`${hit.lat},${hit.lng},${hit.label}`}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm leading-snug hover:bg-surface-2"
                        onClick={() => pickSuggestion(hit)}
                      >
                        <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted" />
                        <span>{hit.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl bg-surface p-4 shadow-border">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-fg">Stops</h2>
              {stopCount > 0 ? (
                <span className="tabular-nums text-xs text-muted">
                  {stopCount} {stopCount === 1 ? "address" : "addresses"}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              One address per line, or upload a screenshot of a job list.
            </p>
            <div className="mt-3">
              <label className="sr-only" htmlFor="stops">
                Stop addresses
              </label>
              <Textarea
                id="stops"
                value={stopsText}
                onChange={(e) => {
                  setStopsText(e.target.value);
                  setPlan(null);
                }}
                placeholder={"123 Main St, Orlando, FL\n456 Park Ave, Winter Park, FL"}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={readingImage}
                onClick={() => photoInputRef.current?.click()}
              >
                {readingImage ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="size-3.5" />
                )}
                {readingImage ? "Reading photo" : "Upload photo"}
              </Button>
              <input
                id="stop-photo"
                ref={photoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void onPhotoSelected(e.target.files?.[0])}
              />
              {stopCount > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted"
                  onClick={() => {
                    setStopsText("");
                    setPlan(null);
                  }}
                >
                  <Trash2 className="size-3.5" />
                  Clear
                </Button>
              ) : null}
            </div>
          </div>

          {error ? (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <Button size="lg" className="w-full" disabled={!canPlan} onClick={() => void onPlan()}>
            {planning ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Ordering stops
              </>
            ) : (
              "Order by next closest"
            )}
          </Button>

          {plan && plan.ordered.length > 0 ? (
            <Results plan={plan} onCopy={() => void copyList()} navPlaces={navPlaces} />
          ) : null}
        </section>

        <section
          className={cn(
            "min-h-72 min-w-0 flex-1 overflow-hidden bg-surface-2 md:rounded-xl md:shadow-border squat:min-h-0 squat:rounded-xl squat:shadow-border",
            !plan && !startPlace ? "hidden md:block squat:block" : "block",
          )}
        >
          <RouteMap
            className="h-80 md:h-full squat:h-full squat:min-h-0"
            start={plan?.start ?? startPlace}
            stops={plan?.ordered.map((s) => s.place) ?? []}
            polyline={plan?.polyline ?? []}
          />
        </section>
      </div>
    </div>
  );
}

function Results({
  plan,
  onCopy,
  navPlaces,
}: {
  plan: PlanResult;
  onCopy: () => void;
  navPlaces: Place[];
}) {
  return (
    <div className="rounded-xl bg-surface p-4 shadow-border">
      <div>
        <h2 className="font-display text-lg tracking-tight text-fg">Driving order</h2>
        <p className="mt-0.5 text-sm text-muted">
          <span className="tabular-nums">{formatMiles(plan.totalMeters)}</span>
          {" · "}
          <span className="tabular-nums">{formatDuration(plan.totalSeconds)}</span>
          {plan.source === "straight" ? " · straight-line estimate" : " · road time"}
        </p>
      </div>

      <ol className="mt-4 flex flex-col">
        <li className="flex gap-3 pb-3">
          <span className="nc-marker nc-marker-start mt-0.5 shrink-0">
            <span className="nc-marker-dot" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Start</p>
            <p className="text-pretty text-sm leading-snug text-fg">{plan.start.query}</p>
            {plan.start.label !== plan.start.query ? (
              <p className="mt-0.5 text-pretty text-xs leading-snug text-muted">{plan.start.label}</p>
            ) : null}
          </div>
        </li>
        {plan.ordered.map((stop, i) => (
          <li
            key={`${stop.place.lat}-${stop.place.lng}-${i}`}
            className="flex gap-3 border-t border-border py-3"
          >
            <span className="nc-marker nc-marker-stop mt-0.5 shrink-0">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-pretty text-sm leading-snug text-fg">{stop.place.query}</p>
              {stop.place.label !== stop.place.query ? (
                <p className="mt-0.5 text-pretty text-xs leading-snug text-muted">{stop.place.label}</p>
              ) : null}
              <p className="mt-0.5 tabular-nums text-xs text-muted">
                {formatDuration(stop.legSeconds)} · {formatMiles(stop.legMeters)} from previous
              </p>
            </div>
          </li>
        ))}
      </ol>

      {plan.failures.length > 0 ? (
        <div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
          Skipped {plan.failures.length} unmatched{" "}
          {plan.failures.length === 1 ? "address" : "addresses"}:{" "}
          {plan.failures.map((f) => f.query).join("; ")}
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-2">
        <Button asChild className="w-full">
          <a href={googleMapsDirUrl(navPlaces)} target="_blank" rel="noreferrer">
            <Navigation className="size-4" />
            Open in Google Maps
          </a>
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button asChild variant="secondary" className="w-full">
            <a href={appleMapsDirUrl(navPlaces)} target="_blank" rel="noreferrer">
              Apple Maps
            </a>
          </Button>
          <Button type="button" variant="secondary" className="w-full" onClick={onCopy}>
            <Copy className="size-4" />
            Copy addresses
          </Button>
        </div>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <span
      aria-hidden="true"
      className="relative grid size-8 place-items-center rounded-md bg-primary text-primary-fg"
    >
      <span className="absolute size-1.5 rounded-full bg-primary-fg" />
      <span className="absolute h-3 w-px bg-primary-fg/80" />
      <span className="absolute h-px w-3 bg-primary-fg/80" />
    </span>
  );
}
