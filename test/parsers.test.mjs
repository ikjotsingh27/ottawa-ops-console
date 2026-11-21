import test from "node:test";
import assert from "node:assert/strict";
import { parseWeather, parseBorder, parseTraffic, parseFeed, parseKev, minutes } from "../scripts/fetch-live.mjs";

test("weather: alert, current conditions, forecast", () => {
  const xml = `<feed><entry><title>YELLOW ADVISORY - FOG, Ottawa</title><link type="text/html" href="https://weather.gc.ca/warnings/report_e.html?onrm96"/><updated>2026-11-21T14:58:16Z</updated><category term="Warnings and Watches"/><summary type="html">Persons in or near this area should be on the lookout for adverse weather conditions.</summary></entry>
  <entry><title>Current Conditions: Fog, 5.7&#xB0;C</title><updated>2026-11-21T15:00:00Z</updated><category term="Current Conditions"/><summary type="html"><![CDATA[<b>Observed at:</b> Ottawa Macdonald-Cartier Int'l Airport 10:00 AM EST Saturday 21 November 2026 <br/>
<b>Temperature:</b> 5.7&deg;C <br/><b>Humidity:</b> 99 % <br/><b>Wind:</b> SW 9 km/h<br/><b>Air Quality Health Index:</b> 2 <br/>]]></summary></entry>
  <entry><title>Saturday: Mainly sunny. High 15.</title><category term="Weather Forecasts"/><summary>x</summary></entry></feed>`;
  const w = parseWeather(xml);
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0].title, /FOG/);
  assert.equal(w.current.title, "Fog, 5.7°C");
  assert.equal(w.current.temperature, "5.7°C");
  assert.equal(w.current.humidity, "99 %");
  assert.equal(w.current.aqhi, "2");
  assert.deepEqual(w.forecast, ["Saturday: Mainly sunny. High 15."]);
});
test("weather: no warnings entry is not an alert", () => {
  const w = parseWeather(`<feed><entry><title>No watches or warnings in effect, Ottawa</title><category term="Warnings and Watches"/></entry></feed>`);
  assert.equal(w.alerts.length, 0);
});
test("border: tolerant columns and minute parsing", () => {
  const csv = '﻿CBSA Office,Location,Commercial Flow,Travellers Flow,Updated\r\n"Lansdowne (Thousand Islands Bridge)","Lansdowne, ON",No Delay,15 minutes,2026-11-21 17:00 EST\r\nPrescott,"Prescott, ON",Not Applicable,No Delay,2026-11-21 16:55 EST\r\nAmbassador Bridge,"Windsor, ON",1 hour 10 minutes,Temporarily closed,2026-11-21 17:01 EST\r\n';
  const b = parseBorder(csv);
  assert.equal(b.crossings.length, 3);
  assert.equal(b.crossings[0].travellers, 15);
  assert.equal(b.crossings[0].local, true);
  assert.equal(b.crossings[1].commercial, null);
  assert.equal(b.crossings[2].commercial, 70);
  assert.equal(b.crossings[2].travellers, "closed");
  assert.equal(b.crossings[2].local, false);
  assert.equal(minutes("No Delay"), 0);
});
test("traffic: active incidents ranked by priority", () => {
  const t = parseTraffic([
    { Id: 1, EventType: "INCIDENT", status: "ACTVE", headline: "Collision", priority: "LOW", mainStreet: "Bank St", Updated: "2026-11-21 16:00" },
    { Id: 2, EventType: "INCIDENT", status: "ACTVE", headline: "Road closed", priority: "HIGH", mainStreet: "Hwy 417", Updated: "2026-11-21 15:00" },
    { Id: 3, EventType: "CONSTRUCTION", status: "ACTVE", headline: "Works", priority: "LOW" },
    { Id: 4, EventType: "INCIDENT", status: "ARCHIVED", headline: "Old" },
  ]);
  assert.equal(t.counts.incidents, 2);
  assert.equal(t.counts.construction, 1);
  assert.equal(t.counts.highPriority, 1);
  assert.equal(t.incidents[0].headline, "Road closed");
});
test("cyber feed: RSS items sorted newest first with alert ids", () => {
  const f = parseFeed(`<rss><channel><item><title>AV26-900 - Microsoft security advisory</title><link>https://www.cyber.gc.ca/en/alerts-advisories/av26-900</link><pubDate>Fri, 20 Nov 2026 12:00:00 EST</pubDate><description>&lt;p&gt;Microsoft published updates&lt;/p&gt;</description></item>
  <item><title>AL26-028 - Help desk voice phishing campaign</title><link>https://www.cyber.gc.ca/en/alerts-advisories/al26-028</link><pubDate>Sat, 21 Nov 2026 09:00:00 EST</pubDate></item></channel></rss>`);
  assert.equal(f.items[0].kind, "Alert");
  assert.equal(f.items[1].summary, "Microsoft published updates");
});
test("kev: counts and latest", () => {
  const k = parseKev({ catalogVersion: "2026.11.20", vulnerabilities: [
    { cveID: "CVE-1", vendorProject: "Microsoft", product: "Windows", dateAdded: "2026-11-19", knownRansomwareCampaignUse: "Known" },
    { cveID: "CVE-2", vendorProject: "Apache", product: "Log4j2", dateAdded: "2026-10-01" },
  ] }, new Date("2026-11-21T12:00:00Z"));
  assert.equal(k.total, 2); assert.equal(k.added7, 1); assert.equal(k.latest[0].cve, "CVE-1");
});
