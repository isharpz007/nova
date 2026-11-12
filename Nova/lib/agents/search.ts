/**
 * Free web research for agents — DuckDuckGo HTML endpoint, no API key.
 * Returns a short digest of top results for injection into agent context.
 */

interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

export async function webSearch(query: string, max = 4): Promise<string> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`Search (${res.status})`);
  const html = await res.text();

  const hits: SearchHit[] = [];
  const blocks = html.split('class="result__body"').slice(1, max + 1);
  for (const b of blocks) {
    const t = b.match(/result__a[^>]*>([\s\S]*?)<\/a>/);
    const s = b.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/);
    const u = b.match(/result__a[^>]*href="([^"]+)"/);
    const title = t ? stripTags(t[1]) : "";
    const snippet = s ? stripTags(s[1]) : "";
    if (title) {
      hits.push({
        title,
        snippet,
        url: u ? decodeURIComponent(u[1].replace(/.*uddg=/, "").split("&")[0]) : "",
      });
    }
  }
  if (!hits.length) return "";

  return (
    "Web research (use only if relevant — prefer facts over guesses):\n" +
    hits.map((h, i) => `${i + 1}. ${h.title} — ${h.snippet} (${h.url})`).join("\n") +
    "\n\n"
  );
}

/** Does this request likely need live/online information? */
export function needsResearch(request: string): boolean {
  return /\b(today|now|current|latest|news|recent|price|weather|score|who won|release|version|update|2025|2026)\b/i.test(
    request
  );
}
