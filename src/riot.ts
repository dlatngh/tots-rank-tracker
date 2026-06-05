// Thin Riot API client: resolve a Riot ID to a PUUID, then fetch ranked entries.

import { config, RIOT_PLATFORM, RIOT_REGION } from "./config.ts";

export class RiotApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "RiotApiError";
  }
}

interface AccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

interface LeagueEntryDto {
  queueType: string; // e.g. "RANKED_SOLO_5x5"
  tier: string; // e.g. "GOLD"
  rank: string; // e.g. "IV"
  leaguePoints: number;
  wins: number;
  losses: number;
}

interface SummonerDto {
  profileIconId: number;
  summonerLevel: number;
}

export interface SoloDuoRank {
  gameName: string;
  tagLine: string;
  summonerLevel: number;
  profileIconUrl: string;
  rankEmblemUrl: string | null; // null when unranked
  tier: string | null; // null when unranked
  division: string | null;
  leaguePoints: number;
  wins: number;
  losses: number;
  fetchedAt: number; // unix ms when this data was actually pulled from Riot
}

async function riotFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "X-Riot-Token": config.riotApiKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RiotApiError(
      `Riot API ${res.status} for ${url}${body ? `: ${body}` : ""}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

/** Parse a "GameName#TAG" Riot ID into its parts. */
export function parseRiotId(
  riotId: string,
): { gameName: string; tagLine: string } | null {
  const idx = riotId.lastIndexOf("#");
  if (idx <= 0 || idx === riotId.length - 1) return null;
  return {
    gameName: riotId.slice(0, idx).trim(),
    tagLine: riotId.slice(idx + 1).trim(),
  };
}

/** Resolve a Riot ID to its PUUID via the account-v1 endpoint. */
export async function getAccount(
  gameName: string,
  tagLine: string,
): Promise<AccountDto> {
  const url =
    `https://${RIOT_REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  return riotFetch<AccountDto>(url);
}

/** Resolve a PUUID back to the player's current Riot ID. */
export async function getAccountByPuuid(puuid: string): Promise<AccountDto> {
  const url =
    `https://${RIOT_REGION}.api.riotgames.com/riot/account/v1/accounts/by-puuid/` +
    `${encodeURIComponent(puuid)}`;
  return riotFetch<AccountDto>(url);
}

async function getSummoner(puuid: string): Promise<SummonerDto> {
  const url =
    `https://${RIOT_PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/` +
    `${encodeURIComponent(puuid)}`;
  return riotFetch<SummonerDto>(url);
}

// Latest Data Dragon version, fetched once and cached for the process lifetime.
let ddragonVersionPromise: Promise<string> | null = null;
async function ddragonVersion(): Promise<string> {
  if (!ddragonVersionPromise) {
    ddragonVersionPromise = (async () => {
      try {
        const res = await fetch(
          "https://ddragon.leagueoflegends.com/api/versions.json",
        );
        const versions = (await res.json()) as string[];
        if (!versions[0]) throw new Error("Data Dragon returned no versions");
        return versions[0];
      } catch (err) {
        ddragonVersionPromise = null; // allow retry on failure
        throw err;
      }
    })();
  }
  return ddragonVersionPromise;
}

function profileIconUrl(iconId: number, version: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${iconId}.png`;
}

function rankEmblemUrl(tier: string): string {
  // Community Dragon hosts the modern ranked emblems.
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tier.toLowerCase()}.png`;
}

// In-memory cache for rank lookups. Keyed by PUUID; stores the in-flight
// promise so concurrent callers (e.g. /leaderboard scoring many players)
// coalesce onto one Riot API call instead of fanning out duplicates.
const RANK_TTL_MS = 20 * 60_000;
const rankCache = new Map<string, { expiry: number; promise: Promise<SoloDuoRank> }>();

/** Drop a single PUUID from the cache (e.g. after re-registration). */
export function invalidateRankCache(puuid: string): void {
  rankCache.delete(puuid);
}

/**
 * Fetch the solo/duo rank summary for a PUUID, including profile icon and
 * rank emblem URLs for embed rendering. Returns base info even for unranked
 * players (with rank fields null) so callers can still show the profile.
 *
 * Results are cached for RANK_TTL_MS to stay well under Riot's rate limits.
 */
export async function getSoloDuoRank(puuid: string): Promise<SoloDuoRank> {
  const now = Date.now();
  const cached = rankCache.get(puuid);
  if (cached && cached.expiry > now) return cached.promise;

  const promise = fetchSoloDuoRank(puuid);
  rankCache.set(puuid, { expiry: now + RANK_TTL_MS, promise });
  // On failure, evict so the next call retries instead of serving the rejection.
  promise.catch(() => rankCache.delete(puuid));
  return promise;
}

async function fetchSoloDuoRank(puuid: string): Promise<SoloDuoRank> {
  const [account, summoner, entries, version] = await Promise.all([
    getAccountByPuuid(puuid),
    getSummoner(puuid),
    riotFetch<LeagueEntryDto[]>(
      `https://${RIOT_PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
    ),
    ddragonVersion(),
  ]);

  const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5");

  return {
    gameName: account.gameName,
    tagLine: account.tagLine,
    summonerLevel: summoner.summonerLevel,
    profileIconUrl: profileIconUrl(summoner.profileIconId, version),
    rankEmblemUrl: solo ? rankEmblemUrl(solo.tier) : null,
    tier: solo?.tier ?? null,
    division: solo?.rank ?? null,
    leaguePoints: solo?.leaguePoints ?? 0,
    wins: solo?.wins ?? 0,
    losses: solo?.losses ?? 0,
    fetchedAt: Date.now(),
  };
}

// Higher index = higher tier. Used for sorting players.
const TIER_ORDER = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
  "MASTER",
  "GRANDMASTER",
  "CHALLENGER",
];
const DIVISION_ORDER = ["IV", "III", "II", "I"];

/** Numeric score for ordering ranks. Unranked returns -1. */
export function rankScore(r: SoloDuoRank): number {
  if (!r.tier) return -1;
  const tier = TIER_ORDER.indexOf(r.tier);
  const div = r.division ? DIVISION_ORDER.indexOf(r.division) : 0;
  return tier * 10_000 + div * 1_000 + r.leaguePoints;
}

// Standard tier colors for embed accents.
export const TIER_COLORS: Record<string, number> = {
  IRON: 0x51484a,
  BRONZE: 0x8c5230,
  SILVER: 0x9aa9b2,
  GOLD: 0xe4b34a,
  PLATINUM: 0x4ea0a0,
  EMERALD: 0x2f9d6b,
  DIAMOND: 0x576bce,
  MASTER: 0x9d4dbb,
  GRANDMASTER: 0xc6443e,
  CHALLENGER: 0xf4c874,
};
