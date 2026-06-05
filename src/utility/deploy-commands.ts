// Registers slash commands with Discord.
//
// Importable: call `registerCommands()` from anywhere (e.g. on bot startup
// in dev). Runnable directly as a one-off script:  bun run deploy
//
// If DISCORD_GUILD_ID is set, commands register to that guild (instant).
// Otherwise they register globally (can take up to ~1 hour to propagate).

import { REST, Routes } from "discord.js";
import { commands } from "../commands/index.ts";
import { config } from "./config.ts";

const rest = new REST({ version: "10" }).setToken(config.discordToken);

export async function registerCommands(): Promise<void> {
  const commandsData = Object.values(commands).map((c) => c.data.toJSON());

  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  console.log(
    `Registering ${commandsData.length} command(s) ${
      config.guildId ? `to guild ${config.guildId}` : "globally"
    }...`,
  );
  await rest.put(route, { body: commandsData });
  console.log("✅ Commands registered.");
}

// Run as a standalone script when invoked directly (not when imported).
if (import.meta.main) {
  try {
    await registerCommands();
  } catch (err) {
    console.error("Failed to register commands:", err);
    process.exit(1);
  }
}
