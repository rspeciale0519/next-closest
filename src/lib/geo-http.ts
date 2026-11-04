export const GEOCODE_USER_AGENT =
  "nextclosest.vercel.app (+https://github.com/rspeciale0519/next-closest)";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  }
  const workers = Math.min(Math.max(1, limit), Math.max(items.length, 1));
  if (items.length === 0) return [];
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

export type FetchJsonOptions = {
  timeoutMs?: number;
  attempts?: number;
  signal?: AbortSignal;
};

export class LookupTimeoutError extends Error {
  constructor(message = "Lookup timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export function isStoppedError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

export function isLookupTimeoutError(err: unknown): boolean {
  return err instanceof LookupTimeoutError || (err instanceof Error && err.name === "TimeoutError");
}

export function listProviderFetchOpts(
  fetchOpts?: { timeoutMs?: number; attempts?: number },
  signal?: AbortSignal,
): FetchJsonOptions {
  return {
    timeoutMs: fetchOpts?.timeoutMs ?? 12000,
    attempts: fetchOpts?.attempts,
    signal,
  };
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutOrOpts: number | FetchJsonOptions = 10000,
): Promise<T> {
  const opts: FetchJsonOptions =
    typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const attempts = Math.max(1, opts.attempts ?? 4);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new DOMException("Stopped", "AbortError");
    }
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": GEOCODE_USER_AGENT,
          ...(init?.headers ?? {}),
        },
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < attempts - 1) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const wait =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 8000)
              : Math.min(400 * 2 ** attempt, 4000);
          await sleep(wait);
          continue;
        }
        throw lastError;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) {
        throw new DOMException("Stopped", "AbortError");
      }
      if (err instanceof Error && err.name === "AbortError") {
        if (attempt < attempts - 1) {
          await sleep(Math.min(400 * 2 ** attempt, 4000));
          continue;
        }
        throw new LookupTimeoutError();
      }
      const retryable = err instanceof TypeError;
      if (attempt < attempts - 1 && retryable) {
        await sleep(Math.min(400 * 2 ** attempt, 4000));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError;
}
