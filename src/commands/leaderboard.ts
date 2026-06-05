import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import {
  formatRank,
  getRank,
  invalidateRank,
  rankScore,
  type GameRank,
} from "../riot.ts";
import { getAllRegistrations, type Division } from "../storage.ts";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Show registered players ranked from highest to lowest.")
  .addStringOption((opt) =>
    opt
      .setName("division")
      .setDescription("Filter to a ranked-race division. Omit for all players.")
      .addChoices(
        { name: "Upper", value: "upper" },
        { name: "Lower", value: "lower" },
      ),
  );

export const REFRESH_ID = "leaderboard:refresh";

interface Entry {
  discordId: string;
  rank: GameRank;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const division = interaction.options.getString("division") as Division | null;
  await interaction.editReply(await buildLeaderboardPayload(division));
}

export async function handleRefresh(interaction: ButtonInteraction) {
  // customId format: "leaderboard:refresh[:division]"
  const parts = interaction.customId.split(":");
  const division = (parts[2] as Division | undefined) ?? null;

  await interaction.deferUpdate();

  const registrations = await getAllRegistrations();
  const scope = division
    ? registrations.filter((r) => r.division === division)
    : registrations;
  for (const r of scope) invalidateRank(r.puuid, "lol");

  await interaction.editReply(await buildLeaderboardPayload(division));
}

async function buildLeaderboardPayload(division: Division | null) {
  const all = await getAllRegistrations();
  const registrations = division ? all.filter((r) => r.division === division) : all;

  const titleSuffix = division
    ? ` — ${division.charAt(0).toUpperCase() + division.slice(1)} Division`
    : "";

  if (registrations.length === 0) {
    return {
      content: division
        ? `No players registered in the **${division}** division yet.`
        : "No players registered yet. Use `/register` to add one.",
      embeds: [],
      components: [],
    };
  }

  const results = await Promise.allSettled(
    registrations.map(async (reg): Promise<Entry> => ({
      discordId: reg.discordId,
      rank: await getRank(reg.puuid, "lol"),
    })),
  );

  const entries: Entry[] = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") entries.push(r.value);
    else failed++;
  }

  entries.sort((a, b) => rankScore(b.rank) - rankScore(a.rank));

  const lines = entries.map((e, i) => {
    return `\`${String(i + 1).padStart(2, " ")}.\` <@${e.discordId}> | ${formatRank(e.rank)}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Solo/Duo Leaderboard${titleSuffix}`)
    .setColor(0x5865f2)
    .setDescription(lines.join("\n") || "No data to show.")
    .setTimestamp(new Date());

  if (failed > 0) {
    embed.setFooter({ text: `${failed} player(s) failed to load.` });
  }

  const customId = division ? `${REFRESH_ID}:${division}` : REFRESH_ID;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄"),
  );

  return { content: "", embeds: [embed], components: [row] };
}
