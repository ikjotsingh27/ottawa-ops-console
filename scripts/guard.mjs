// Decides whether a scheduled run should skip because the data is already fresh.
// Several backup schedule slots exist because GitHub can drop scheduled runs; this keeps
// the backups from refreshing more often than every two hours. Manual and push runs never skip.
import { readFile, appendFile } from "node:fs/promises";

export function shouldSkip(event, generatedAt, nowMs = Date.now(), minutes = 90) {
  if (event !== "schedule" || !generatedAt) return false;
  const t = Date.parse(generatedAt);
  if (isNaN(t)) return false;
  return nowMs - t < minutes * 6e4;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  let g;
  try { g = JSON.parse(await readFile(process.env.LIVE_OUT || "site/live.json", "utf8")).generatedAt; } catch {}
  const skip = shouldSkip(process.env.GITHUB_EVENT_NAME, g);
  console.log(`event=${process.env.GITHUB_EVENT_NAME} last=${g} skip=${skip}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `skip=${skip}\n`);
}
