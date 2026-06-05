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
  getSoloDuoRank,
  invalidateRankCache,
  rankScore,
  type SoloDuoRank,
} from "../riot.ts";
import { getAllRegistrations } from "../storage.ts";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Show registered players ranked from highest to lowest.");

export const REFRESH_ID = "leaderboard:refresh";

interface Entry {
  discordId: string;
  rank: SoloDuoRank;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  await interaction.editReply(await buildLeaderboardPayload());
}

export async function handleRefresh(interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  // Evict every registered player so we get live data.
  const registrations = await getAllRegistrations();
  for (const r of registrations) invalidateRankCache(r.puuid);

  await interaction.editReply(await buildLeaderboardPayload());
}

async function buildLeaderboardPayload() {
  const registrations = await getAllRegistrations();
  if (registrations.length === 0) {
    return {
      content: "No players registered yet. Use `/register` to add one.",
      embeds: [],
      components: [],
    };
  }

  const results = await Promise.allSettled(
    registrations.map(async (reg): Promise<Entry> => ({
      discordId: reg.discordId,
      rank: await getSoloDuoRank(reg.puuid),
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
    const r = e.rank;
    const rankText = r.tier
      ? `${r.tier} ${r.division} ${r.leaguePoints} LP`
      : "Unranked";
    return `\`${String(i + 1).padStart(2, " ")}.\` <@${e.discordId}> | ${rankText}`;
  });

  const embed = new EmbedBuilder()
    .setTitle("Solo/Duo Leaderboard")
    .setColor(0x5865f2)
    .setDescription(lines.join("\n") || "No data to show.")
    .setTimestamp(new Date());

  if (failed > 0) {
    embed.setFooter({ text: `${failed} player(s) failed to load.` });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(REFRESH_ID)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄"),
  );

  return { content: "", embeds: [embed], components: [row] };
}
