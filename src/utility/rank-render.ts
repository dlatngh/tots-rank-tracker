// Shared embed/payload builder for the per-game rank commands (/lol, /val).

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  type User,
} from "discord.js";
import {
  formatRank,
  getMatchHistory,
  getRank,
  invalidateRank,
  peekRank,
  profileUrl,
  rankScore,
  RiotApiError,
  tierColor,
  type Game,
  type MatchSummary,
} from "./riot.ts";
import { getAllRegistrations, getRegistration, updateRiotId } from "./storage.ts";
import { getSoloLpDelta, type LpDelta } from "./rank-history.ts";

const GAME_LABELS: Record<Game, string> = {
  lol: "Solo/Duo",
  val: "Valorant",
};

function formatLpDelta(delta: LpDelta): string {
  const timeframe = delta.since === "today" ? "today" : "recently";
  if (delta.amount > 0) return `📈 +${delta.amount} LP ${timeframe}`;
  if (delta.amount < 0) return `📉 ${delta.amount} LP ${timeframe}`;
  return `➖ 0 LP ${timeframe}`;
}

function formatMatchLine(match: MatchSummary): string {
  const outcome = match.win ? "✅" : "❌";
  const kda = `${match.kills}/${match.deaths}/${match.assists}`;
  const durationMinutes = Math.round(match.durationSec / 60);
  const endedTimestamp = Math.floor(match.endedAt / 1000);
  return `${outcome} **${match.championName}** ${kda} · ${durationMinutes}m · <t:${endedTimestamp}:R>`;
}

export async function buildRankPayload(user: User, game: Game) {
  const discordId = user.id;
  const registration = await getRegistration(discordId);
  if (!registration) {
    return {
      content: `<@${discordId}> has no Riot ID registered. Use \`/register\` first.`,
      embeds: [],
      components: [],
    };
  }

  // Kick off match history alongside the rank fetch so the extra match-v5
  // calls overlap with the rank lookup instead of adding latency in series.
  const matchHistoryPromise =
    game === "lol"
      ? getMatchHistory(registration.puuid).catch(() => [] as MatchSummary[])
      : Promise.resolve([] as MatchSummary[]);

  let rank;
  try {
    rank = await getRank(registration.puuid, game, {
      gameName: registration.gameName,
      tagLine: registration.tagLine,
    });
    // Self-heal: if the player renamed, persist the fresh name/tag.
    if (
      rank.gameName !== registration.gameName ||
      rank.tagLine !== registration.tagLine
    ) {
      void updateRiotId(discordId, rank.gameName, rank.tagLine);
    }
  } catch (err) {
    const msg =
      err instanceof RiotApiError && err.status === 404
        ? "Account or rank data not found."
        : `Failed to fetch rank: ${err instanceof Error ? err.message : String(err)}`;
    return { content: msg, embeds: [], components: [] };
  }

  const riotId = `${rank.gameName}#${rank.tagLine}`;
  const games = rank.wins + rank.losses;
  const winRate = games > 0 ? Math.round((rank.wins / games) * 100) : 0;
  const refreshedTs = Math.floor(rank.fetchedAt / 1000);

  // Placement only meaningful for LoL (the active rank race).
  let footer: string;
  if (game === "lol") {
    const allRegs = await getAllRegistrations();
    const others = allRegs.filter((r) => r.discordId !== discordId);
    const otherCached = await Promise.all(
      others.map((r) => peekRank(r.puuid, "lol")),
    );
    const knownOthers = otherCached.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );
    const myScore = rankScore(rank);
    const ahead = knownOthers.filter((r) => rankScore(r) > myScore).length;
    const placement = ahead + 1;
    const total = 1 + knownOthers.length;
    const complete = knownOthers.length === others.length;
    const lvl = rank.summonerLevel
      ? `Summoner Level ${rank.summonerLevel} • `
      : "";
    footer = complete
      ? `${lvl}#${placement} of ${total} on leaderboard`
      : total > 1
        ? `${lvl}#${placement} of ${total} cached (run /leaderboard for full)`
        : `${lvl}run /leaderboard for placement`;
  } else {
    footer = rank.currentAct
      ? `Valorant • Act ${rank.currentAct.toUpperCase()}`
      : "Valorant";
  }

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${user.displayName} | ${riotId}`,
      iconURL: rank.profileIconUrl ?? undefined,
      url: profileUrl(rank),
    })
    .setDescription(`Last refreshed <t:${refreshedTs}:R>`)
    .setFooter({ text: footer });

  const lpDelta =
    game === "lol" ? await getSoloLpDelta(registration.puuid, rank) : null;

  if (rank.tier) {
    embed.setColor(tierColor(rank.tier)).setTitle(formatRank(rank));
    if (rank.rankIconUrl) embed.setThumbnail(rank.rankIconUrl);
    embed.addFields(
      { name: "Wins", value: String(rank.wins), inline: true },
      { name: "Losses", value: String(rank.losses), inline: true },
      { name: "Win Rate", value: `${winRate}%`, inline: true },
    );
    if (lpDelta) {
      embed.addFields({ name: "LP Change", value: formatLpDelta(lpDelta), inline: true });
    }
  } else {
    embed.setColor(0x5865f2).setTitle(`Unranked in ${GAME_LABELS[game]}`);
  }

  const matches = await matchHistoryPromise;
  if (matches.length > 0) {
    embed.addFields({
      name: "Recent Ranked Games",
      value: matches.map(formatMatchLine).join("\n"),
    });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${game}:refresh:${discordId}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄"),
  );

  return { content: "", embeds: [embed], components: [row] };
}

/** Shared refresh handler for /lol and /val buttons. */
export async function handleRankRefresh(
  interaction: ButtonInteraction,
  game: Game,
) {
  // customId format: "<game>:refresh:<discordId>"
  const discordId = interaction.customId.split(":")[2];
  if (!discordId) {
    await interaction.reply({
      content: "Invalid refresh button.",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferUpdate();

  const reg = await getRegistration(discordId);
  if (reg) invalidateRank(reg.puuid, game);

  const user = await interaction.client.users.fetch(discordId);
  await interaction.editReply(await buildRankPayload(user, game));
}
