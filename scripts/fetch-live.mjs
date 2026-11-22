// Hourly live data job for the Unified Operations Console.
// Runs on GitHub Actions (Node 22, no dependencies). Each source is fetched on its own;
// a failing source keeps its last good data and is marked stale instead of breaking the page.
import { readFile, writeFile } from "node:fs/promises";

const OUT = process.env.LIVE_OUT || "site/live.json";
const HIST = process.env.HIST_OUT || "site/history.json";
const UA = { "user-agent": "ottawa-ops-console/1.0 (+https://github.com/ikjotsingh27/ottawa-ops-console)" };
const now = new Date();
const NOW = now.toISOString();

export const SOURCES = {
  weather: { name: "Environment Canada: Ottawa weather and alerts", url: "https://weather.gc.ca/rss/weather/45.403_-75.687_e.xml", page: "https://weather.gc.ca/en/location/index.html?coords=45.403,-75.687", cadence: "Alerts as issued, conditions hourly" },
  border: { name: "CBSA: border wait times", url: "https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv", page: "https://www.cbsa-asfc.gc.ca/bwt-taf/menu-eng.html", cadence: "At least hourly" },
  traffic: { name: "City of Ottawa: traffic events", url: "https://traffic.ottawa.ca/map/service/events?accept-language=en", page: "https://traffic.ottawa.ca/en/", cadence: "Live" },
  cyber: { name: "Canadian Centre for Cyber Security: alerts and advisories", url: "https://www.cyber.gc.ca/api/cccs/rss/v1/get?feed=alerts_advisories&lang=en", page: "https://www.cyber.gc.ca/en/alerts-advisories", cadence: "Several times a day" },
  kev: { name: "CISA: Known Exploited Vulnerabilities", url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", page: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog", cadence: "When CISA updates the catalog" },
  ops: { name: "Ottawa Police: occurrences year to date (experimental)", url: "https://services8.arcgis.com/lYI034SQcOoxRCR7/ArcGIS/rest/services/PublicCrimeDataFME/FeatureServer/0", page: "https://data.ottawapolice.ca", cadence: "Daily at 7:30 a.m." },
};

async function get(url, type = "text", ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: c.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return type === "json" ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- small text helpers ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°" };
export function decode(s = "") {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
export function plain(html = "") {
  return decode(decode(html))
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; };
const attr = (xml, name, a) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]*)"`, "i")); return m ? decode(m[1]) : ""; };

/* ---------- parsers (exported for tests) ---------- */
export function parseWeather(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]).map((e) => ({
    title: plain(tag(e, "title")), cat: attr(e, "category", "term"), updated: plain(tag(e, "updated")),
    summary: plain(tag(e, "summary")), link: attr(e, "link", "href"),
  }));
  const warn = entries.filter((e) => /warning|watch/i.test(e.cat));
  const alerts = warn.filter((e) => !/^no watches or warnings/i.test(e.title)).map((e) => ({ title: e.title, updated: e.updated, summary: e.summary.slice(0, 600), link: e.link }));
  const cur = entries.find((e) => /current conditions/i.test(e.cat));
  const lines = cur ? cur.summary.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const pick = (re) => (lines.find((l) => re.test(l)) || "").replace(/^[^:]+:\s*/, "");
  const forecast = entries.filter((e) => /forecast/i.test(e.cat)).slice(0, 4).map((e) => e.title);
  if (!cur && !entries.length) throw new Error("No entries in weather feed");
  return {
    alerts,
    current: cur ? { title: cur.title.replace(/^Current Conditions:\s*/i, ""), observed: pick(/observed at/i), temperature: pick(/^temperature/i), humidity: pick(/humidity/i), wind: pick(/^wind/i), visibility: pick(/visibility/i), aqhi: pick(/air quality/i), updated: cur.updated } : null,
    forecast,
  };
}

export function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
export const minutes = (v = "") => {
  const s = v.trim().toLowerCase();
  if (!s || /not applicable|n\/a/.test(s)) return null;
  if (/no delay/.test(s)) return 0;
  if (/closed/.test(s)) return "closed";
  let m = 0; const h = s.match(/(\d+)\s*h/); const mm = s.match(/(\d+)\s*min/);
  if (h) m += +h[1] * 60; if (mm) m += +mm[1];
  if (!h && !mm) { const n = s.match(/\d+/); if (n) m = +n[0]; else return null; }
  return m;
};
const LOCAL = /cornwall|prescott|lansdowne|thousand islands|lacolle|armand|ogdensburg|massena|alexandria bay/i;
export function parseBorder(csv) {
  const text = csv.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const rows = first.includes(";;")
    ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(";;").map((x) => x.trim())).map((r) => (r[r.length - 1] === "" ? r.slice(0, -1) : r))
    : parseCSV(text);
  if (rows.length < 2) throw new Error("Border file is empty");
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const col = (re, not) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const iName = col(/office|crossing|name|port/), iLoc = col(/location|province|region/), iUpd = col(/updated|date|time/);
  const iCom = col(/commercial.*canada/) >= 0 ? col(/commercial.*canada/) : col(/commercial/, /u\.?s\.? bound/);
  const iTrav = col(/travel.*canada/) >= 0 ? col(/travel.*canada/) : col(/travel/, /u\.?s\.? bound/);
  const iComUS = col(/commercial.*u\.?s\.? bound/), iTravUS = col(/travel.*u\.?s\.? bound/);
  if (iName < 0 || iTrav < 0 || new Set([iName, iTrav]).size < 2) throw new Error("Border columns not recognised: " + rows[0].join(" | "));
  const cell = (r, i) => (i >= 0 ? (r[i] || "").trim() : "");
  const val = (r, i) => { const t = cell(r, i); return !t || t === "--" ? null : minutes(t); };
  const list = rows.slice(1).map((r) => ({
    name: cell(r, iName), location: cell(r, iLoc), updated: cell(r, iUpd),
    commercialText: cell(r, iCom), travellersText: cell(r, iTrav),
    commercial: val(r, iCom), travellers: val(r, iTrav), commercialUS: val(r, iComUS), travellersUS: val(r, iTravUS),
  })).filter((x) => x.name);
  list.forEach((x) => (x.local = LOCAL.test(x.name + " " + x.location)));
  return { crossings: list };
}

export function parseTraffic(json) {
  const arr = Array.isArray(json) ? json : json.events || json.features?.map((f) => f.properties) || [];
  if (!Array.isArray(arr)) throw new Error("Traffic feed shape not recognised");
  const g = (o, k) => o[k] ?? o[k[0].toLowerCase() + k.slice(1)] ?? o[k.toLowerCase()];
  const ev = arr.map((o) => ({
    id: g(o, "Id"), type: String(g(o, "EventType") || ""), sub: String(g(o, "eventSubType") || ""), status: String(g(o, "status") || ""),
    headline: plain(g(o, "headline") || ""), message: plain(g(o, "message") || "").slice(0, 260),
    main: g(o, "mainStreet") || "", cross1: g(o, "crossStreet1") || "", cross2: g(o, "crossStreet2") || "",
    priority: String(g(o, "priority") || g(o, "Priority") || "UNKNOWN").toUpperCase(), closure: g(o, "closureType") || "", area: g(o, "area") || "",
    updated: g(o, "Updated") || "", created: g(o, "Created") || "",
  }));
  const active = ev.filter((e) => /^act/i.test(e.status) || !e.status);
  const isInc = (e) => /incident/i.test(e.type);
  const counts = { incidents: active.filter(isInc).length, construction: active.filter((e) => /construct/i.test(e.type)).length, special: active.filter((e) => /special/i.test(e.type)).length, highPriority: active.filter((e) => isInc(e) && e.priority === "HIGH").length };
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 };
  const incidents = active.filter(isInc).sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || String(b.updated).localeCompare(String(a.updated))).slice(0, 30);
  return { counts, incidents, total: ev.length };
}

export function parseFeed(xml) {
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]).map((e) => ({
    title: plain(tag(e, "title")),
    link: plain(tag(e, "link")) || attr(e, "link", "href"),
    date: plain(tag(e, "pubDate") || tag(e, "updated") || tag(e, "published") || tag(e, "dc:date")),
    summary: plain(tag(e, "description") || tag(e, "summary")).slice(0, 400),
  })).filter((x) => x.title);
  if (!items.length) throw new Error("No items in advisory feed");
  items.forEach((x) => { const d = Date.parse(x.date); x.iso = isNaN(d) ? null : new Date(d).toISOString(); const id = x.title.match(/\b(AL|AV)\d{2}-\d{3}\b/); x.kind = id ? (id[1] === "AL" ? "Alert" : "Advisory") : ""; });
  items.sort((a, b) => (b.iso || "").localeCompare(a.iso || ""));
  return { items: items.slice(0, 15) };
}

export function parseKev(json, ref = now) {
  const v = json.vulnerabilities;
  if (!Array.isArray(v)) throw new Error("KEV feed shape not recognised");
  const day = 864e5, t = ref.getTime();
  const within = (d, n) => t - Date.parse(d + "T00:00:00Z") <= n * day;
  const sorted = [...v].sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
  return {
    catalogVersion: json.catalogVersion, total: v.length,
    added7: v.filter((x) => within(x.dateAdded, 7)).length, added30: v.filter((x) => within(x.dateAdded, 30)).length,
    latest: sorted.slice(0, 15).map((x) => ({ cve: x.cveID, vendor: x.vendorProject, product: x.product, name: x.vulnerabilityName, added: x.dateAdded, due: x.dueDate, ransomware: x.knownRansomwareCampaignUse, action: String(x.requiredAction || "").slice(0, 200) })),
  };
}

/* Ottawa Police occurrences: discover fields at run time, then count year to date by category. */
async function fetchOps() {
  const base = SOURCES.ops.url;
  const meta = await get(base + "?f=json", "json");
  if (meta.error) throw new Error(`ArcGIS: ${meta.error.message || meta.error.code}`);
  const fields = meta.fields || [];
  const date = fields.find((f) => f.type === "esriFieldTypeDate" && /rep|report/i.test(f.name)) || fields.find((f) => f.type === "esriFieldTypeDate" && /occ|date/i.test(f.name)) || fields.find((f) => f.type === "esriFieldTypeDate");
  const byName = (n) => fields.find((f) => f.name.toLowerCase() === n);
  const cat = byName("occ_type") || byName("case_type_pubtrans") || fields.find((f) => f.type === "esriFieldTypeString" && /offen[cs]e|crime_?type|occurrence type/i.test(f.name + " " + (f.alias || "")));
  const extra = { district: byName("district"), shooting: byName("shooting"), hate: byName("hate_crime") };
  if (!date || !cat) throw new Error("Fields not recognised: " + fields.map((f) => f.name).join(", ").slice(0, 400));
  const tz = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = tz.split("-").map(Number);
  const ymd = (yy) => `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const stat = encodeURIComponent(JSON.stringify([{ statisticType: "count", onStatisticField: meta.objectIdField || "OBJECTID", outStatisticFieldName: "n" }]));
  async function counts(yy, field) {
    const where = encodeURIComponent(`${date.name} >= DATE '${yy}-01-01' AND ${date.name} < DATE '${ymd(yy)}'`);
    const r = await get(`${base}/query?where=${where}&outStatistics=${stat}&groupByFieldsForStatistics=${field}&f=json`, "json");
    if (r.error) throw new Error(`ArcGIS query: ${r.error.message || r.error.code}`);
    const out = {}; for (const f of r.features || []) { const k = String(f.attributes[field] ?? "Unknown").trim() || "Unknown"; out[k] = (out[k] || 0) + (f.attributes.n ?? f.attributes.N ?? 0); } return out;
  }
  const compare = async (field, top) => {
    const [cur, prev] = await Promise.all([counts(y, field), counts(y - 1, field)]);
    let rows = [...new Set([...Object.keys(cur), ...Object.keys(prev)])].map((k) => ({ category: k, ytd: cur[k] || 0, prior: prev[k] || 0 })).sort((a, b) => b.ytd - a.ytd);
    if (top && rows.length > top) { const rest = rows.slice(top); rows = rows.slice(0, top).concat([{ category: `All other (${rest.length} types)`, ytd: rest.reduce((s, r) => s + r.ytd, 0), prior: rest.reduce((s, r) => s + r.prior, 0) }]); }
    return rows;
  };
  const rows = await compare(cat.name, 15);
  const flag = (rs) => { const yes = rs.filter((r) => !/^(n|no|false|0|unknown|null|none|-|)$/i.test(r.category.trim())); return yes.length ? { ytd: yes.reduce((s, r) => s + r.ytd, 0), prior: yes.reduce((s, r) => s + r.prior, 0) } : null; };
  const safe = async (f, top) => { try { return f ? await compare(f.name, top) : null; } catch { return null; } };
  const [districts, shootRows, hateRows] = await Promise.all([safe(extra.district, 12), safe(extra.shooting), safe(extra.hate)]);
  const flagValues = { shooting: shootRows?.map((r) => r.category), hate: hateRows?.map((r) => r.category) };
  return { flagValues, asOf: ymd(y), year: y, dateField: date.name, categoryField: cat.name, rows, districts, shootings: shootRows && flag(shootRows), hateCrimes: hateRows && flag(hateRows), totalYtd: rows.reduce((s, r) => s + r.ytd, 0), totalPrior: rows.reduce((s, r) => s + r.prior, 0) };
}

const JOBS = {
  weather: async () => parseWeather(await get(SOURCES.weather.url)),
  border: async () => parseBorder(await get(SOURCES.border.url)),
  traffic: async () => parseTraffic(await get(SOURCES.traffic.url, "json")),
  cyber: async () => parseFeed(await get(SOURCES.cyber.url)),
  kev: async () => parseKev(await get(SOURCES.kev.url, "json")),
  ops: fetchOps,
};

async function readJSON(p, fallback) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; } }

export async function run() {
  const prev = await readJSON(OUT, { sources: {} });
  const hist = await readJSON(HIST, { border: [] });
  const out = { generatedAt: NOW, sources: {} };
  await Promise.all(Object.entries(JOBS).map(async ([id, job]) => {
    const meta = SOURCES[id];
    try {
      const data = await job();
      out.sources[id] = { ...meta, ok: true, fetchedAt: NOW, checkedAt: NOW, data };
      console.log(`ok   ${id}`);
    } catch (e) {
      const old = prev.sources?.[id];
      out.sources[id] = { ...meta, ok: false, checkedAt: NOW, fetchedAt: old?.fetchedAt || null, error: String(e.message || e).slice(0, 500), data: old?.data || null };
      console.log(`FAIL ${id}: ${e.message || e}`);
    }
  }));
  const b = out.sources.border;
  if (b?.ok) {
    const snap = { t: NOW, w: {} };
    for (const c of b.data.crossings.filter((x) => x.local)) snap.w[c.name] = c.travellers;
    hist.border = [...(hist.border || []), snap].filter((s) => Date.parse(s.t) > now.getTime() - 7 * 864e5).slice(-200);
  }
  await writeFile(OUT, JSON.stringify(out));
  await writeFile(HIST, JSON.stringify(hist));
  const okN = Object.values(out.sources).filter((s) => s.ok).length;
  console.log(`${okN}/${Object.keys(JOBS).length} sources fresh at ${NOW}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await run();
