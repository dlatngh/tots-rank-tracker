import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { parseRiotId, getAccount, invalidateRankCache, RiotApiError } from "../riot.ts";
import { setRegistration } from "../storage.ts";

export const data = new SlashCommandBuilder()
  .setName("register")
  .setDescription("Register or update a Discord user's Riot ID.")
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("The Discord user to register.")
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("riotid")
      .setDescription("Riot ID in GameName#TAG format.")
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const discordId = interaction.options.getUser("user", true).id;
  const riotId = interaction.options.getString("riotid", true).trim();

  const parsed = parseRiotId(riotId);
  if (!parsed) {
    await interaction.editReply(`Invalid Riot ID \`${riotId}\`. Expected format: \`GameName#TAG\`.`);
    return;
  }

  let puuid: string;
  try {
    const account = await getAccount(parsed.gameName, parsed.tagLine);
    puuid = account.puuid;
  } catch (err) {
    if (err instanceof RiotApiError && err.status === 404) {
      await interaction.editReply(`Riot account \`${riotId}\` not found. Double-check the name and tag.`);
    } else {
      await interaction.editReply(`Failed to validate Riot ID: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const { previous } = await setRegistration(discordId, puuid);
  invalidateRankCache(puuid);
  if (previous && previous !== puuid) invalidateRankCache(previous);

  if (previous && previous !== puuid) {
    await interaction.editReply(
      `Updated <@${discordId}>'s account to \`${riotId}\`.`,
    );
  } else if (previous) {
    await interaction.editReply(
      `<@${discordId}> is already registered to \`${riotId}\`. Timestamp refreshed.`,
    );
  } else {
    await interaction.editReply(
      `Registered <@${discordId}> as \`${riotId}\`.`,
    );
  }
}
