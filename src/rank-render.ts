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
  getRank,
  invalidateRank,
  peekRank,
  profileUrl,
  rankScore,
  RiotApiError,
  tierColor,
  type Game,
} from "./riot.ts";
import { getAllRegistrations, getRegistration } from "./storage.ts";

const GAME_LABELS: Record<Game, string> = {
  lol: "Solo/Duo",
  val: "Valorant",
};

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

  let rank;
  try {
    rank = await getRank(registration.puuid, game);
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

  if (rank.tier) {
    embed.setColor(tierColor(rank.tier)).setTitle(formatRank(rank));
    if (rank.rankIconUrl) embed.setThumbnail(rank.rankIconUrl);
    embed.addFields(
      { name: "Wins", value: String(rank.wins), inline: true },
      { name: "Losses", value: String(rank.losses), inline: true },
      { name: "Win Rate", value: `${winRate}%`, inline: true },
    );
  } else {
    embed.setColor(0x5865f2).setTitle(`Unranked in ${GAME_LABELS[game]}`);
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
