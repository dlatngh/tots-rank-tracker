import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import type { LanePosition } from "../utility/opgg.ts";
import {
  formatRate,
  getLaneMeta,
  laneLabel,
  LANE_CHOICES,
  tierGrade,
} from "../utility/opgg.ts";
import { log } from "../utility/log.ts";

const LISTED_CHAMPION_COUNT = 10;

export const data = new SlashCommandBuilder()
  .setName("lanemeta")
  .setDescription("Best champions in a lane this patch, by OP.GG tier.")
  .addStringOption((opt) =>
    opt
      .setName("lane")
      .setDescription("Lane to rank.")
      .setRequired(true)
      .addChoices(...LANE_CHOICES),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const lane = interaction.options.getString("lane", true) as LanePosition;
  const entries = await getLaneMeta(lane);

  if (entries.length === 0) {
    await interaction.editReply(`OP.GG has no ${lane} data right now.`);
    return;
  }

  const displayedLane = laneLabel(lane);
  log(
    "cmd",
    `/lanemeta ${lane}: showing ${Math.min(entries.length, LISTED_CHAMPION_COUNT)} of ${entries.length}`,
  );

  const rows = entries.slice(0, LISTED_CHAMPION_COUNT).map((entry) => {
    const rates = `${formatRate(entry.winRate)} win / ${formatRate(entry.pickRate)} pick / ${formatRate(entry.banRate)} ban`;
    return `**${entry.rank}. ${entry.champion}** (${tierGrade(entry.tier)})\n${rates}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${displayedLane} meta - top ${rows.length}`)
    .setDescription(rows.join("\n"))
    .setFooter({ text: "Ranked solo queue - source: OP.GG" });

  await interaction.editReply({ embeds: [embed] });
}
