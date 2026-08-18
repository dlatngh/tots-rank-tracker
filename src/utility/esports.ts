// Esports schedule client backed by Fandom's Cargo (Leaguepedia & sibling
// esports wikis). One generic provider works across games because every
// esports wiki shares the same `MatchSchedule` / `Tournaments` / `Leagues`
// schema; only the wiki host changes per game.
//
// Fandom rate-limits anonymous API access hard, so we minimize requests: a
// single batched query pulls every known league at once (one HTTP call instead
// of one-per-league) and primes the cache for all of them, so any command warms
// the cache for the rest. We also back off on `ratelimited` responses and serve
// stale cache when throttled.

import { config } from "./config.ts";
import { getEsportsSchedule, type OpggEsportsMatch } from "./opgg.ts";
import { log, logError } from "./log.ts";

export type EsportsGame = "lol" | "valorant";

interface GameSource {
  host: string;
  label: string;
}

export const GAME_SOURCES: Record<EsportsGame, GameSource> = {
  lol: { host: "lol.fandom.com", label: "League of Legends" },
  valorant: { host: "valorant.fandom.com", label: "Valorant" },
};

// -- Cargo HTTP plumbing ----------------------------------------------------

// Fandom asks bots to send a descriptive User-Agent with contact info.
const USER_AGENT =
  "racker-discord-bot/1.0 (https://github.com/; contact yulheelim4@gmail.com)";

const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class EsportsError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "EsportsError";
  }
}

interface CargoRow {
  [key: string]: string;
}

// -- Authentication ---------------------------------------------------------
//
// Anonymous Fandom API access is throttled to ~1 request/minute. Logging in
// with a bot password (Special:BotPasswords, "High-volume (bot) access") moves
// us to the much higher registered-bot rate tier. Credentials are optional;
// without them the client runs anonymously and just relies on caching.

const authConfigured = (): boolean =>
  !!(config.leaguepediaUsername && config.leaguepediaPassword);

// Cookie jar + one-shot login promise, both keyed by host (cookies and sessions
// are host-scoped: lol.fandom.com and valorant.fandom.com log in separately).
const cookieJars = new Map<string, Map<string, string>>();
const loginOnce = new Map<string, Promise<void>>();

function jarFor(host: string): Map<string, string> {
  let jar = cookieJars.get(host);
  if (!jar) cookieJars.set(host, (jar = new Map()));
  return jar;
}

function storeCookies(host: string, res: Response): void {
  const jar = jarFor(host);
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(host: string): string {
  return [...jarFor(host)].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function login(host: string): Promise<void> {
  const base = `https://${host}/api.php`;

  // 1. Fetch a login token (this also sets the initial session cookie).
  const tokRes = await fetch(
    `${base}?action=query&meta=tokens&type=login&format=json`,
    { headers: { "User-Agent": USER_AGENT } },
  );
  storeCookies(host, tokRes);
  const token = (await tokRes.json().catch(() => ({})) as any)?.query?.tokens
    ?.logintoken;
  if (!token) throw new EsportsError("could not obtain a login token");

  // 2. Log in with the bot password, returning the session cookie.
  const loginRes = await fetch(base, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(host),
    },
    body: new URLSearchParams({
      action: "login",
      lgname: config.leaguepediaUsername,
      lgpassword: config.leaguepediaPassword,
      lgtoken: token,
      format: "json",
    }),
  });
  storeCookies(host, loginRes);
  const result = ((await loginRes.json().catch(() => ({}))) as any)?.login
    ?.result;
  if (result !== "Success") throw new EsportsError(`login result: ${result}`);
  log("esports", `authenticated to ${host} as ${config.leaguepediaUsername}`);
}

// Ensure we're logged in once per host. A login failure is logged but not
// fatal — we clear the cached attempt and continue anonymously, retrying login
// on the next request.
function ensureLogin(host: string): Promise<void> {
  if (!authConfigured()) return Promise.resolve();
  let p = loginOnce.get(host);
  if (!p) {
    p = login(host).catch((err) => {
      logError("esports", `login to ${host} failed, continuing anonymously:`, err);
      loginOnce.delete(host);
    });
    loginOnce.set(host, p);
  }
  return p;
}

async function cargoQuery(
  host: string,
  params: Record<string, string>,
): Promise<CargoRow[]> {
  await ensureLogin(host);
  const authed = authConfigured();
  const query = new URLSearchParams({
    action: "cargoquery",
    format: "json",
    maxlag: "5",
    // Verify the session is actually applied; a dropped session surfaces as
    // `assertuserfailed` (handled below) rather than silently falling back to
    // the anonymous rate tier.
    ...(authed ? { assert: "user" } : {}),
    ...params,
  });
  const url = `https://${host}/api.php?${query}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const started = Date.now();
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        ...(authed ? { Cookie: cookieHeader(host) } : {}),
      },
    });
    storeCookies(host, res);
    const json = (await res.json().catch(() => ({}))) as any;
    const ms = Date.now() - started;
    const code = json?.error?.code as string | undefined;
    log("esports", `${res.status}${code ? ` ${code}` : ""} ${host} (${ms}ms)`);

    // Session expired/dropped: re-login once and retry with a fresh session.
    if (code === "assertuserfailed" && attempt < MAX_RETRIES) {
      log("esports", `session lost on ${host}, re-authenticating`);
      loginOnce.delete(host);
      await ensureLogin(host);
      continue;
    }

    // Retry only transient server load (`maxlag`, HTTP 429/503). A
    // `ratelimited` cooldown won't clear in seconds, and retrying just re-trips
    // Fandom's burst limit, so we fail fast on it and let callers serve stale.
    const transient = res.status === 429 || res.status === 503 || code === "maxlag";
    if (transient && attempt < MAX_RETRIES) {
      const wait = 2 ** attempt * 2000 * (0.75 + Math.random() * 0.5);
      log("esports", `transient throttle from ${host}, retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
      continue;
    }
    if (json?.error) {
      logError("esports", `${host} error:`, json.error.info ?? json.error.code);
      throw new EsportsError(json.error.info ?? "API error", code);
    }
    return (json?.cargoquery ?? []).map((r: { title: CargoRow }) => r.title);
  }
  throw new EsportsError("Rate limited. Try again in a moment.", "ratelimited");
}

// -- Caching ----------------------------------------------------------------

interface CacheEntry<T> {
  at: number;
  data: T;
}

// How many rows to cache per league. Commands ask for far fewer (1-5), but we
// cache a generous slice so changing `count` between calls is still a cache hit.
const PER_LEAGUE_CAP = 10;

// Global row cap for the single batched query. Cargo allows up to 500; rows are
// ordered by date, so this is large enough that every league still gets its full
// PER_LEAGUE_CAP even when one league's schedule is unusually busy.
const BATCH_LIMIT = 500;

// Fetch every league for a game in ONE request, then populate the cache entry
// for every league (not just the one requested) so a single command warms them
// all. Fresh hits for the requested league return immediately; on a fetch error
// (typically a rate-limit cooldown) we fall back to stale data if we have any.
//
// `fetchAll` returns rows already grouped by `Tournaments.League`.
async function cachedBatch<T>(
  store: Map<string, CacheEntry<T[]>>,
  game: EsportsGame,
  league: League,
  ttl: number,
  fetchAll: () => Promise<Map<string, T[]>>,
): Promise<T[]> {
  const { host } = GAME_SOURCES[game];
  const key = `${host}:${league.name}`;
  const entry = store.get(key);
  if (entry && Date.now() - entry.at < ttl) return entry.data;
  try {
    const grouped = await fetchAll();
    const at = Date.now();
    // Cache every known league, including ones with no rows, so empty results
    // are also cached (and don't re-fetch) until the TTL expires.
    for (const l of leaguesFor(game)) {
      store.set(`${host}:${l.name}`, { at, data: grouped.get(l.name) ?? [] });
    }
    return grouped.get(league.name) ?? [];
  } catch (err) {
    if (entry) {
      log("esports", `serving stale cache for ${key} after error`);
      return entry.data;
    }
    throw err;
  }
}

// Fetch through a single-key cache: fresh hits return immediately; on a fetch
// error (typically a rate-limit cooldown) fall back to stale data if present.
async function cachedSingle<T>(
  store: Map<string, CacheEntry<T>>,
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const entry = store.get(key);
  if (entry && Date.now() - entry.at < ttl) return entry.data;
  try {
    const data = await fetcher();
    store.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (entry) {
      log("esports", `serving stale cache for ${key} after error`);
      return entry.data;
    }
    throw err;
  }
}

// Partition date-ordered rows into per-league buckets, capped at PER_LEAGUE_CAP
// each. Rows arrive in display order, so slicing preserves it.
function groupByLeague<T>(
  rows: { league: string | undefined; item: T }[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const { league, item } of rows) {
    if (!league) continue; // rows always carry T.League, but be defensive
    const arr = out.get(league) ?? [];
    if (arr.length < PER_LEAGUE_CAP) arr.push(item);
    out.set(league, arr);
  }
  return out;
}

// -- Leagues ----------------------------------------------------------------

export interface League {
  name: string; // canonical `Tournaments.League` value used to filter matches
  short: string; // display code (e.g. "LCK")
  region: string;
  aliases?: string[]; // extra strings that should resolve to this league
  opgg?: string; // league key for the OP.GG fallback (see esports-fallback)
}

// Known leagues per game. `name` MUST match Leaguepedia's `Tournaments.League`
// value exactly (the full league name, not the short code) — see the `Leagues`
// Cargo table. `short` is what we display; `aliases` are alternate user inputs.
// Resolving from this static map (rather than the Leagues API table) avoids an
// extra request per command, which matters under Fandom's rate limiting.
const LEAGUES: Record<EsportsGame, League[]> = {
  lol: [
    { name: "LoL Champions Korea", short: "LCK", region: "Korea", opgg: "lck" },
    { name: "Tencent LoL Pro League", short: "LPL", region: "China", opgg: "lpl" },
    { name: "LoL EMEA Championship", short: "LEC", region: "EMEA", opgg: "lec" },
    {
      name: "League of Legends Championship of The Americas North",
      short: "LTA N",
      region: "Americas",
      opgg: "lta north",
      aliases: ["LTA North", "LCS", "NA"],
    },
    {
      name: "League of Legends Championship of The Americas South",
      short: "LTA S",
      region: "Americas",
      opgg: "lta south",
      aliases: ["LTA South", "CBLOL", "LLA"],
    },
    { name: "Mid-Season Invitational", short: "MSI", region: "International", opgg: "msi" },
    {
      name: "World Championship",
      short: "Worlds",
      region: "International",
      opgg: "worlds",
      aliases: ["WCS"],
    },
    {
      name: "First Stand",
      short: "First Stand",
      region: "International",
      aliases: ["FST"],
      opgg: "first stand",
    },
  ],
  valorant: [],
};

export function leaguesFor(game: EsportsGame): League[] {
  return LEAGUES[game];
}

// Match a user query (e.g. "lck", "worlds") to a known league by short code or
// name, falling back to a loose substring match. No API call.
export function resolveLeague(game: EsportsGame, query: string): League | null {
  const q = query.trim().toLowerCase();
  const leagues = LEAGUES[game];
  const aliases = (l: League) => l.aliases ?? [];
  return (
    leagues.find((l) => l.short.toLowerCase() === q) ??
    leagues.find((l) => l.name.toLowerCase() === q) ??
    leagues.find((l) => aliases(l).some((a) => a.toLowerCase() === q)) ??
    leagues.find(
      (l) =>
        l.short.toLowerCase().includes(q) ||
        l.name.toLowerCase().includes(q) ||
        aliases(l).some((a) => a.toLowerCase().includes(q)),
    ) ??
    null
  );
}

// -- Schedule ---------------------------------------------------------------

export interface Match {
  startTime: string; // ISO UTC
  team1: string;
  team2: string;
  score1: number;
  score2: number;
  bestOf: number;
  live: boolean;
  tournament: string;
  stream: string | null;
}

const SCHEDULE_TTL = 5 * 60 * 1000; // 5m, keeps us well under the rate limit.
const upcomingCache = new Map<string, CacheEntry<Match[]>>();
const pastCache = new Map<string, CacheEntry<Match[]>>();

const SCHEDULE_FIELDS = [
  "SH.Team1=team1",
  "SH.Team2=team2",
  "SH.Team1Score=score1",
  "SH.Team2Score=score2",
  "SH.DateTime_UTC=dt",
  "SH.BestOf=bestOf",
  "SH.Winner=winner",
  "SH.Stream=stream",
  "T.Name=tournament",
  "T.League=league", // used to partition the batched result per league
].join(",");

// Single batched query covering every known league for `game`, returning rows
// grouped by `Tournaments.League`. `dir` selects upcoming vs. past matches.
async function fetchScheduleAll(
  game: EsportsGame,
  dir: "upcoming" | "past",
): Promise<Map<string, Match[]>> {
  const { host } = GAME_SOURCES[game];
  const leagues = leaguesFor(game);
  if (leagues.length === 0) return new Map();
  const inClause = leagues.map((l) => `'${escapeSql(l.name)}'`).join(",");
  // Upcoming keeps a 2h grace window so in-progress series stay visible.
  const cutoff =
    dir === "upcoming"
      ? `SH.DateTime_UTC >= '${utcStamp(-2 * 60 * 60 * 1000)}'`
      : `SH.DateTime_UTC < '${utcStamp()}'`;
  const rows = await cargoQuery(host, {
    tables: "MatchSchedule=SH,Tournaments=T",
    join_on: "SH.OverviewPage=T.OverviewPage",
    fields: SCHEDULE_FIELDS,
    where: `T.League IN (${inClause}) AND ${cutoff}`,
    order_by: `SH.DateTime_UTC ${dir === "upcoming" ? "ASC" : "DESC"}`,
    limit: String(BATCH_LIMIT),
  });
  return groupByLeague(rows.map((r) => ({ league: r.league, item: toMatch(r) })));
}

// Cargo stores DateTime_UTC as "YYYY-MM-DD HH:MM:SS" (UTC). Build a comparable
// string offset from now (negative offset reaches back into the past).
function utcStamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

// Upcoming matches for a league, soonest first. A 2h grace window keeps
// in-progress series visible rather than dropping off the moment they start.

// -- OP.GG fallback ---------------------------------------------------------
//
// Leaguepedia is the primary source: it covers both games and carries the
// per-game scoreboards. When it is throttled or erroring, fall back to OP.GG's
// esports schedule so the schedule commands still answer. OP.GG is LoL only.

function toMatchFromOpgg(match: OpggEsportsMatch): Match {
  const finished = match.status === "FINISHED";
  const notStarted = match.status === "NOT_STARTED";
  // Bracket fixtures are scheduled before their teams are known.
  return {
    startTime: match.scheduledAt,
    team1: match.homeTeam?.name ?? "TBD",
    team2: match.awayTeam?.name ?? "TBD",
    score1: match.homeScore,
    score2: match.awayScore,
    bestOf: match.numberOfGames,
    live: !finished && !notStarted,
    tournament: match.league,
    // OP.GG exposes a match page, not a broadcast link.
    stream: null,
  };
}

async function opggScheduleFallback(
  game: EsportsGame,
  direction: "upcoming" | "past",
  options: { league?: League; team?: TeamRef },
  cause: unknown,
): Promise<Match[]> {
  if (game !== "lol") throw cause;
  // A league we have no OP.GG key for cannot be filtered server-side, and
  // returning every league's matches would be wrong rather than merely thin.
  if (options.league && !options.league.opgg) throw cause;

  log(
    "esports",
    `Leaguepedia failed (${cause instanceof Error ? cause.message : String(cause)}); trying OP.GG`,
  );

  const matches = await getEsportsSchedule({
    mode: direction === "upcoming" ? "schedule" : "result",
    league: options.league?.opgg,
    teamName: options.team?.name,
  });

  const converted = matches.map(toMatchFromOpgg);
  converted.sort((a, b) =>
    direction === "upcoming"
      ? a.startTime.localeCompare(b.startTime)
      : b.startTime.localeCompare(a.startTime),
  );
  return converted;
}

export async function getUpcomingMatches(
  game: EsportsGame,
  league: League,
  limit = 8,
): Promise<Match[]> {
  const all = await cachedBatch(upcomingCache, game, league, SCHEDULE_TTL, () =>
    fetchScheduleAll(game, "upcoming"),
  ).catch((err) =>
    opggScheduleFallback(game, "upcoming", { league }, err),
  );
  return all.slice(0, limit);
}

// Recently finished matches for a league, most recent first.
export async function getPastMatches(
  game: EsportsGame,
  league: League,
  limit = 8,
): Promise<Match[]> {
  const all = await cachedBatch(pastCache, game, league, SCHEDULE_TTL, () =>
    fetchScheduleAll(game, "past"),
  ).catch((err) => opggScheduleFallback(game, "past", { league }, err));
  return all.slice(0, limit);
}

// -- Schedule by team -------------------------------------------------------

// Over-fetch a few matches per team+direction; the command slices to the count.
const TEAM_SCHEDULE_CAP = 10;
const teamUpcomingCache = new Map<string, CacheEntry<Match[]>>();
const teamPastCache = new Map<string, CacheEntry<Match[]>>();

// Schedule for one team across all tournaments. Upcoming is soonest-first (with
// a 2h grace window for in-progress series); past is most-recent-first.
function fetchTeamSchedule(
  game: EsportsGame,
  team: TeamRef,
  dir: "upcoming" | "past",
): Promise<Match[]> {
  const { host } = GAME_SOURCES[game];
  const store = dir === "upcoming" ? teamUpcomingCache : teamPastCache;
  return cachedSingle(store, `${host}:${team.name}`, SCHEDULE_TTL, async () => {
    const esc = escapeSql(team.name);
    const cutoff =
      dir === "upcoming"
        ? `SH.DateTime_UTC >= '${utcStamp(-2 * 60 * 60 * 1000)}'`
        : `SH.DateTime_UTC < '${utcStamp()}'`;
    const rows = await cargoQuery(host, {
      tables: "MatchSchedule=SH,Tournaments=T",
      join_on: "SH.OverviewPage=T.OverviewPage",
      fields: SCHEDULE_FIELDS,
      where: `(SH.Team1='${esc}' OR SH.Team2='${esc}') AND ${cutoff}`,
      order_by: `SH.DateTime_UTC ${dir === "upcoming" ? "ASC" : "DESC"}`,
      limit: String(TEAM_SCHEDULE_CAP),
    });
    return rows.map(toMatch);
  });
}

export async function getTeamUpcomingMatches(
  game: EsportsGame,
  team: TeamRef,
  limit = 5,
): Promise<Match[]> {
  const matches = await fetchTeamSchedule(game, team, "upcoming").catch((err) =>
    opggScheduleFallback(game, "upcoming", { team }, err),
  );
  return matches.slice(0, limit);
}

export async function getTeamPastMatches(
  game: EsportsGame,
  team: TeamRef,
  limit = 5,
): Promise<Match[]> {
  const matches = await fetchTeamSchedule(game, team, "past").catch((err) =>
    opggScheduleFallback(game, "past", { team }, err),
  );
  return matches.slice(0, limit);
}

// -- Match stats (per-game scoreboard) --------------------------------------

export interface GameStats {
  team1: string;
  team2: string;
  winner: string | null;
  startTime: string; // ISO UTC
  length: string | null; // e.g. "32:14"
  team1Kills: number;
  team2Kills: number;
  team1Gold: number | null;
  team2Gold: number | null;
  tournament: string;
  gameInMatch: number | null; // game number within the series (1, 2, 3, ...)
  matchId: string | null; // shared across games of the same series
}

const STATS_FIELDS = [
  "SG.Team1=team1",
  "SG.Team2=team2",
  "SG.WinTeam=winner",
  "SG.DateTime_UTC=dt",
  "SG.Gamelength=length",
  "SG.Team1Kills=k1",
  "SG.Team2Kills=k2",
  "SG.Team1Gold=g1",
  "SG.Team2Gold=g2",
  "SG.N_GameInMatch=gnum",
  "SG.MatchId=mid",
  "T.Name=tournament",
  "T.League=league", // tournament-name fallback in toGameStats
].join(",");

function toGameStats(r: CargoRow): GameStats {
  return {
    team1: r.team1 || "TBD",
    team2: r.team2 || "TBD",
    winner: r.winner || null,
    startTime: toIso(r.dt),
    length: r.length || null,
    team1Kills: Number(r.k1) || 0,
    team2Kills: Number(r.k2) || 0,
    team1Gold: r.g1 ? Math.round(Number(r.g1)) : null,
    team2Gold: r.g2 ? Math.round(Number(r.g2)) : null,
    tournament: r.tournament || r.league || "",
    gameInMatch: r.gnum ? Number(r.gnum) : null,
    matchId: r.mid || null,
  };
}

// -- Teams ------------------------------------------------------------------

export interface TeamRef {
  name: string; // canonical Leaguepedia team name, used to filter games
  short: string; // tricode, e.g. "GEN"
  region: string;
}

const TEAM_TTL = 24 * 60 * 60 * 1000; // team names rarely change; cache a day
const teamCache = new Map<string, CacheEntry<TeamRef | null>>();

// Resolve a user-typed team (full name, tricode, or partial) to a canonical
// team via the Teams table. The candidate query interleaves `%` between input
// characters so punctuation in names is ignored (e.g. "geng" finds "Gen.G"),
// then a client-side priority picks the best match: exact name, exact tricode,
// punctuation-insensitive equality, shortest name containing the query, else
// the first candidate. Returns null when nothing matches.
export async function resolveTeam(
  game: EsportsGame,
  query: string,
): Promise<TeamRef | null> {
  const { host } = GAME_SOURCES[game];
  const q = query.trim();
  const lc = q.toLowerCase();
  const compactQ = compact(q);
  const esc = escapeSql(q);
  const ci = (s?: string) => (s ?? "").toLowerCase();
  const byNameLen = (a: CargoRow, b: CargoRow) =>
    (a.name ?? "").length - (b.name ?? "").length;
  const toRef = (r: CargoRow): TeamRef => ({
    name: r.name || q,
    short: r.short || "",
    region: r.region || "",
  });
  const fields = "T.Name=name,T.Short=short,T.Region=region";

  return cachedSingle(teamCache, `${host}:${lc}`, TEAM_TTL, async () => {
    // Precise pass first: exact name or tricode. Kept separate from the fuzzy
    // pass so a common tricode (e.g. "GEN", shared by multiple teams) isn't
    // crowded out of the row limit by the broad pattern below.
    const exact = await cargoQuery(host, {
      tables: "Teams=T",
      fields,
      where: `T.Name='${esc}' OR T.Short='${esc}'`,
      limit: "10",
    });
    const exactPick =
      exact.filter((r) => ci(r.name) === lc).sort(byNameLen)[0] ??
      exact.filter((r) => ci(r.short) === lc).sort(byNameLen)[0];
    if (exactPick) return toRef(exactPick);

    // Fuzzy pass: interleave `%` between characters so punctuation is ignored
    // ("geng" -> "Gen.G"). Prefer punctuation-insensitive equality, then the
    // shortest name containing the query.
    const loose = `%${[...q].map((c) => escapeLike(c)).join("%")}%`;
    const rows = await cargoQuery(host, {
      tables: "Teams=T",
      fields,
      where: `T.Name LIKE '${loose}'`,
      limit: "50",
    });
    if (rows.length === 0) return null;
    const pick =
      rows.filter((r) => compact(r.name ?? "") === compactQ).sort(byNameLen)[0] ??
      rows.filter((r) => ci(r.name).includes(lc)).sort(byNameLen)[0] ??
      rows[0]!;
    return toRef(pick);
  });
}

const teamSearchCache = new Map<string, CacheEntry<TeamRef[]>>();

// Search teams by partial name or tricode, for slash-command autocomplete.
// Returns up to `limit` matches, shortest names first. Cached per query; the
// caller should gate on a minimum query length to avoid a request per keystroke.
export async function searchTeams(
  game: EsportsGame,
  query: string,
  limit = 15,
): Promise<TeamRef[]> {
  const { host } = GAME_SOURCES[game];
  const q = query.trim();
  if (q.length < 2) return [];
  const lc = q.toLowerCase();
  return cachedSingle(teamSearchCache, `${host}:${lc}`, TEAM_TTL, async () => {
    const like = escapeLike(q);
    const rows = await cargoQuery(host, {
      tables: "Teams=T",
      fields: "T.Name=name,T.Short=short,T.Region=region",
      where: `T.Name LIKE '%${like}%' OR T.Short LIKE '%${like}%'`,
      order_by: "T.Name",
      limit: "30",
    });
    return rows
      .map((r) => ({
        name: r.name || "",
        short: r.short || "",
        region: r.region || "",
      }))
      .filter((t) => t.name)
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, limit);
  });
}

// Over-fetch games so a handful of full series are always captured; the command
// groups these into matches and shows the most recent few.
const TEAM_GAME_CAP = 30;
const teamStatsCache = new Map<string, CacheEntry<GameStats[]>>();

// Recent games for a team across all tournaments, newest first.
export async function getTeamRecentGames(
  game: EsportsGame,
  team: TeamRef,
): Promise<GameStats[]> {
  const { host } = GAME_SOURCES[game];
  return cachedSingle(teamStatsCache, `${host}:${team.name}`, SCHEDULE_TTL, async () => {
    const esc = escapeSql(team.name);
    const rows = await cargoQuery(host, {
      tables: "ScoreboardGames=SG,Tournaments=T",
      join_on: "SG.OverviewPage=T.OverviewPage",
      fields: STATS_FIELDS,
      where: `SG.Team1='${esc}' OR SG.Team2='${esc}'`,
      order_by: "SG.DateTime_UTC DESC",
      limit: String(TEAM_GAME_CAP),
    });
    return rows.map(toGameStats);
  });
}

// -- helpers ----------------------------------------------------------------

function escapeSql(value: string): string {
  return value.replace(/'/g, "\\'");
}

// Escape a value used inside a Cargo/SQL LIKE pattern: backslash, the `%`/`_`
// wildcards, and quotes, so user input can't inject wildcards or break out.
function escapeLike(value: string): string {
  return value.replace(/[\\%_']/g, (c) => `\\${c}`);
}

// Lowercase, alphanumerics only — for punctuation-insensitive name matching
// ("Gen.G" -> "geng", "T1" -> "t1").
function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toIso(dt: string | undefined): string {
  return dt ? `${dt.replace(" ", "T")}Z` : "";
}

function toMatch(r: CargoRow): Match {
  const score1 = Number(r.score1) || 0;
  const score2 = Number(r.score2) || 0;
  return {
    startTime: toIso(r.dt),
    team1: r.team1 || "TBD",
    team2: r.team2 || "TBD",
    score1,
    score2,
    bestOf: Number(r.bestOf) || 1,
    // A game already played but no overall series winner yet => in progress.
    live: !r.winner && score1 + score2 > 0,
    tournament: r.tournament || "",
    stream: r.stream || null,
  };
}
