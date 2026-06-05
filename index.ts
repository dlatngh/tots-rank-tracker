import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./src/config.ts";
import { commands } from "./src/commands/index.ts";
import { registerCommands } from "./src/deploy-commands.ts";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);

  // Auto-register on startup only in guild-dev mode (instant + safe to repeat).
  // Global registration stays a manual `bun run deploy` to avoid rate limits.
  if (config.guildId) {
    await registerCommands().catch((err) =>
      console.error("Auto command registration failed:", err),
    );
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = commands[interaction.commandName as keyof typeof commands];
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error in /${interaction.commandName}:`, err);
      const msg = "An error occurred while executing this command.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton()) {
    // customId is namespaced as "<command>:<action>[:...]" — route on the prefix.
    const [namespace] = interaction.customId.split(":");
    try {
      if (namespace === "rank") {
        await commands.rank.handleRefresh(interaction);
      } else if (namespace === "leaderboard") {
        await commands.leaderboard.handleRefresh(interaction);
      }
    } catch (err) {
      console.error(`Error handling button ${interaction.customId}:`, err);
      const msg = "An error occurred while refreshing.";
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
      }
    }
  }
});

await client.login(config.discordToken);
