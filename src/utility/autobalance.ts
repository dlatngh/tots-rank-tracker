// LoL autobalancer integration. The web app owns all parsing / rank-fetching /
// MMR / balancing logic; this module only calls its HTTP API, renders the teams
// as a Discord embed, and caches resolved lobbies so reroll never re-hits Riot.
//
// See autobalancer.md for the full integration brief. Key gotcha: these routes
// always return HTTP 200 — the real status is in the JSON body's `status` field.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { config } from "./config.ts";
import { tierColor } from "./riot.ts";
import { log } from "./log.ts";

export type RankMode = "HIGHEST" | "SOLO_DUO";

export type PlayerInfo = {
  tier: string; // "GOLD", "DIAMOND", "MASTER", ... or "" if unranked
  division: string | null; // "I".."IV", or "" / null for unranked and apex tiers
  leaguePoints: number | null;
  summonerLevel: number;
  profileIconId: number;
};

// team1/team2 are arrays of SINGLE-KEY objects: one player per object.
export type BalancedTeams = {
  team1: { [playerName: string]: PlayerInfo }[];
  team2: { [playerName: string]: PlayerInfo }[];
};

export type Lobby = { [playerName: string]: PlayerInfo };

type BalanceResponse = {
  status: number;
  message: string;
  teams?: BalancedTeams;
  lobby?: Lobby;
};

/** Thrown when the web app returns a non-200 body status (still HTTP 200). */
export class AutobalanceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AutobalanceError";
  }
}

async function post(path: string, body: unknown): Promise<BalanceResponse> {
  const res = await fetch(`${config.webAppBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-secret": config.botSharedSecret,
    },
    body: JSON.stringify(body),
  });
  // Routes always return HTTP 200; a non-200 HTTP code means infra/route trouble
  // (e.g. /api/balance not yet deployed → 404), not an app-level error.
  if (!res.ok) {
    throw new AutobalanceError(
      res.status,
      `Web app returned HTTP ${res.status} for ${path}.`,
    );
  }
  const data = (await res.json()) as BalanceResponse;
  if (data.status !== 200) {
    throw new AutobalanceError(data.status, data.message || "Unknown error.");
  }
  return data;
}

/** Initial balance: parse the log, fetch ranks, balance. Expensive (hits Riot). */
export async function balance(
  chatLog: string,
  rankMode: RankMode,
): Promise<{ teams: BalancedTeams; lobby: Lobby }> {
  const started = Date.now();
  const data = await post("/api/balance", { chatLog, rankMode });
  log("cmd", `autobalance balance (${rankMode}) ok (${Date.now() - started}ms)`);
  return { teams: data.teams!, lobby: data.lobby! };
}

/** Reroll: re-balance an already-resolved lobby. Instant, never touches Riot. */
export async function rerollLobby(lobby: Lobby): Promise<BalancedTeams> {
  const started = Date.now();
  const data = await post("/api/lobby/balance", { lobby });
  log("cmd", `autobalance reroll ok (${Date.now() - started}ms)`);
  return data.teams!;
}

// --- Rendering ---------------------------------------------------------------

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** "Emerald IV" / "Master" / "Unranked". */
function formatPlayerRank(info: PlayerInfo): string {
  if (!info.tier) return "Unranked";
  const parts = [titleCase(info.tier)];
  if (info.division) parts.push(info.division);
  return parts.join(" ");
}

function teamLines(team: BalancedTeams["team1"]): string {
  if (team.length === 0) return "_(empty)_";
  // Name and rank on separate lines so narrow inline fields don't wrap mid-entry.
  return team
    .map((entry) => {
      const name = Object.keys(entry)[0]!; // single-key objects, "GameName#TAG"
      return `**${name}**\n${formatPlayerRank(entry[name]!)}`;
    })
    .join("\n\n");
}

// Tier ordering (low → high) so the embed color can reflect the lobby's top player.
const TIER_ORDER = [
  "iron",
  "bronze",
  "silver",
  "gold",
  "platinum",
  "emerald",
  "diamond",
  "master",
  "grandmaster",
  "challenger",
];

function topTier(teams: BalancedTeams): string | null {
  let best: string | null = null;
  let bestIdx = -1;
  for (const entry of [...teams.team1, ...teams.team2]) {
    const info = Object.values(entry)[0]!;
    const idx = TIER_ORDER.indexOf(info.tier.toLowerCase());
    if (idx > bestIdx) {
      bestIdx = idx;
      best = info.tier;
    }
  }
  return best;
}

const MODE_LABELS: Record<RankMode, string> = {
  HIGHEST: "Highest (Solo/Duo + Flex peak)",
  SOLO_DUO: "Solo/Duo only",
};

export function buildTeamsPayload(teams: BalancedTeams, mode: RankMode) {
  const embed = new EmbedBuilder()
    .setTitle("Balanced Teams")
    .setColor(tierColor(topTier(teams)))
    .addFields(
      { name: "Team 1", value: teamLines(teams.team1), inline: true },
      { name: "Team 2", value: teamLines(teams.team2), inline: true },
    )
    .setFooter({ text: `Rank mode: ${MODE_LABELS[mode]}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("autobalance:reroll")
      .setLabel("Reroll")
      .setStyle(ButtonStyle.Primary),
  );

  return { content: "", embeds: [embed], components: [row] };
}

// --- Lobby cache (keyed by the posted message id) ----------------------------
//
// Reroll re-balances the cached lobby instead of re-parsing/re-fetching. We also
// remember the mode so the rerolled embed keeps the right footer.

type CachedLobby = { lobby: Lobby; mode: RankMode };

const MAX_CACHED = 500;
const lobbyCache = new Map<string, CachedLobby>();

export function cacheLobby(messageId: string, lobby: Lobby, mode: RankMode): void {
  // Evict oldest insertion when over capacity (Map preserves insertion order).
  if (lobbyCache.size >= MAX_CACHED) {
    const oldest = lobbyCache.keys().next().value;
    if (oldest) lobbyCache.delete(oldest);
  }
  lobbyCache.set(messageId, { lobby, mode });
}

export function getCachedLobby(messageId: string): CachedLobby | undefined {
  return lobbyCache.get(messageId);
}
