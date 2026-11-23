// Feed health: finds feeds that have been failing for a while and writes an issue body.
// Usage in CI: node scripts/health.mjs   (writes health.md and health.count, prints a summary)
import { readFile, writeFile } from "node:fs/promises";

export function downFeeds(live, nowMs = Date.now(), hours = 6) {
  const out = [];
  for (const [id, s] of Object.entries(live?.sources || {})) {
    if (s.ok || !s.failingSince) continue;
    const h = (nowMs - Date.parse(s.failingSince)) / 36e5;
    if (h >= hours) out.push({ id, name: s.name || id, hours: h, since: s.failingSince, error: s.error || "", page: s.page || "" });
  }
  return out;
}

export function healthMarkdown(feeds) {
  const lines = feeds.map((f) => `- **${f.name}**: failing for about ${Math.round(f.hours)} hours (since ${f.since}). Last error: \`${String(f.error).slice(0, 160)}\`${f.page ? ` ([source page](${f.page}))` : ""}`);
  return [
    "These live feeds have not updated successfully for 6 hours or more. The site keeps showing the last good data and marks it stale.",
    "",
    ...lines,
    "",
    "This issue updates itself every run and closes when the feeds recover. Common causes: the publisher changed the file format or address, or the service is down.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const live = JSON.parse(await readFile(process.env.LIVE_OUT || "site/live.json", "utf8"));
  const feeds = downFeeds(live);
  await writeFile("health.md", healthMarkdown(feeds));
  await writeFile("health.count", String(feeds.length));
  console.log(`${feeds.length} feed(s) down 6h or more`);
}
