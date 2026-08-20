// Shared rendering for betting rounds. Both the /bet command and the
// auto-settler post the same embeds, so the formatting lives outside the
// command module.

import { EmbedBuilder } from "discord.js";
import {
  CURRENCY_NAME,
  poolFor,
  TEAM_LABELS,
  type BetTeam,
  type BettingRound,
  type RoundResult,
} from "./betting.ts";

const EMBED_COLOR = 0x5865f2;

// NeatQueue lists its teams in the order we map onto team1/team2, so the two
// sides read the same in both bots.
export function rosterFor(round: BettingRound, team: BetTeam): string | null {
  const roster = round.teamRosters[team === "team1" ? 0 : 1];
  return roster?.length ? roster.join(", ") : null;
}

export function formatPools(round: BettingRound): string {
  const lines: string[] = [];
  for (const team of ["team1", "team2"] as const) {
    const roster = rosterFor(round, team);
    lines.push(
      `**${TEAM_LABELS[team]}** ${poolFor(round, team)} ${CURRENCY_NAME}` +
        (roster ? `\n${roster}` : ""),
    );
  }

  const bettorCount = Object.keys(round.wagers).length;
  lines.push(
    `${bettorCount} bettor(s) · ${round.locked ? "betting locked" : "betting open"} · game #${round.gameNumber}`,
  );
  return lines.join("\n");
}

// Winners first and biggest first, so the interesting lines are at the top of
// the payout list.
function payoutLines(result: RoundResult): string {
  const ranked = [...result.payouts].sort(
    (a, b) => b.returned - a.returned || b.stake - a.stake,
  );
  return ranked
    .map((payout) => {
      const net = payout.returned - payout.stake;
      const outcome =
        net > 0 ? `+${net}` : net < 0 ? `${net}` : "refunded, no change";
      return `<@${payout.discordId}> staked ${payout.stake} · **${outcome}**`;
    })
    .join("\n");
}

export function buildResultEmbed(
  round: BettingRound,
  winner: BetTeam,
  result: RoundResult,
): EmbedBuilder {
  const description = [
    rosterFor(round, winner),
    result.refunded
      ? `Only one side had money on it, so every bet was refunded. Pool was ${result.totalPool} ${CURRENCY_NAME}.`
      : `Pool of ${result.totalPool} ${CURRENCY_NAME} paid out.`,
  ]
    .filter(Boolean)
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${TEAM_LABELS[winner]} wins game #${round.gameNumber}`)
    .setDescription(description);

  if (result.payouts.length > 0) {
    embed.addFields({ name: "Results", value: payoutLines(result) });
  }
  return embed;
}

export function buildRefundEmbed(
  round: BettingRound,
  result: RoundResult,
  reason: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`Game #${round.gameNumber} is off`)
    .setDescription(
      `${reason}, so every bet was refunded. ${result.totalPool} ${CURRENCY_NAME} returned to ${result.payouts.length} bettor(s).`,
    );
  return embed;
}

export function buildRoundEmbed(round: BettingRound, title: string) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(title)
    .setDescription(formatPools(round));
}
