// Game-aware rank client. Resolves PUUIDs to ranked data for either
// League of Legends (Riot's official API) or Valorant (HenrikDev's wrapper).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  config,
  RIOT_PLATFORM,
  RIOT_REGION,
  VAL_PLATFORM,
  VAL_REGION,
} from "./config.ts";

export type Game = "lol" | "val";

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

// Unified rank shape used by both games. Fields not relevant to a given game
// stay null/0 so embed renderers don't have to branch.
export interface GameRank {
  game: Game;
  gameName: string;
  tagLine: string;
  profileIconUrl: string | null;
  rankIconUrl: string | null; // emblem (LoL) or rank icon (Val); null if unranked
  tier: string | null; // null when unranked
  division: string | null;
  points: number; // LoL: LP. Val: RR. Same sort semantics.
  wins: number;
  losses: number;
  summonerLevel?: number; // LoL only
  currentAct?: string; // Val only — e.g. "e10a4"
  fetchedAt: number;
}

// -- HTTP plumbing ----------------------------------------------------------

const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_CONCURRENT = 8;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

async function backoffFetch<T>(
  url: string,
  init: RequestInit,
  logPrefix: string,
): Promise<T> {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  await acquireSlot();
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const started = Date.now();
      const res = await fetch(url, init);
      const ms = Date.now() - started;
      console.log(`[${logPrefix}] ${res.status} ${path} (${ms}ms)`);

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const exp = 2 ** attempt * 1000;
        const jitter = exp * (0.75 + Math.random() * 0.5);
        const retryAfter = Number(res.headers.get("retry-after"));
        const hint =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        const waitMs = Math.max(jitter, hint);
        console.log(
          `[${logPrefix}] retrying ${path} in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (body) console.log(`[${logPrefix}] error body: ${body.slice(0, 500)}`);
        throw new RiotApiError(
          `${logPrefix} ${res.status} for ${url}${body ? `: ${body}` : ""}`,
          res.status,
        );
      }

      return (await res.json()) as T;
    }
    throw new RiotApiError(`${logPrefix} exhausted retries for ${url}`, 0);
  } finally {
    releaseSlot();
  }
}

function riotFetch<T>(url: string): Promise<T> {
  return backoffFetch<T>(
    url,
    { headers: { "X-Riot-Token": config.riotApiKey } },
    "riot",
  );
}

function henrikFetch<T>(url: string): Promise<T> {
  return backoffFetch<T>(
    url,
    {
      headers: {
        Authorization: config.henrikApiKey,
        Accept: "*/*",
      },
    },
    "henrik",
  );
}

// -- Riot account lookup ----------------------------------------------------

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

export async function getAccount(
  gameName: string,
  tagLine: string,
): Promise<AccountDto> {
  const url =
    `https://${RIOT_REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  return riotFetch<AccountDto>(url);
}

async function getAccountByPuuid(puuid: string): Promise<AccountDto> {
  const url =
    `https://${RIOT_REGION}.api.riotgames.com/riot/account/v1/accounts/by-puuid/` +
    `${encodeURIComponent(puuid)}`;
  return riotFetch<AccountDto>(url);
}

// -- LoL-specific -----------------------------------------------------------

interface LeagueEntryDto {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

interface SummonerDto {
  profileIconId: number;
  summonerLevel: number;
}

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
        ddragonVersionPromise = null;
        throw err;
      }
    })();
  }
  return ddragonVersionPromise;
}

function rankEmblemUrl(tier: string): string {
  // OPGG's CDN hosts clean PNG emblems for all LoL tiers and is widely used.
  return `https://opgg-static.akamaized.net/images/medals_new/${tier.toLowerCase()}.png`;
}

async function fetchLolRank(puuid: string): Promise<GameRank> {
  const [account, summoner, entries, version] = await Promise.all([
    getAccountByPuuid(puuid),
    riotFetch<SummonerDto>(
      `https://${RIOT_PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`,
    ),
    riotFetch<LeagueEntryDto[]>(
      `https://${RIOT_PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
    ),
    ddragonVersion(),
  ]);

  const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5");

  return {
    game: "lol",
    gameName: account.gameName,
    tagLine: account.tagLine,
    profileIconUrl: `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${summoner.profileIconId}.png`,
    rankIconUrl: solo ? rankEmblemUrl(solo.tier) : null,
    tier: solo?.tier ?? null,
    division: solo?.rank ?? null,
    points: solo?.leaguePoints ?? 0,
    wins: solo?.wins ?? 0,
    losses: solo?.losses ?? 0,
    summonerLevel: summoner.summonerLevel,
    fetchedAt: Date.now(),
  };
}

// -- Valorant via HenrikDev -------------------------------------------------

// HenrikDev v3 by-puuid MMR response shape.
interface HenrikMmrResponse {
  data: {
    current?: {
      tier?: { id?: number; name?: string };
      rr?: number;
    };
    seasonal?: Array<{
      season?: { short?: string };
      wins?: number;
      games?: number;
    }>;
  };
}

interface HenrikAccountResponse {
  data: {
    puuid: string; // HenrikDev's dashed-UUID format
    name: string;
    tag: string;
    card?: string; // player-card UUID; build the icon URL from it
  };
}

// Fetched once from valorant-api.com — maps the current season's tier id to
// its small-icon URL. Cached for the process lifetime (changes only when
// Riot releases a new ranked episode/act).
let valTierIconsPromise: Promise<Map<number, string>> | null = null;

interface ValApiCompetitiveTiersResponse {
  data: Array<{
    uuid: string;
    tiers: Array<{
      tier: number;
      smallIcon: string | null;
      largeIcon: string | null;
    }>;
  }>;
}

async function valTierIcons(): Promise<Map<number, string>> {
  if (!valTierIconsPromise) {
    valTierIconsPromise = (async () => {
      const res = await fetch("https://valorant-api.com/v1/competitivetiers");
      const json = (await res.json()) as ValApiCompetitiveTiersResponse;
      const latest = json.data[json.data.length - 1];
      const map = new Map<number, string>();
      for (const t of latest?.tiers ?? []) {
        const icon = t.smallIcon ?? t.largeIcon;
        if (icon) map.set(t.tier, icon);
      }
      console.log(`[valapi] loaded ${map.size} tier icons`);
      return map;
    })().catch((err) => {
      valTierIconsPromise = null;
      throw err;
    });
  }
  return valTierIconsPromise;
}

function playerCardIconUrl(cardUuid: string): string {
  return `https://media.valorant-api.com/playercards/${cardUuid}/smallart.png`;
}

// Henrik returns tier names like "Diamond 2" or "Radiant" — split for sorting.
function parseValTier(name: string | undefined): {
  tier: string | null;
  division: string | null;
} {
  if (!name) return { tier: null, division: null };
  const m = name.trim().match(/^([A-Za-z]+)(?:\s+(\d+))?$/);
  if (!m) return { tier: null, division: null };
  return {
    tier: m[1]!.toUpperCase(),
    division: m[2] ?? null,
  };
}

async function fetchValRank(puuid: string): Promise<GameRank> {
  // HenrikDev's v3 by-puuid endpoints want their own dashed-UUID PUUID, not
  // Riot's encrypted account PUUID. Chain: Riot account-v1 (puuid → name/tag)
  // → HenrikDev account-by-name (name/tag → HenrikDev puuid) → v3 mmr by puuid.
  const account = await getAccountByPuuid(puuid);
  const { gameName, tagLine } = account;
  const name = encodeURIComponent(gameName);
  const tag = encodeURIComponent(tagLine);

  const accountRes = await henrikFetch<HenrikAccountResponse>(
    `https://api.henrikdev.xyz/valorant/v2/account/${name}/${tag}`,
  );
  const henrikPuuid = accountRes.data.puuid;

  const [mmrRes, tierIcons] = await Promise.all([
    henrikFetch<HenrikMmrResponse>(
      `https://api.henrikdev.xyz/valorant/v3/by-puuid/mmr/${VAL_REGION}/${VAL_PLATFORM}/${encodeURIComponent(henrikPuuid)}`,
    ),
    valTierIcons().catch(() => new Map<number, string>()),
  ]);

  const { tier, division } = parseValTier(mmrRes.data.current?.tier?.name);

  // Current act W/L: pick the seasonal entry with the highest episode/act
  // (parsed from `short` like "e10a4"). Array order isn't guaranteed by
  // HenrikDev, so we sort numerically instead of trusting [0] / [last].
  const seasons = mmrRes.data.seasonal ?? [];
  const seasonRank = (short: string | undefined): number => {
    const m = short?.match(/^e(\d+)a(\d+)$/i);
    if (!m) return -1;
    return Number(m[1]) * 100 + Number(m[2]);
  };
  const current = seasons.reduce<(typeof seasons)[number] | undefined>(
    (best, s) =>
      !best || seasonRank(s.season?.short) > seasonRank(best.season?.short)
        ? s
        : best,
    undefined,
  );
  console.log(
    `[henrik] current act ${current?.season?.short ?? "?"}: ${current?.wins ?? 0}W/${(current?.games ?? 0) - (current?.wins ?? 0)}L`,
  );
  const wins = current?.wins ?? 0;
  const games = current?.games ?? 0;

  const tierId = mmrRes.data.current?.tier?.id;
  const rankIcon = typeof tierId === "number" ? tierIcons.get(tierId) ?? null : null;
  const cardUuid = accountRes.data.card;
  const cardIcon = typeof cardUuid === "string" && cardUuid
    ? playerCardIconUrl(cardUuid)
    : null;

  return {
    game: "val",
    gameName,
    tagLine,
    profileIconUrl: cardIcon,
    rankIconUrl: rankIcon,
    currentAct: current?.season?.short ?? undefined,
    tier,
    division,
    points: mmrRes.data.current?.rr ?? 0,
    wins,
    losses: Math.max(0, games - wins),
    fetchedAt: Date.now(),
  };
}

// -- Persistent cache -------------------------------------------------------

const rankCache = new Map<string, Promise<GameRank>>();
const cacheKey = (game: Game, puuid: string) => `${game}:${puuid}`;

const CACHE_FILE = resolve(process.cwd(), "data", "rank-cache.json");
let cacheLoadPromise: Promise<void> | null = null;
let cacheWriteQueue: Promise<void> = Promise.resolve();

function loadCacheFromDisk(): Promise<void> {
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      try {
        const raw = await readFile(CACHE_FILE, "utf8");
        const data = JSON.parse(raw) as Record<string, GameRank>;
        for (const [key, rank] of Object.entries(data)) {
          // Migrate legacy entries: puuid-only keys → lol-prefixed; old
          // `leaguePoints` field → unified `points`; missing rankIconUrl filled.
          const normalizedKey = key.includes(":") ? key : `lol:${key}`;
          const legacy = rank as any;
          const normalizedRank: GameRank = {
            ...legacy,
            game: legacy.game ?? "lol",
            points: legacy.points ?? legacy.leaguePoints ?? 0,
            rankIconUrl: legacy.rankIconUrl ?? null,
            profileIconUrl: legacy.profileIconUrl ?? null,
          };
          rankCache.set(normalizedKey, Promise.resolve(normalizedRank));
        }
        console.log(`[cache] loaded ${rankCache.size} entries from disk`);
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          console.error("[cache] failed to load from disk:", err);
        }
      }
    })();
  }
  return cacheLoadPromise;
}

function scheduleCacheFlush(): void {
  cacheWriteQueue = cacheWriteQueue.then(async () => {
    const snapshot: Record<string, GameRank> = {};
    await Promise.all(
      Array.from(rankCache.entries()).map(async ([key, promise]) => {
        try {
          snapshot[key] = await promise;
        } catch {
          // Skip rejected entries.
        }
      }),
    );
    try {
      await mkdir(dirname(CACHE_FILE), { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(snapshot), "utf8");
    } catch (err) {
      console.error("[cache] failed to write to disk:", err);
    }
  });
}

export async function peekRank(
  puuid: string,
  game: Game,
): Promise<GameRank | null> {
  await loadCacheFromDisk();
  const entry = rankCache.get(cacheKey(game, puuid));
  if (!entry) return null;
  try {
    return await entry;
  } catch {
    return null;
  }
}

export function invalidateRank(puuid: string, game?: Game): void {
  const games: Game[] = game ? [game] : ["lol", "val"];
  for (const g of games) {
    if (rankCache.delete(cacheKey(g, puuid))) {
      console.log(`[cache] invalidated ${g}:${puuid.slice(0, 8)}`);
      scheduleCacheFlush();
    }
  }
}

export async function getRank(puuid: string, game: Game): Promise<GameRank> {
  await loadCacheFromDisk();
  const key = cacheKey(game, puuid);
  const short = `${game}:${puuid.slice(0, 8)}`;
  const cached = rankCache.get(key);
  if (cached) {
    console.log(`[cache] hit ${short}`);
    return cached;
  }

  console.log(`[cache] miss ${short} — fetching`);
  const promise = game === "lol" ? fetchLolRank(puuid) : fetchValRank(puuid);
  rankCache.set(key, promise);
  promise
    .then(() => scheduleCacheFlush())
    .catch(() => {
      console.log(`[cache] evicting ${short} after failed fetch`);
      rankCache.delete(key);
    });
  return promise;
}

// -- Ranking & display ------------------------------------------------------

const LOL_TIER_ORDER = [
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
const LOL_DIVISION_ORDER = ["IV", "III", "II", "I"];

const VAL_TIER_ORDER = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "DIAMOND",
  "ASCENDANT",
  "IMMORTAL",
  "RADIANT",
];
const VAL_DIVISION_ORDER = ["1", "2", "3"];

export function rankScore(r: GameRank): number {
  if (!r.tier) return -1;
  if (r.game === "lol") {
    const tier = LOL_TIER_ORDER.indexOf(r.tier);
    const div = r.division ? LOL_DIVISION_ORDER.indexOf(r.division) : 0;
    return tier * 10_000 + div * 1_000 + r.points;
  }
  const tier = VAL_TIER_ORDER.indexOf(r.tier);
  const div = r.division ? VAL_DIVISION_ORDER.indexOf(r.division) : 0;
  return tier * 10_000 + div * 1_000 + r.points;
}

// Tier colors (lowercase keys for case-insensitive lookup).
export const TIER_COLORS: Record<string, number> = {
  iron: 0x51484a,
  bronze: 0x8c5230,
  silver: 0x9aa9b2,
  gold: 0xe4b34a,
  platinum: 0x4ea0a0,
  emerald: 0x2f9d6b,
  diamond: 0x576bce,
  ascendant: 0x2f9d6b,
  master: 0x9d4dbb,
  immortal: 0xb33b53,
  grandmaster: 0xc6443e,
  challenger: 0xf4c874,
  radiant: 0xfffbcc,
};

export function tierColor(tier: string | null): number {
  if (!tier) return 0x5865f2;
  return TIER_COLORS[tier.toLowerCase()] ?? 0x5865f2;
}

/** Build the appropriate stat-tracker profile URL for a rank. */
export function profileUrl(r: GameRank): string {
  const name = encodeURIComponent(r.gameName);
  const tag = encodeURIComponent(r.tagLine);
  if (r.game === "lol") return `https://www.op.gg/lol/summoners/na/${name}-${tag}`;
  return `https://tracker.gg/valorant/profile/riot/${name}%23${tag}/overview`;
}

/** Human-readable rank like "DIAMOND II 45 LP" or "Diamond 2 45 RR". */
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function formatRank(r: GameRank): string {
  if (!r.tier) return "Unranked";
  const unit = r.game === "lol" ? "LP" : "RR";
  const parts = [titleCase(r.tier)];
  if (r.division) parts.push(r.division);
  parts.push(`${r.points} ${unit}`);
  return parts.join(" ");
}
