// Read-only client for NeatQueue, the queue bot that runs the server's custom
// games. Betting uses it for two things: the rosters of a live game, and the
// winner once NeatQueue has recorded it, so a round can be settled from the
// queue bot's own result instead of someone's say-so.
//
// The API is polled outbound rather than pushed to us: NeatQueue can deliver
// events by webhook, but that needs a publicly reachable HTTPS endpoint and
// this bot only listens locally.

import { config } from "./config.ts";
import { log, logError } from "./log.ts";

const API_BASE = "https://api.neatqueue.com/api";

export class NeatQueueError extends Error {}

export interface NeatQueueTeams {
  gameNumber: number;
  // Player display names, one array per team, in NeatQueue's team order.
  teams: string[][];
  // The channel NeatQueue made for the game, when its payload names one.
  channelId: string | null;
}

async function get(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.neatQueueApiToken) {
    headers.Authorization = `Bearer ${config.neatQueueApiToken}`;
  }

  const response = await fetch(`${API_BASE}${path}`, { headers });
  if (response.status === 404) {
    throw new NeatQueueError("NeatQueue doesn't know this server.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new NeatQueueError(
      "NeatQueue rejected the API token. Regenerate it with `/webhooks generatetoken` and set NEATQUEUE_API_TOKEN.",
    );
  }
  if (!response.ok) {
    logError("neatqueue", `GET ${path} failed with ${response.status}`);
    throw new NeatQueueError(
      `NeatQueue's API returned ${response.status}. Try again in a moment.`,
    );
  }
  return response.json();
}

// NeatQueue's payloads are not covered by its OpenAPI schema. History entries
// are confirmed to use `game_num`; the live-match payload is read tolerantly
// because its shape has not been seen with a game in progress.
const GAME_NUMBER_KEYS = ["game_num", "game_number", "id"];

function gameNumberOf(match: Record<string, any>): number | null {
  for (const key of GAME_NUMBER_KEYS) {
    const value = match[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function playerNames(team: unknown): string[] {
  if (!Array.isArray(team)) return [];
  return team.map((player: any) =>
    typeof player === "string" ? player : (player?.name ?? String(player?.id)),
  );
}

// History entries carry the match channel as `channel`; the live payload has
// not been seen, so accept the obvious alternatives too.
const CHANNEL_KEYS = ["channel", "channel_id", "match_channel"];

function channelIdOf(match: Record<string, any>): string | null {
  for (const key of CHANNEL_KEYS) {
    const value = match[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function teamRosters(match: Record<string, any>): string[][] {
  if (!Array.isArray(match.teams)) return [];
  return match.teams.map(playerNames);
}

// The active-matches endpoint answers with an object keyed by game number
// rather than a list.
export async function listActiveMatches(
  serverId: string,
): Promise<NeatQueueTeams[]> {
  const payload = (await get(`/v1/matches/${serverId}`)) as Record<string, any>;
  const matches = Array.isArray(payload) ? payload : Object.values(payload);

  const live: NeatQueueTeams[] = [];
  for (const match of matches as Array<Record<string, any>>) {
    const gameNumber = gameNumberOf(match);
    if (gameNumber === null) continue;
    live.push({
      gameNumber,
      teams: teamRosters(match),
      channelId: channelIdOf(match),
    });
  }
  return live;
}

export async function getActiveMatch(
  serverId: string,
  gameNumber: number,
): Promise<NeatQueueTeams | null> {
  const match = (await listActiveMatches(serverId)).find(
    (candidate) => candidate.gameNumber === gameNumber,
  );
  if (!match) return null;

  log(
    "neatqueue",
    `game ${gameNumber} is live with ${match.teams.length} team(s) of ${match.teams[0]?.length ?? 0}`,
  );
  return match;
}

// Players sitting in each of the server's queue channels. Cheap enough to poll
// often, which is what tells the bot a game is about to start.
export async function getLargestQueueSize(serverId: string): Promise<number> {
  const payload = (await get(`/v1/queues/${serverId}/players`)) as Record<
    string,
    unknown[]
  >;

  let largest = 0;
  for (const players of Object.values(payload)) {
    if (Array.isArray(players)) largest = Math.max(largest, players.length);
  }
  return largest;
}

// The server's queue channels, as [channel id, queue name] pairs. Used to tell
// which messages are worth reading for a queue count.
export async function listQueueChannels(serverId: string): Promise<string[]> {
  const payload = (await get(`/v1/queuechannels/${serverId}`)) as Array<
    [string, string]
  >;
  return payload.map(([channelId]) => channelId);
}

// A game is either still going, cancelled, or won by one of the teams.
export type NeatQueueOutcome =
  | { status: "pending" }
  | { status: "cancelled" }
  | {
      status: "finished";
      // Index into the match's teams array, matching NeatQueue's numbering.
      winningTeamIndex: number;
      teams: string[][];
    };

// `winner` is a 0-based index into `teams` once a game is decided. A cancelled
// match keeps its teams and start time but reports -1; a queue that died before
// teams were made has no time or teams at all and reports null. Neither will
// ever produce a winner, so both refund.
function outcomeOf(match: Record<string, any>): NeatQueueOutcome {
  const winner = match.winner;
  if (typeof winner === "number" && winner >= 0) {
    return {
      status: "finished",
      winningTeamIndex: winner,
      teams: teamRosters(match),
    };
  }
  return { status: "cancelled" };
}

export async function getMatchOutcome(
  serverId: string,
  gameNumber: number,
): Promise<NeatQueueOutcome> {
  const query = new URLSearchParams({
    start_game_number: String(gameNumber),
    end_game_number: String(gameNumber),
    limit: "5",
  });
  const payload = (await get(`/v1/history/${serverId}?${query}`)) as {
    data?: Array<Record<string, any>>;
  };

  const match = (payload.data ?? []).find(
    (candidate) => gameNumberOf(candidate) === gameNumber,
  );
  // A game still in progress has no history entry yet.
  if (!match) return { status: "pending" };

  const outcome = outcomeOf(match);
  log(
    "neatqueue",
    outcome.status === "finished"
      ? `game ${gameNumber} was won by team index ${outcome.winningTeamIndex}`
      : `game ${gameNumber} was cancelled`,
  );
  return outcome;
}
