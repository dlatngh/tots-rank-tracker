import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import {
  parseRiotId,
  getAccount,
  invalidateRank,
  RiotApiError,
} from "../riot.ts";
import { setRegistration, type Division } from "../storage.ts";

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
  )
  .addStringOption((opt) =>
    opt
      .setName("division")
      .setDescription(
        "Ranked-race division. Omit to keep existing; pick None to remove.",
      )
      .addChoices(
        { name: "Upper", value: "upper" },
        { name: "Lower", value: "lower" },
        { name: "None", value: "none" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const discordId = interaction.options.getUser("user", true).id;
  const riotId = interaction.options.getString("riotid", true).trim();
  const divisionInput = interaction.options.getString("division");
  const division: Division | null | undefined =
    divisionInput === null
      ? undefined
      : divisionInput === "none"
        ? null
        : (divisionInput as Division);

  const parsed = parseRiotId(riotId);
  if (!parsed) {
    await interaction.editReply(
      `Invalid Riot ID \`${riotId}\`. Expected format: \`GameName#TAG\`.`,
    );
    return;
  }

  let puuid: string;
  try {
    const account = await getAccount(parsed.gameName, parsed.tagLine);
    puuid = account.puuid;
  } catch (err) {
    if (err instanceof RiotApiError && err.status === 404) {
      await interaction.editReply(
        `Riot account \`${riotId}\` not found. Double-check the name and tag.`,
      );
    } else {
      await interaction.editReply(
        `Failed to validate Riot ID: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  const { previous } = await setRegistration(discordId, puuid, division);
  invalidateRank(puuid);
  if (previous && previous !== puuid) invalidateRank(previous);

  const divisionNote =
    division === null
      ? " (removed from ranked race)"
      : division
        ? ` (division: **${division}**)`
        : "";

  if (previous && previous !== puuid) {
    await interaction.editReply(
      `Updated <@${discordId}>'s account to \`${riotId}\`${divisionNote}.`,
    );
  } else if (previous) {
    await interaction.editReply(
      `<@${discordId}> is already registered to \`${riotId}\`${divisionNote}.`,
    );
  } else {
    await interaction.editReply(
      `Registered <@${discordId}> as \`${riotId}\`${divisionNote}.`,
    );
  }
}
