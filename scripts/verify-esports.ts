// One-off manual verification for the esports schedule query. Single request
// after a wait to respect Fandom's anonymous rate limit. Not part of the bot.
import { resolveLeague, getUpcomingMatches } from "../src/utility/esports.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("waiting 180s to clear rate-limit cooldown...");
await wait(180_000);

const league = resolveLeague("lol", "LCK")!;
console.log("resolved:", league);
const up = await getUpcomingMatches("lol", league, 3);
console.log("upcoming LCK:", JSON.stringify(up, null, 1));
console.log("DONE");
