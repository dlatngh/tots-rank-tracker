// One-off cleanup: wipe registered slash commands.
//   bun run src/clear-commands.ts global   # clear global commands
//   bun run src/clear-commands.ts guild    # clear commands in DISCORD_GUILD_ID

import { REST, Routes } from "discord.js";
import { config } from "./config.ts";

const scope = process.argv[2];
if (scope !== "global" && scope !== "guild") {
  console.error('Usage: bun run src/clear-commands.ts <global|guild>');
  process.exit(1);
}

if (scope === "guild" && !config.guildId) {
  console.error("DISCORD_GUILD_ID is not set.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(config.discordToken);
const route =
  scope === "guild"
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

console.log(`Clearing ${scope} commands...`);
await rest.put(route, { body: [] });
console.log("✅ Cleared.");
