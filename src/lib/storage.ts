const KEY = "next-closest:v1";

export type StoredPlanner = {
  startQuery: string;
  stopsText: string;
};

export function loadPlanner(): StoredPlanner | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPlanner>;
    if (typeof parsed.startQuery !== "string" || typeof parsed.stopsText !== "string") {
      return null;
    }
    return { startQuery: parsed.startQuery, stopsText: parsed.stopsText };
  } catch {
    return null;
  }
}

export function savePlanner(state: StoredPlanner) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // ignore quota / private mode
  }
}
