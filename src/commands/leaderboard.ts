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
  type Game,
  type GameRank,
} from "../utility/riot.ts";
import { getAllRegistrations, updateRiotId, type Division } from "../utility/storage.ts";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Show registered players ranked from highest to lowest.")
  .addSubcommand((sc) =>
    sc
      .setName("lol")
      .setDescription("League of Legends solo/duo leaderboard.")
      .addStringOption((opt) =>
        opt
          .setName("division")
          .setDescription("Filter to a ranked-race division. Omit for all.")
          .addChoices(
            { name: "Upper", value: "upper" },
            { name: "Lower", value: "lower" },
          ),
      ),
  )
  .addSubcommand((sc) =>
    sc.setName("val").setDescription("Valorant current-act leaderboard."),
  );

export const REFRESH_ID = "leaderboard:refresh";

interface Entry {
  discordId: string;
  rank: GameRank;
}

const GAME_LABELS: Record<Game, string> = {
  lol: "Solo/Duo",
  val: "Valorant",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const game = interaction.options.getSubcommand() as Game;
  const division =
    game === "lol"
      ? (interaction.options.getString("division") as Division | null)
      : null;
  await interaction.editReply(await buildLeaderboardPayload(game, division));
}

export async function handleRefresh(interaction: ButtonInteraction) {
  // customId format: "leaderboard:refresh:<game>[:<division>]"
  const parts = interaction.customId.split(":");
  const game = (parts[2] as Game | undefined) ?? "lol";
  const division = (parts[3] as Division | undefined) ?? null;

  await interaction.deferUpdate();

  const registrations = await getAllRegistrations();
  const scope = division
    ? registrations.filter((r) => r.division === division)
    : registrations;
  for (const r of scope) invalidateRank(r.puuid, game);

  await interaction.editReply(await buildLeaderboardPayload(game, division));
}

async function buildLeaderboardPayload(game: Game, division: Division | null) {
  const all = await getAllRegistrations();
  const registrations = division ? all.filter((r) => r.division === division) : all;

  const divisionSuffix = division
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
    registrations.map(async (reg): Promise<Entry> => {
      const rank = await getRank(reg.puuid, game, {
        gameName: reg.gameName,
        tagLine: reg.tagLine,
      });
      if (rank.gameName !== reg.gameName || rank.tagLine !== reg.tagLine) {
        void updateRiotId(reg.discordId, rank.gameName, rank.tagLine);
      }
      return { discordId: reg.discordId, rank };
    }),
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
    .setTitle(`${GAME_LABELS[game]} Leaderboard${divisionSuffix}`)
    .setColor(0x5865f2)
    .setDescription(lines.join("\n") || "No data to show.")
    .setTimestamp(new Date());

  if (failed > 0) {
    embed.setFooter({ text: `${failed} player(s) failed to load.` });
  }

  const customId = division
    ? `${REFRESH_ID}:${game}:${division}`
    : `${REFRESH_ID}:${game}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄"),
  );

  return { content: "", embeds: [embed], components: [row] };
}
