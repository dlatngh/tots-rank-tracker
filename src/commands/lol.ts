import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { buildRankPayload, handleRankRefresh } from "../utility/rank-render.ts";

export const data = new SlashCommandBuilder()
  .setName("lol")
  .setDescription("Show a registered user's League of Legends solo/duo rank.")
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("The Discord user to look up. Defaults to yourself."),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const user = interaction.options.getUser("user") ?? interaction.user;
  await interaction.editReply(await buildRankPayload(user, "lol"));
}

export function handleRefresh(interaction: ButtonInteraction) {
  return handleRankRefresh(interaction, "lol");
}
