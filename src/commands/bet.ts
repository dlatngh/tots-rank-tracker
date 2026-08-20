import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import {
  BettingError,
  cancelRound,
  claimRefill,
  CURRENCY_NAME,
  endRound,
  getBalance,
  getLeaderboard,
  getRound,
  lockRound,
  placeBet,
  startRound,
  STARTING_BALANCE,
  TEAM_LABELS,
  type BetTeam,
  type BettingRound,
} from "../utility/betting.ts";
import {
  buildResultEmbed,
  buildRoundEmbed,
  formatPools,
} from "../utility/bet-render.ts";
import {
  getActiveMatch,
  getMatchOutcome,
  NeatQueueError,
} from "../utility/neatqueue.ts";
import { log } from "../utility/log.ts";

const DISPLAYED_STANDINGS_COUNT = 10;

function teamSubcommand(
  sub: SlashCommandSubcommandBuilder,
  team: BetTeam,
): SlashCommandSubcommandBuilder {
  return sub
    .setName(team)
    .setDescription(`Bet on ${TEAM_LABELS[team]}.`)
    .addIntegerOption((amount) =>
      amount
        .setName("amount")
        .setDescription(`How many ${CURRENCY_NAME} to stake.`)
        .setRequired(true)
        .setMinValue(1),
    );
}

export const data = new SlashCommandBuilder()
  .setName("bet")
  .setDescription("Bet on custom games.")
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("Open a betting round on a NeatQueue game.")
      .addIntegerOption((opt) =>
        opt
          .setName("game")
          .setDescription("NeatQueue game number to bet on.")
          .setRequired(true)
          .setMinValue(1),
      ),
  )
  .addSubcommand((sub) => teamSubcommand(sub, "team1"))
  .addSubcommand((sub) => teamSubcommand(sub, "team2"))
  .addSubcommand((sub) =>
    sub
      .setName("lock")
      .setDescription("Stop taking bets, e.g. once the game starts."),
  )
  .addSubcommand((sub) =>
    sub
      .setName("end")
      .setDescription("Settle now from NeatQueue's recorded result."),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Call the round off and refund every bet."),
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Show the current round's pools."),
  )
  .addSubcommand((sub) =>
    sub
      .setName("balance")
      .setDescription(`Check someone's ${CURRENCY_NAME}.`)
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("Whose balance to check. Defaults to yourself."),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("claim").setDescription("Claim your weekly refill."),
  )
  .addSubcommand((sub) =>
    sub.setName("standings").setDescription("Richest bettors."),
  );

function requireGuild(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new BettingError("Betting only works inside a server.");
  }
  return interaction.guildId;
}

async function openRound(
  interaction: ChatInputCommandInteraction,
): Promise<BettingRound> {
  const guildId = requireGuild(interaction);
  const gameNumber = interaction.options.getInteger("game", true);

  const match = await getActiveMatch(guildId, gameNumber);
  if (!match) {
    throw new BettingError(
      `NeatQueue has no live game #${gameNumber} in this server.`,
    );
  }
  if (match.teams.length !== 2) {
    throw new BettingError(
      `Game #${gameNumber} has ${match.teams.length} teams; betting only handles two.`,
    );
  }

  return startRound(interaction.channelId, interaction.user.id, new Date(), {
    guildId,
    gameNumber,
    teamRosters: match.teams,
  });
}

// Rounds settle from NeatQueue's own result, so nobody with money on the game
// decides who gets paid. A game NeatQueue never resolves is refunded with
// `/bet cancel` rather than judged by hand.
async function resolveRound(
  interaction: ChatInputCommandInteraction,
  isServerManager: boolean,
) {
  const guildId = requireGuild(interaction);
  const round = await getRound(interaction.channelId);
  if (!round) {
    throw new BettingError(
      "No betting round is running in this channel. Start one with `/bet start`.",
    );
  }

  const outcome = await getMatchOutcome(guildId, round.gameNumber);

  if (outcome.status === "cancelled") {
    const refunded = await cancelRound(
      interaction.channelId,
      interaction.user.id,
      isServerManager,
    );
    await interaction.editReply(
      `NeatQueue cancelled game #${round.gameNumber}. Refunded ${refunded.totalPool} ${CURRENCY_NAME} across ${refunded.payouts.length} bettor(s).`,
    );
    return;
  }

  if (outcome.status === "pending") {
    throw new BettingError(
      `NeatQueue hasn't recorded a result for game #${round.gameNumber} yet. It settles on its own once they do, or \`/bet cancel\` to refund everyone.`,
    );
  }

  if (outcome.winningTeamIndex > 1) {
    throw new BettingError(
      `NeatQueue says team ${outcome.winningTeamIndex + 1} won game #${round.gameNumber}, which this round has no side for.`,
    );
  }

  const winner: BetTeam = outcome.winningTeamIndex === 0 ? "team1" : "team2";
  const payout = await endRound(
    interaction.channelId,
    interaction.user.id,
    isServerManager,
    winner,
  );

  log(
    "cmd",
    `/bet end game #${round.gameNumber}: ${winner} won, pool ${payout.totalPool}, ` +
      `${payout.payouts.length} bettor(s)${payout.refunded ? ", refunded" : ""}`,
  );

  if (payout.payouts.length === 0) {
    await interaction.editReply(
      `**${TEAM_LABELS[winner]}** wins game #${round.gameNumber}. Nobody bet on this one.`,
    );
    return;
  }

  await interaction.editReply({
    embeds: [buildResultEmbed(round, winner, payout)],
  });
}

async function showStatus(interaction: ChatInputCommandInteraction) {
  const round = await getRound(interaction.channelId);
  if (!round) {
    await interaction.editReply(
      "No betting round is running here. Start one with `/bet start`.",
    );
    return;
  }

  const embed = buildRoundEmbed(
    round,
    `Betting on game #${round.gameNumber}`,
  ).setFooter({ text: `Opened by ${interaction.user.username}` });

  await interaction.editReply({ embeds: [embed] });
}

async function showStandings(interaction: ChatInputCommandInteraction) {
  const standings = await getLeaderboard();
  if (standings.length === 0) {
    await interaction.editReply(
      `Nobody has placed a bet yet. Everyone starts with ${STARTING_BALANCE} ${CURRENCY_NAME}.`,
    );
    return;
  }

  const lines = standings
    .slice(0, DISPLAYED_STANDINGS_COUNT)
    .map(
      (entry, index) =>
        `${index + 1}. <@${entry.discordId}> - ${entry.balance} ${CURRENCY_NAME}`,
    );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Richest bettors")
    .setDescription(lines.join("\n"));

  await interaction.editReply({ embeds: [embed] });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const subcommand = interaction.options.getSubcommand();
  const isServerManager =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;

  try {
    switch (subcommand) {
      case "start": {
        const round = await openRound(interaction);
        const embed = buildRoundEmbed(
          round,
          `Betting on game #${round.gameNumber}`,
        ).setDescription(
          `${formatPools(round)}\n\n` +
            `Place bets with \`/bet team1\` or \`/bet team2\`. ` +
            `<@${interaction.user.id}> can \`/bet lock\` when the game starts; ` +
            `payouts happen on their own once NeatQueue records the winner.`,
        );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      case "team1":
      case "team2": {
        const amount = interaction.options.getInteger("amount", true);
        const team = subcommand as BetTeam;
        const { wager, balance } = await placeBet(
          interaction.channelId,
          interaction.user.id,
          team,
          amount,
        );
        await interaction.editReply(
          `<@${interaction.user.id}> is in for ${wager.amount} ${CURRENCY_NAME} on **${TEAM_LABELS[team]}**. ` +
            `Balance: ${balance} ${CURRENCY_NAME}.`,
        );
        return;
      }

      case "lock": {
        const round = await lockRound(
          interaction.channelId,
          interaction.user.id,
          isServerManager,
        );
        await interaction.editReply(`Betting is locked.\n${formatPools(round)}`);
        return;
      }

      case "end": {
        await resolveRound(interaction, isServerManager);
        return;
      }

      case "cancel": {
        const result = await cancelRound(
          interaction.channelId,
          interaction.user.id,
          isServerManager,
        );
        await interaction.editReply(
          `Round called off. Refunded ${result.totalPool} ${CURRENCY_NAME} across ${result.payouts.length} bettor(s).`,
        );
        return;
      }

      case "status": {
        await showStatus(interaction);
        return;
      }

      case "balance": {
        const user = interaction.options.getUser("user") ?? interaction.user;
        const balance = await getBalance(user.id);
        await interaction.editReply(
          `<@${user.id}> has ${balance} ${CURRENCY_NAME}.`,
        );
        return;
      }

      case "claim": {
        const refill = await claimRefill(interaction.user.id, new Date());
        await interaction.editReply(
          `Claimed ${refill.amount} ${CURRENCY_NAME}. Balance: ${refill.balance} ${CURRENCY_NAME}.`,
        );
        return;
      }

      case "standings": {
        await showStandings(interaction);
        return;
      }
    }
  } catch (err) {
    if (err instanceof BettingError || err instanceof NeatQueueError) {
      await interaction.editReply(err.message);
      return;
    }
    throw err;
  }
}
