import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Health check. Replies with Pong.");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: "Pinging...",
    flags: MessageFlags.Ephemeral,
  });

  await interaction.editReply(`Pong!`);
}
