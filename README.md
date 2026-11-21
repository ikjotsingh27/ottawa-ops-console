# Unified Operations Console

**Live site:** https://ikjotsingh27.github.io/ottawa-ops-console/

One console with two desks:

- **Public safety (Ottawa).** Live conditions (weather alerts, border waits, City road incidents), Ottawa Police year to date, and the 2025 published picture for police, fire, paramedics, 9-1-1 and by-law, with sources and caveats on every number.
- **Cyber defence (SOC).** A 13 module SOC and Blue Team lab built around one intrusion, with working tools (detection rule tester, log search, YARA scanner, hunts, indicator enrichment, sandbox and forensic timelines, phishing classifier), a triage queue, and a live threat feed of Canadian Cyber Centre alerts and CISA known exploited vulnerabilities.

Every section has an **info button** explaining what it shows, where the data comes from, how often it updates and how to read it.

Built by Ikjot Singh as a portfolio project (Bachelor of Public Safety, Algonquin College).

## How the hourly refresh works

A browser page cannot pull data from government sites directly, so a GitHub Actions job does it:

1. Every hour at :17, `.github/workflows/hourly.yml` runs `scripts/fetch-live.mjs` (Node 22, no dependencies).
2. The script fetches each feed on its own. A failing feed keeps its last good data and is marked stale, so one outage never breaks the page.
3. Results are written to `site/live.json` and `site/history.json` (7 days of border wait history), committed, and the `site/` folder is deployed to GitHub Pages.
4. The page reloads `live.json` every 10 minutes and shows how old each feed is.

You can also run it on demand: **Actions → Hourly live data and deploy → Run workflow**.

| Feed | Publisher | Publisher updates |
|---|---|---|
| Ottawa weather and alerts | Environment and Climate Change Canada | Alerts as issued, conditions hourly |
| Border wait times | Canada Border Services Agency | At least hourly |
| Traffic events | City of Ottawa | Live |
| Alerts and advisories | Canadian Centre for Cyber Security | Several times a day |
| Known Exploited Vulnerabilities | CISA | When the catalog changes |
| Occurrences year to date (experimental) | Ottawa Police Service | Daily, 7:30 a.m. |

Published figures (2025 annual reports released in 2026, Statistics Canada July 2026) live in `site/data.json` with their sources.

## Run locally

```bash
node --test test/parsers.test.mjs   # parser tests
node scripts/fetch-live.mjs         # refresh site/live.json (needs internet)
cd site && python3 -m http.server   # open http://localhost:8000
```

## Notes

- Not a dispatch or SIEM feed. Police counts for the current year are preliminary and change as late reports arrive.
- SOC content is lab material; triage states and timings are stored only in your browser.
- GitHub may delay scheduled runs at busy times, and pauses schedules on repos with no activity for 60 days. The hourly data commits keep this repo active.

## Data licences

Contains information licensed under the Open Government Licence – Canada, the Open Government Licence – City of Ottawa, and the Open Government Licence – Ontario. CISA KEV data is public domain (U.S. Government work). Ottawa Police Service data is provided under its open data terms.
