import { Client } from "discord.js";
import { commands } from "./src/commands";
import { deployCommands } from "./src/utility/deploy-commands";

const client = new Client({
  intents: ["Guilds", "GuildMessages", "DirectMessages"],
});

client.once("clientReady", async () => {
  console.log("Discord bot is ready! 🤖");

  for (const guild of client.guilds.cache.values()) {
    await deployCommands({ guildId: guild.id });
  }
});

client.on("guildCreate", async (guild) => {
  await deployCommands({ guildId: guild.id });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) {
    return;
  }
  const { commandName } = interaction;
  if (commands[commandName as keyof typeof commands]) {
    commands[commandName as keyof typeof commands].execute(interaction);
  }
});

client.login(process.env.DISCORD_TOKEN);
