// Smartraveller sync: reads the destinations export feed and writes each
// country's overall advice level into public.advice_levels.
// Deploy from the Supabase dashboard (Edge Functions > New function) or with the CLI.
// Needs no secrets beyond the ones Supabase provides automatically. It uses the
// project's secret key (SUPABASE_SECRET_KEY) where the project has one, and falls
// back to the older service role key (SUPABASE_SERVICE_ROLE_KEY) otherwise.
// The response lists any country already in the table that was missing from this
// refresh, so a partial refresh is visible (the app shows those countries as dated).

import { createClient } from "npm:@supabase/supabase-js@2";

const FEED = "https://www.smartraveller.gov.au/destinations-export";

const LABELS: Record<number, string> = {
  1: "Exercise normal safety precautions",
  2: "Exercise a high degree of caution",
  3: "Reconsider your need to travel",
  4: "Do not travel",
};

// The feed has carried the level as a number, as text, and as HTML at different
// times, so read it defensively.
function toLevel(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && raw >= 1 && raw <= 4) return raw;
  const s = String(raw).replace(/<[^>]+>/g, " ").toLowerCase();
  const n = parseInt(s, 10);
  if (n >= 1 && n <= 4) return n;
  if (s.includes("do not travel")) return 4;
  if (s.includes("reconsider")) return 3;
  if (s.includes("high degree")) return 2;
  if (s.includes("normal safety")) return 1;
  return null;
}

function clean(s: unknown): string {
  return String(s ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#039;/g, "'").trim();
}

Deno.serve(async (_req) => {
  try {
    const res = await fetch(FEED, { headers: { "User-Agent": "MBS Travel Diary pilot" } });
    if (!res.ok) return new Response(`Feed returned ${res.status}`, { status: 502 });
    const data = await res.json();
    const items: any[] = Array.isArray(data) ? data : (data?.items ?? data?.data ?? []);

    const rows: any[] = [];
    for (const it of items) {
      const country = clean(it.title ?? it.name ?? it.country);
      const level = toLevel(it.field_overall_advice_level ?? it.overall_advice_level ?? it.advice_level ?? it.level);
      if (!country || !level) continue;
      let changed: string | null = null;
      const c = it.changed ?? it.updated ?? it.field_changed;
      if (c) {
        const n = typeof c === "number" ? c * (c < 1e12 ? 1000 : 1) : Date.parse(String(c));
        if (!isNaN(n)) changed = new Date(n).toISOString();
      }
      rows.push({ country, level, label: LABELS[level], changed, fetched_at: new Date().toISOString() });
    }
    if (rows.length < 50) {
      return new Response(`Parsed only ${rows.length} countries; feed format may have changed. First item: ${JSON.stringify(items[0]).slice(0, 400)}`, { status: 502 });
    }

    const key = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!key) return new Response("No secret key or service role key is available to the function", { status: 500 });
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, key);
    const { error } = await supabase.from("advice_levels").upsert(rows, { onConflict: "country" });
    if (error) return new Response(`Database error: ${error.message}`, { status: 500 });

    const seen = new Set(rows.map((r) => r.country.toLowerCase()));
    const { data: existing } = await supabase.from("advice_levels").select("country");
    const notRefreshed = (existing ?? []).map((r: any) => r.country as string).filter((c) => !seen.has(c.toLowerCase()));

    return new Response(JSON.stringify({ updated: rows.length, notRefreshed, at: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(`Sync failed: ${(e as Error).message}`, { status: 500 });
  }
});
