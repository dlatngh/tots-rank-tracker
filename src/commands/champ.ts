import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import {
  championIconUrl,
  getChampions,
  normalizeChampionName,
} from "../utility/riot.ts";
import type {
  ChampionRates,
  CounterMatchup,
  LanePosition,
} from "../utility/opgg.ts";
import {
  formatRate,
  getChampionMetaStats,
  laneLabel,
  LANE_CHOICES,
  tierGrade,
} from "../utility/opgg.ts";
import { log } from "../utility/log.ts";

export const data = new SlashCommandBuilder()
  .setName("champ")
  .setDescription("Win, pick, and ban rates for a champion this patch.")
  .addStringOption((opt) =>
    opt
      .setName("champion")
      .setDescription("Champion to look up.")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("lane")
      .setDescription(
        "Lane to show matchups for. Defaults to the champion's main lane.",
      )
      .addChoices(...LANE_CHOICES),
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const champions = await getChampions();
  const query = normalizeChampionName(interaction.options.getFocused());
  const matches = champions
    .filter((c) => normalizeChampionName(c.name).includes(query))
    .slice(0, 25)
    .map((c) => ({ name: c.name, value: c.id }));
  await interaction.respond(matches);
}

function formatRates(rates: ChampionRates): string {
  const games = rates.games.toLocaleString("en-US");
  return (
    `Win **${formatRate(rates.winRate)}** · Pick **${formatRate(rates.pickRate)}** · Ban **${formatRate(rates.banRate)}**\n` +
    `Tier **${tierGrade(rates.tier)}** (#${rates.rank}) · KDA **${rates.kda.toFixed(2)}** · ${games} games`
  );
}

// Win rates here are the looked-up champion's, in that specific matchup.
function formatMatchups(matchups: CounterMatchup[]): string {
  return matchups
    .map(
      (matchup) =>
        `${matchup.championName} - ${formatRate(matchup.championWinRate)} win`,
    )
    .join("\n");
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const input = interaction.options.getString("champion", true);
  const champions = await getChampions();
  const champion =
    champions.find((c) => c.id === input) ??
    champions.find(
      (c) => normalizeChampionName(c.name) === normalizeChampionName(input),
    );

  if (!champion) {
    await interaction.editReply(`I don't know a champion called **${input}**.`);
    return;
  }

  const lane = interaction.options.getString("lane") as LanePosition | null;
  const stats = await getChampionMetaStats(champion.name, lane ?? undefined);
  if (!stats) {
    await interaction.editReply(
      `OP.GG has no stats for **${champion.name}** right now.`,
    );
    return;
  }

  const displayedLane = stats.selectedLane
    ? laneLabel(stats.selectedLane.lane)
    : lane
      ? laneLabel(lane)
      : "All lanes";

  log(
    "cmd",
    `/champ ${champion.name}: lane ${lane ?? "auto"} -> ${displayedLane}, ` +
      `${stats.lanes.length} lane(s) with data, ` +
      `${stats.strongAgainst.length + stats.weakAgainst.length} matchup(s)`,
  );

  // Headline numbers describe the selected lane; fall back to the champion-wide
  // aggregate when that lane has too few games to break out.
  const headline = stats.selectedLane ?? stats.overall;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${champion.name} - ${displayedLane} - Patch ${stats.patch}`)
    .setThumbnail(await championIconUrl(champion.id))
    .addFields(
      { name: "Win rate", value: formatRate(headline.winRate), inline: true },
      { name: "Pick rate", value: formatRate(headline.pickRate), inline: true },
      { name: "Ban rate", value: formatRate(headline.banRate), inline: true },
      { name: "KDA", value: headline.kda.toFixed(2), inline: true },
      { name: "Tier", value: tierGrade(headline.tier), inline: true },
      { name: "Rank", value: `#${headline.rank}`, inline: true },
      {
        name: "Games",
        value: headline.games.toLocaleString("en-US"),
        inline: true,
      },
    )
    .setFooter({ text: "Ranked solo queue - source: OP.GG" });

  if (stats.selectedLane) {
    embed.addFields({
      name: "All lanes",
      value: formatRates(stats.overall),
      inline: false,
    });
  } else if (lane) {
    embed.addFields({
      name: displayedLane,
      value: `Not enough ${displayedLane} games to break out; showing all lanes.`,
      inline: false,
    });
  }

  if (stats.strongAgainst.length > 0) {
    embed.addFields({
      name: "Strong against",
      value: formatMatchups(stats.strongAgainst),
    });
  }
  if (stats.weakAgainst.length > 0) {
    embed.addFields({
      name: "Weak against",
      value: formatMatchups(stats.weakAgainst),
    });
  }
  if (stats.strongAgainst.length === 0 && stats.weakAgainst.length === 0) {
    embed.addFields({
      name: "Matchups",
      value: `Not enough ${displayedLane} games for matchup data.`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
