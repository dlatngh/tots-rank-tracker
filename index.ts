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

    const started = Date.now();
    const sub = interaction.options.getSubcommand(false);
    const label = sub
      ? `/${interaction.commandName} ${sub}`
      : `/${interaction.commandName}`;
    console.log(
      `[cmd] ${label} by ${interaction.user.tag} in ${interaction.guild?.name ?? "DM"}`,
    );
    try {
      await command.execute(interaction);
      console.log(`[cmd] ${label} done (${Date.now() - started}ms)`);
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
    const [namespace] = interaction.customId.split(":");
    const started = Date.now();
    console.log(
      `[btn] ${interaction.customId} by ${interaction.user.tag}`,
    );
    try {
      if (namespace === "lol") {
        await commands.lol.handleRefresh(interaction);
      } else if (namespace === "val") {
        await commands.val.handleRefresh(interaction);
      } else if (namespace === "leaderboard") {
        await commands.leaderboard.handleRefresh(interaction);
      }
      console.log(`[btn] ${interaction.customId} done (${Date.now() - started}ms)`);
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
