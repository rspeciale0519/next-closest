import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const extractInput = z.object({
  imageDataUrl: z
    .string()
    .min(32)
    .max(8_000_000)
    .refine((value) => value.startsWith("data:image/"), "Not an image"),
});

export type ExtractAddressesResult =
  | { ok: true; addresses: string[] }
  | { ok: false; error: string };

export const extractAddressesFromImage = createServerFn({ method: "POST" })
  .validator((data) => extractInput.parse(data))
  .handler(async ({ data }): Promise<ExtractAddressesResult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "Photo reading is not available right now." };
    }

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 700,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: data.imageDataUrl, detail: "high" },
              },
              {
                type: "text",
                text: [
                  "Extract every street address visible in this image or screenshot.",
                  'Return JSON only with shape {"addresses":["..."]}.',
                  "Keep the house number and the street suffix exactly as written (Dr, Pl, Ct, Ave).",
                  "Always include city and the two-letter US state (Merritt Island implies FL).",
                  "Skip people names, job statuses, times, companies, and map pins.",
                  "If a city is shown once for a list of streets, apply it to each street.",
                  "If there are no addresses, return {\"addresses\":[]}.",
                ].join(" "),
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      return { ok: false, error: "Could not read that photo. Try another image." };
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    const addresses = parseAddressJson(text);
    return { ok: true, addresses };
  });

function parseAddressJson(text: string): string[] {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "addresses" in parsed
        ? (parsed as { addresses: unknown }).addresses
        : [];
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== "string") continue;
      const address = item.replace(/\s+/g, " ").trim();
      if (!address) continue;
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(address);
    }
    return out.slice(0, 25);
  } catch {
    return [];
  }
}
