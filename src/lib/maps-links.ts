import type { Place } from "./geo";

export function googleMapsDirUrl(places: Place[]): string {
  const addrs = places.map(navAddress).filter(Boolean);
  if (addrs.length === 0) return "https://www.google.com/maps";
  const params = new URLSearchParams({
    api: "1",
    destination: addrs[addrs.length - 1],
    travelmode: "driving",
    dir_action: "navigate",
  });
  const via = addrs.slice(0, -1);
  if (via.length > 0) params.set("waypoints", via.join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function appleMapsDirUrl(places: Place[]): string {
  const addrs = places.map(navAddress).filter(Boolean);
  if (addrs.length === 0) return "https://maps.apple.com/";
  const url = new URL("https://maps.apple.com/directions");
  url.searchParams.set("mode", "driving");
  url.searchParams.set("destination", addrs[addrs.length - 1]);
  url.searchParams.set("start", "1");
  for (const stop of addrs.slice(0, -1)) {
    url.searchParams.append("waypoint", stop);
  }
  return url.toString();
}

export function navAddress(place: Place): string {
  const query = cleanAddr(place.query);
  const label = streetFromLabel(cleanAddr(place.label));
  if (isStreetAddress(query)) return query;
  if (isStreetAddress(label)) return label;
  return query || label || `${place.lat},${place.lng}`;
}

function cleanAddr(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").replace(/^[, ]+|[, ]+$/g, "").trim();
}

function isStreetAddress(value: string): boolean {
  return /^\d+\s+\S/.test(value);
}

function streetFromLabel(label: string): string {
  if (!label) return "";
  const parts = label.split(",").map((part) => part.trim()).filter(Boolean);
  const start = parts.findIndex((part) => /^\d+\s+\S/.test(part));
  if (start > 0) return parts.slice(start).join(", ");
  return label;
}

export function copyableStopList(ordered: Place[]): string {
  return ordered
    .map((place) => (place.query || place.label).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export async function copyPlainText(text: string): Promise<void> {
  const payload = text.replace(/\r\n/g, "\n").trim();
  if (!payload) throw new Error("Nothing to copy");

  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload], { type: "text/plain" }),
        }),
      ]);
      return;
    }
  } catch {
    // fall through to writeText / textarea
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      return;
    }
  } catch {
    // fall through
  }

  const field = document.createElement("textarea");
  field.value = payload;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0;";
  document.body.appendChild(field);
  field.focus();
  field.select();
  field.setSelectionRange(0, payload.length);
  const ok = document.execCommand("copy");
  field.remove();
  if (!ok) throw new Error("Could not copy");
}
