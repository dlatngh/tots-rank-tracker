// Keeps betting rounds in step with NeatQueue: opens a round when NeatQueue
// creates a game, locks it once the betting window closes, and settles it from
// NeatQueue's recorded winner.
//
// NeatQueue can push those events by webhook, but that needs a publicly
// reachable HTTPS endpoint and this bot only listens locally, so its API is
// polled instead. A poll costs one request per server plus one per open round.

import {
  ChannelType,
  Client,
  TextChannel,
  type Message,
  type NonThreadGuildBasedChannel,
  type PartialMessage,
} from "discord.js";
import {
  autoLockRound,
  getOpenRounds,
  isAutoLockDue,
  refundRound,
  settleRound,
  startRound,
  type BetTeam,
  type BettingRound,
} from "./betting.ts";
import {
  addMatchSummary,
  buildRefundEmbed,
  buildResultEmbed,
  buildRoundEmbed,
  formatPools,
} from "./bet-render.ts";
import {
  getLargestQueueSize,
  getMatchOutcome,
  listActiveMatches,
  listQueueChannels,
  type NeatQueueTeams,
} from "./neatqueue.ts";
import { readQueueCount } from "./neatqueue-message.ts";
import { log, logError } from "./log.ts";

const POLL_INTERVAL_MS = 30_000;
const BETTING_WINDOW_MS = 2 * 60 * 1000;
// NeatQueue deletes a match's channel three hours after cleanup, so a round
// with no recorded outcome by then is never getting one.
const STALE_ROUND_MS = 6 * 60 * 60 * 1000;
const TEAMS_PER_ROUND = 2;

// Watching for games costs a request per poll, so it only runs when a queue is
// nearly full. The gap between the two thresholds keeps a queue hovering around
// the mark from flipping watching on and off every poll.
const WATCH_FROM_QUEUED_PLAYERS = 9;
const WATCH_UNTIL_QUEUED_PLAYERS = 7;

const watchedGuilds = new Set<string>();

async function textChannel(
  client: Client,
  channelId: string,
): Promise<TextChannel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  return channel as TextChannel;
}

async function openRoundFor(
  client: Client,
  guildId: string,
  match: NeatQueueTeams,
  channelId: string,
): Promise<void> {
  if (match.teams.length !== TEAMS_PER_ROUND) return;

  const channel = await textChannel(client, channelId);
  if (!channel) return;

  const now = new Date();
  const round = await startRound(channelId, client.user!.id, now, {
    guildId,
    gameNumber: match.gameNumber,
    teamRosters: match.teams,
    teamMmr: match.teamMmr,
    autoLockAt: new Date(now.getTime() + BETTING_WINDOW_MS),
  });

  const lockTimestamp = Math.floor((now.getTime() + BETTING_WINDOW_MS) / 1000);
  const embed = buildRoundEmbed(
    round,
    `Betting on game #${round.gameNumber}`,
  ).setDescription(
    `${formatPools(round)}\n\n` +
      `Place bets with \`/bet team1\` or \`/bet team2\`. ` +
      `Betting closes <t:${lockTimestamp}:R>.`,
  );

  await channel.send({ embeds: [embed] });
  log("bet", `opened a round on game #${round.gameNumber} in ${channel.name}`);
}

async function openRoundsForNewGames(
  client: Client,
  guildId: string,
  roundsByGame: Map<number, BettingRound>,
): Promise<void> {
  const live = await listActiveMatches(guildId);

  for (const match of live) {
    if (roundsByGame.has(match.gameNumber)) continue;
    if (!match.channelId) {
      logError(
        "bet",
        `game #${match.gameNumber} is live but its payload names no channel to post in`,
      );
      continue;
    }
    await openRoundFor(client, guildId, match, match.channelId);
  }
}

// NeatQueue makes a channel per game, named with the game number (its default
// format is `queue-$`). The channel appearing is the earliest sign a game
// started, and it tells us where to post without having to trust the API
// payload to name a channel.
function gameNumberFromChannelName(name: string): number | null {
  const trailingDigits = name.match(/(\d+)$/);
  return trailingDigits ? Number(trailingDigits[1]) : null;
}

export async function handleChannelCreate(
  client: Client,
  channel: NonThreadGuildBasedChannel,
): Promise<void> {
  if (channel.type !== ChannelType.GuildText) return;

  const gameNumber = gameNumberFromChannelName(channel.name);
  if (gameNumber === null) return;

  const guildId = channel.guildId;
  const alreadyRunning = (await getOpenRounds()).some(
    (round) => round.guildId === guildId && round.gameNumber === gameNumber,
  );
  if (alreadyRunning) return;

  // Any channel ending in digits reaches this point; NeatQueue not knowing the
  // number is what tells us it was not a match channel.
  const match = (await listActiveMatches(guildId)).find(
    (candidate) => candidate.gameNumber === gameNumber,
  );
  if (!match) return;

  watchedGuilds.add(guildId);
  await openRoundFor(client, guildId, match, channel.id);
}

async function lockIfWindowClosed(
  client: Client,
  round: BettingRound,
  now: Date,
): Promise<void> {
  if (!isAutoLockDue(round, now)) return;

  const locked = await autoLockRound(round.channelId);
  if (!locked) return;

  log("bet", `locked betting on game #${locked.gameNumber}`);
  const channel = await textChannel(client, locked.channelId);
  await channel?.send(`Betting is locked.\n${formatPools(locked)}`);
}

async function refundFor(
  client: Client,
  round: BettingRound,
  reason: string,
): Promise<void> {
  const refunded = await refundRound(round.channelId);
  if (!refunded) return;

  log(
    "bet",
    `refunded game #${round.gameNumber}: ${reason}, ${refunded.totalPool} returned`,
  );

  const channel = await textChannel(client, round.channelId);
  await channel?.send({ embeds: [buildRefundEmbed(round, refunded, reason)] });
}

async function resolveRound(
  client: Client,
  round: BettingRound,
  now: Date,
): Promise<void> {
  const outcome = await getMatchOutcome(round.guildId, round.gameNumber);

  if (outcome.status === "cancelled") {
    await refundFor(client, round, "NeatQueue cancelled the game");
    return;
  }

  if (outcome.status === "pending") {
    // A game that never reaches NeatQueue's history would otherwise hold the
    // wagers forever, so a round eventually gives up and hands the tots back.
    const age = now.getTime() - Date.parse(round.startedAt);
    if (age > STALE_ROUND_MS) {
      await refundFor(client, round, "the game never finished");
    }
    return;
  }

  if (outcome.winningTeamIndex >= TEAMS_PER_ROUND) {
    logError(
      "bet",
      `game #${round.gameNumber} was won by team ${outcome.winningTeamIndex + 1}, which the round has no side for`,
    );
    return;
  }

  const winner: BetTeam = outcome.winningTeamIndex === 0 ? "team1" : "team2";
  const settled = await settleRound(round.channelId, winner);
  if (!settled) return;

  log(
    "bet",
    `settled game #${round.gameNumber}: ${winner} won, pool ${settled.totalPool}`,
  );

  const summary = addMatchSummary(
    buildResultEmbed(round, winner, settled),
    outcome,
  );
  const channel = await textChannel(client, round.channelId);
  await channel?.send({ embeds: [summary] });
}

// Watching starts when a queue is one player from popping and continues until
// the queue has emptied out again and every round it produced has been paid.
function applyWatchThresholds(
  guildId: string,
  queued: number,
  hasOpenRounds: boolean,
): boolean {
  const watching = watchedGuilds.has(guildId);

  // A round outlives the queue that produced it, and it still needs settling,
  // so an open round keeps the guild watched however empty the queue is. This
  // is also what resumes watching after a restart.
  if (hasOpenRounds) {
    watchedGuilds.add(guildId);
    return true;
  }

  if (!watching && queued >= WATCH_FROM_QUEUED_PLAYERS) {
    watchedGuilds.add(guildId);
    log("bet", `queue is at ${queued}; watching for games`);
    return true;
  }

  if (watching && queued < WATCH_UNTIL_QUEUED_PLAYERS && !hasOpenRounds) {
    watchedGuilds.delete(guildId);
    log("bet", `queue is down to ${queued}; no longer watching for games`);
    return false;
  }

  return watching;
}

async function updateWatchState(
  guildId: string,
  hasOpenRounds: boolean,
): Promise<boolean> {
  const queued = await getLargestQueueSize(guildId);
  return applyWatchThresholds(guildId, queued, hasOpenRounds);
}

async function syncGuild(client: Client, guildId: string): Promise<void> {
  const rounds = (await getOpenRounds()).filter(
    (round) => round.guildId === guildId,
  );

  const watching = await updateWatchState(guildId, rounds.length > 0);
  if (!watching) return;

  const roundsByGame = new Map(
    rounds.map((round) => [round.gameNumber, round] as const),
  );
  await openRoundsForNewGames(client, guildId, roundsByGame);

  const now = new Date();
  for (const round of rounds) {
    await lockIfWindowClosed(client, round, now);
    await resolveRound(client, round, now);
  }
}

async function pollOnce(client: Client): Promise<void> {
  for (const guildId of client.guilds.cache.keys()) {
    try {
      await syncGuild(client, guildId);
    } catch (err) {
      logError("bet", `NeatQueue sync for guild ${guildId} failed:`, err);
    }
  }
}

// Which channels NeatQueue runs queues in, so only their messages get read.
// Refreshed occasionally: a server rarely adds a queue channel mid-session.
const QUEUE_CHANNEL_TTL_MS = 10 * 60 * 1000;
const queueChannelsByGuild = new Map<
  string,
  { channelIds: Set<string>; expiresAt: number }
>();

async function isQueueChannel(
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const cached = queueChannelsByGuild.get(guildId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.channelIds.has(channelId);
  }

  const channelIds = new Set(await listQueueChannels(guildId));
  queueChannelsByGuild.set(guildId, {
    channelIds,
    expiresAt: Date.now() + QUEUE_CHANNEL_TTL_MS,
  });
  return channelIds.has(channelId);
}

// NeatQueue edits its queue message on every join and leave, so this fires well
// before the API would show a match. It only moves the watch state; the poll
// loop still does the work of opening and settling rounds.
export async function handleQueueMessage(
  message: Message | PartialMessage,
): Promise<void> {
  const guildId = message.guildId;
  if (!guildId) return;
  // Chatter in the queue channel is skipped without a refetch. A partial has no
  // author to check, so it falls through to the fetch below.
  if (message.author && !message.author.bot) return;
  if (!(await isQueueChannel(guildId, message.channelId))) return;

  const count = await readQueueCount(message);
  if (!count) return;

  const rounds = (await getOpenRounds()).filter(
    (round) => round.guildId === guildId,
  );
  applyWatchThresholds(guildId, count.queued, rounds.length > 0);
}

export function startBetSync(client: Client): void {
  // Everything here needs the bot to be a guild member: it reads the guilds it
  // is in and posts into their channels. An application invited with only the
  // applications.commands scope can answer slash commands but is in no guild,
  // which would make this loop silently do nothing.
  if (client.guilds.cache.size === 0) {
    logError(
      "bet",
      "bot is not in any server, so rounds cannot open or settle on their own; re-invite it with the bot scope",
    );
    return;
  }

  setInterval(() => {
    pollOnce(client).catch((err) => logError("bet", "sync poll failed:", err));
  }, POLL_INTERVAL_MS);
  log("bet", `NeatQueue sync polling every ${POLL_INTERVAL_MS / 1000}s`);
}
