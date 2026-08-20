// Shared rendering for betting rounds. Both the /bet command and the
// auto-settler post the same embeds, so the formatting lives outside the
// command module.

import { EmbedBuilder } from "discord.js";
import type { NeatQueuePlayer } from "./neatqueue.ts";
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

function mmrFor(round: BettingRound, team: BetTeam): number | null {
  return round.teamMmr[team === "team1" ? 0 : 1] ?? null;
}

// The standard Elo expectation: a 100-point edge is about 64%. NeatQueue's MMR
// is Elo-shaped, so this reads as the lobby's own sense of who is favoured.
function winChance(mmr: number, opponentMmr: number): number {
  return 1 / (1 + 10 ** ((opponentMmr - mmr) / 400));
}

function formatOdds(round: BettingRound): string | null {
  const teamOneMmr = mmrFor(round, "team1");
  const teamTwoMmr = mmrFor(round, "team2");
  if (teamOneMmr === null || teamTwoMmr === null) return null;

  const teamOneChance = winChance(teamOneMmr, teamTwoMmr);
  const favourite: BetTeam = teamOneChance >= 0.5 ? "team1" : "team2";
  const favouriteChance =
    favourite === "team1" ? teamOneChance : 1 - teamOneChance;

  return (
    `MMR ${Math.round(teamOneMmr)} vs ${Math.round(teamTwoMmr)} · ` +
    `**${TEAM_LABELS[favourite]}** favoured at ${Math.round(favouriteChance * 100)}%`
  );
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

  const odds = formatOdds(round);
  if (odds) lines.push(odds);

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

// The rating swing per player, grouped by side, so the summary shows what the
// game cost or paid everyone who played it.
function formatMmrSwings(
  players: NeatQueuePlayer[],
  teamIndex: number,
): string {
  const lines = players
    .filter((player) => player.teamIndex === teamIndex && player.mmrChange !== null)
    .map((player) => {
      const change = Math.round(player.mmrChange!);
      return `${player.name} ${change >= 0 ? `+${change}` : change}`;
    });
  return lines.join("\n");
}

export function addMatchSummary(
  embed: EmbedBuilder,
  outcome: { players: NeatQueuePlayer[]; mvpId: string | null },
): EmbedBuilder {
  for (const team of ["team1", "team2"] as const) {
    const swings = formatMmrSwings(outcome.players, team === "team1" ? 0 : 1);
    if (swings) {
      embed.addFields({
        name: `${TEAM_LABELS[team]} MMR`,
        value: swings,
        inline: true,
      });
    }
  }

  if (outcome.mvpId) {
    embed.addFields({ name: "MVP", value: `<@${outcome.mvpId}>` });
  }
  return embed;
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
