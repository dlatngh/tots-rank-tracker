import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  type User,
} from "discord.js";
import {
  getSoloDuoRank,
  invalidateRankCache,
  rankScore,
  RiotApiError,
  TIER_COLORS,
} from "../riot.ts";
import { getAllRegistrations, getRegistration } from "../storage.ts";

export const data = new SlashCommandBuilder()
  .setName("rank")
  .setDescription("Show a registered user's solo/duo rank.")
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("The Discord user to look up. Defaults to yourself."),
  );

export const REFRESH_ID = "rank:refresh";

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const user = interaction.options.getUser("user") ?? interaction.user;
  const payload = await buildRankPayload(user);
  await interaction.editReply(payload);
}

export async function handleRefresh(interaction: ButtonInteraction) {
  // customId format: "rank:refresh:<discordId>"
  const discordId = interaction.customId.split(":")[2];
  if (!discordId) {
    await interaction.reply({ content: "Invalid refresh button.", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();

  // Evict cached entries so we get live data on this re-render.
  const reg = await getRegistration(discordId);
  if (reg) invalidateRankCache(reg.puuid);

  const user = await interaction.client.users.fetch(discordId);
  const payload = await buildRankPayload(user);
  await interaction.editReply(payload);
}

async function buildRankPayload(user: User) {
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
    rank = await getSoloDuoRank(registration.puuid);
  } catch (err) {
    const msg =
      err instanceof RiotApiError && err.status === 404
        ? "The registered Riot account no longer exists."
        : `Failed to fetch rank: ${err instanceof Error ? err.message : String(err)}`;
    return { content: msg, embeds: [], components: [] };
  }

  const riotId = `${rank.gameName}#${rank.tagLine}`;
  const games = rank.wins + rank.losses;
  const winRate = games > 0 ? Math.round((rank.wins / games) * 100) : 0;

  const allRegs = await getAllRegistrations();
  const others = allRegs.filter((r) => r.discordId !== discordId);
  const otherScores = await Promise.allSettled(
    others.map((r) => getSoloDuoRank(r.puuid)),
  );
  const myScore = rankScore(rank);
  const ahead = otherScores.filter(
    (s) => s.status === "fulfilled" && rankScore(s.value) > myScore,
  ).length;
  const placement = ahead + 1;
  const total = 1 + otherScores.filter((s) => s.status === "fulfilled").length;

  const refreshedTs = Math.floor(rank.fetchedAt / 1000);

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${user.displayName} — ${riotId}`,
      iconURL: rank.profileIconUrl,
    })
    .setDescription(`Last refreshed <t:${refreshedTs}:R>`)
    .setFooter({
      text: `Summoner Level ${rank.summonerLevel} • #${placement} of ${total} on leaderboard`,
    });

  if (rank.tier) {
    embed
      .setColor(TIER_COLORS[rank.tier] ?? 0x5865f2)
      .setTitle(`${rank.tier} ${rank.division} ${rank.leaguePoints} LP`)
      .addFields(
        { name: "Wins", value: String(rank.wins), inline: true },
        { name: "Losses", value: String(rank.losses), inline: true },
        { name: "Win Rate", value: `${winRate}%`, inline: true },
      );
  } else {
    embed.setColor(0x5865f2).setTitle("Unranked in Solo/Duo");
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REFRESH_ID}:${discordId}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄"),
  );

  return { content: "", embeds: [embed], components: [row] };
}
