// One-off: backfill gameName/tagLine into registrations.json from the rank
// cache so /val no longer has to call Riot's account-v1 on cold leaderboards.
//   bun run src/backfill-riot-ids.ts

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REGISTRATIONS = resolve(process.cwd(), "data", "registrations.json");
const CACHE = resolve(process.cwd(), "data", "rank-cache.json");

const regs = JSON.parse(await readFile(REGISTRATIONS, "utf8")) as Record<
  string,
  { puuid: string; gameName?: string; tagLine?: string; [k: string]: unknown }
>;
const cache = JSON.parse(await readFile(CACHE, "utf8")) as Record<
  string,
  { gameName?: string; tagLine?: string }
>;

let updated = 0;
let skipped = 0;
for (const [discordId, reg] of Object.entries(regs)) {
  if (reg.gameName && reg.tagLine) {
    skipped++;
    continue;
  }
  const cached = cache[`lol:${reg.puuid}`] ?? cache[`val:${reg.puuid}`];
  if (cached?.gameName && cached?.tagLine) {
    regs[discordId] = {
      ...reg,
      gameName: cached.gameName,
      tagLine: cached.tagLine,
    };
    updated++;
    console.log(`  ${discordId} → ${cached.gameName}#${cached.tagLine}`);
  }
}

if (updated > 0) {
  await writeFile(REGISTRATIONS, JSON.stringify(regs, null, 2), "utf8");
}
console.log(`\nDone. Updated ${updated}, skipped ${skipped}.`);
