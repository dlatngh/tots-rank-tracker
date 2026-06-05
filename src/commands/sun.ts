import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("sun")
  .setDescription("beer");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content: "beer",
  });
}
