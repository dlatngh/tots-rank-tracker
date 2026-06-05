import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { buildRankPayload, handleRankRefresh } from "../rank-render.ts";

export const data = new SlashCommandBuilder()
  .setName("val")
  .setDescription("Show a registered user's Valorant rank.")
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("The Discord user to look up. Defaults to yourself."),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const user = interaction.options.getUser("user") ?? interaction.user;
  await interaction.editReply(await buildRankPayload(user, "val"));
}

export function handleRefresh(interaction: ButtonInteraction) {
  return handleRankRefresh(interaction, "val");
}
