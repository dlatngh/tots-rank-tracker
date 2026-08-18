import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { invalidateRank } from "../utility/riot.ts";
import { deleteRankHistory } from "../utility/rank-history.ts";
import { deleteRegistration } from "../utility/storage.ts";

export const data = new SlashCommandBuilder()
  .setName("unregister")
  .setDescription("Remove a player from tracking and the leaderboard entirely.")
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("The Discord user to remove.")
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const discordId = interaction.options.getUser("user", true).id;
  const { puuid } = await deleteRegistration(discordId);

  if (!puuid) {
    await interaction.editReply(`<@${discordId}> isn't registered.`);
    return;
  }

  invalidateRank(puuid);
  await deleteRankHistory(puuid);

  await interaction.editReply(
    `Removed <@${discordId}> from tracking and the leaderboard.`,
  );
}
