// Client for OP.GG's public MCP server, the source for champion meta stats
// (win/pick/ban rates) that Riot's own API does not expose. It speaks JSON-RPC
// over streamable HTTP and needs no API key.
//
// Responses are not plain JSON: the server emits a compact positional encoding
// that declares field names once as `class` headers and then nests constructor
// calls, e.g.
//
//   class AverageStats: play,win_rate,pick_rate
//   Root(Summary(AverageStats(26288,0.48,0.02)))
//
// decodeCompactPayload turns that back into ordinary objects.

import { log, logError } from "./log.ts";

const MCP_ENDPOINT = "https://mcp-api.op.gg/mcp";
const PROTOCOL_VERSION = "2025-06-18";

export type LanePosition = "top" | "jungle" | "mid" | "adc" | "support";

export const LANE_CHOICES: Array<{ name: string; value: LanePosition }> = [
  { name: "Top", value: "top" },
  { name: "Jungle", value: "jungle" },
  { name: "Mid", value: "mid" },
  { name: "ADC", value: "adc" },
  { name: "Support", value: "support" },
];

// OP.GG returns lane names upper-cased ("MID"); render them the way the slash
// command choices present them.
export function laneLabel(lane: string): string {
  const choice = LANE_CHOICES.find(
    (candidate) => candidate.value === lane.toLowerCase(),
  );
  return choice?.name ?? lane;
}

interface JsonRpcResponse {
  error?: { message: string };
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

let sessionPromise: Promise<string> | null = null;

async function openSession(): Promise<string> {
  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "racker", version: "1.0" },
      },
    }),
  });

  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("OP.GG MCP did not return a session id");
  }
  log("opgg", `session opened (${sessionId.slice(0, 8)}...)`);
  return sessionId;
}

function sessionId(): Promise<string> {
  if (!sessionPromise) {
    sessionPromise = openSession().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

// The server may reply as either JSON or an SSE stream depending on the call,
// so strip any `data: ` framing and take the first JSON object.
function parseRpcBody(body: string): JsonRpcResponse {
  const unframed = body.replace(/^data: /gm, "").trim();
  const jsonLine = unframed
    .split("\n")
    .find((line) => line.trim().startsWith("{"));
  if (!jsonLine) {
    throw new Error("OP.GG MCP returned an unreadable response");
  }
  return JSON.parse(jsonLine) as JsonRpcResponse;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const send = async (): Promise<Response> =>
    fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": await sessionId(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });

  const startedAt = Date.now();
  const callSummary = `${name}(${describeArgs(args)})`;
  log("opgg", `-> ${callSummary}`);

  let response = await send();
  // A dropped session shows up as a 4xx; re-initialize once before giving up.
  if (response.status === 400 || response.status === 404) {
    log("opgg", `session rejected (${response.status}); reopening and retrying`);
    sessionPromise = null;
    response = await send();
  }

  const body = await response.text();
  const parsed = parseRpcBody(body);
  const elapsedMs = Date.now() - startedAt;

  if (parsed.error) {
    logError("opgg", `<- ${callSummary} failed in ${elapsedMs}ms:`, parsed.error.message);
    throw new Error(`OP.GG MCP rejected ${name}: ${parsed.error.message}`);
  }
  const text = parsed.result?.content?.[0]?.text;
  if (!text) {
    logError("opgg", `<- ${callSummary} returned no content in ${elapsedMs}ms`);
    throw new Error(`OP.GG MCP returned no content for ${name}`);
  }

  log(
    "opgg",
    `<- ${callSummary} ${response.status} in ${elapsedMs}ms (${body.length}B raw, ${text.length}B payload)`,
  );
  return text;
}

// Compact one-line rendering of the arguments so a log line stays scannable
// even though desired_output_fields can be a dozen entries long.
function describeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "desired_output_fields" && Array.isArray(value)) {
      parts.push(`fields:${value.length}`);
      continue;
    }
    parts.push(`${key}:${value}`);
  }
  return parts.join(" ");
}

// The esports and Valorant tools answer with ordinary JSON rather than the
// compact class encoding the champion and summoner tools use.
async function callToolJson<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callTool(name, args)) as T;
}

type CompactValue = unknown;

function classFieldNames(payload: string): Map<string, string[]> {
  const fieldsByClass = new Map<string, string[]>();
  for (const line of payload.split("\n")) {
    const header = line.match(/^class (\w+): (.+)$/);
    if (header) {
      fieldsByClass.set(header[1]!, header[2]!.split(","));
    }
  }
  return fieldsByClass;
}

// Recursive-descent reader over a single compact expression. Cursor is carried
// in a closure so each parse helper can advance it.
function decodeExpression(
  expression: string,
  fieldsByClass: Map<string, string[]>,
): CompactValue {
  let cursor = 0;

  const skipWhitespace = () => {
    while (cursor < expression.length && /\s/.test(expression[cursor]!)) {
      cursor += 1;
    }
  };

  const readString = (): string => {
    cursor += 1; // opening quote
    let value = "";
    while (cursor < expression.length && expression[cursor] !== '"') {
      if (expression[cursor] === "\\") cursor += 1;
      value += expression[cursor];
      cursor += 1;
    }
    cursor += 1; // closing quote
    return value;
  };

  const readScalar = (): CompactValue => {
    const start = cursor;
    while (cursor < expression.length && !",)]".includes(expression[cursor]!)) {
      cursor += 1;
    }
    const raw = expression.slice(start, cursor).trim();
    if (raw === "None" || raw === "null" || raw === "") return null;
    if (raw === "True") return true;
    if (raw === "False") return false;
    const asNumber = Number(raw);
    return Number.isNaN(asNumber) ? raw : asNumber;
  };

  const readValue = (): CompactValue => {
    skipWhitespace();
    const character = expression[cursor];

    if (character === '"') return readString();

    if (character === "[") {
      cursor += 1;
      const items: CompactValue[] = [];
      skipWhitespace();
      while (expression[cursor] !== "]") {
        items.push(readValue());
        skipWhitespace();
        if (expression[cursor] === ",") cursor += 1;
        skipWhitespace();
      }
      cursor += 1;
      return items;
    }

    const identifier = expression.slice(cursor).match(/^(\w+)\(/);
    if (identifier) {
      const className = identifier[1]!;
      cursor += identifier[0]!.length;
      const positionalValues: CompactValue[] = [];
      skipWhitespace();
      while (expression[cursor] !== ")") {
        positionalValues.push(readValue());
        skipWhitespace();
        if (expression[cursor] === ",") cursor += 1;
        skipWhitespace();
      }
      cursor += 1;

      const fieldNames = fieldsByClass.get(className) ?? [];
      const decoded: Record<string, CompactValue> = {};
      fieldNames.forEach((fieldName, index) => {
        decoded[fieldName] = positionalValues[index] ?? null;
      });
      return decoded;
    }

    return readScalar();
  };

  return readValue();
}

export function decodeCompactPayload(payload: string): CompactValue {
  const fieldsByClass = classFieldNames(payload);
  const expression = payload
    .split("\n")
    .filter((line) => !line.startsWith("class ") && line.trim())
    .join("");
  return decodeExpression(expression, fieldsByClass);
}

// OP.GG identifies champions by the display name upper-snake-cased, with
// punctuation collapsed: "Rek'Sai" -> REK_SAI, "Nunu & Willump" -> NUNU_WILLUMP.
export function toOpggChampionName(displayName: string): string {
  return displayName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// OP.GG reports rates as fractions rounded to two decimals, so anything under
// half a percent arrives as a flat 0. Show that as "<1%" rather than "0%",
// which would read as "never banned".
export function formatRate(rate: number): string {
  if (rate === 0) return "<1%";
  return `${Math.round(rate * 100)}%`;
}

// OP.GG grades champions 0 (its "OP" bucket) through 5. Six tiers, so the
// letter scale stops at E; there is no seventh tier to call F.
const TIER_GRADES = ["S", "A", "B", "C", "D", "E"] as const;

export function tierGrade(tier: number): string {
  return TIER_GRADES[tier] ?? `${tier}`;
}

export interface CounterMatchup {
  championName: string;
  championWinRate: number;
  games: number;
}

export interface ChampionRates {
  games: number;
  winRate: number;
  pickRate: number;
  banRate: number;
  kda: number;
  tier: number;
  rank: number;
}

export interface LaneRates extends ChampionRates {
  lane: LanePosition;
  // Share of this champion's games played in this lane.
  roleRate: number;
}

export interface ChampionMetaStats {
  patch: string;
  overall: ChampionRates;
  lanes: LaneRates[];
  // The lane the matchups and lane rates below describe. Null when the
  // requested lane has too few games to appear in OP.GG's breakdown.
  selectedLane: LaneRates | null;
  strongAgainst: CounterMatchup[];
  weakAgainst: CounterMatchup[];
}

interface AverageStats {
  play: number;
  win_rate: number;
  pick_rate: number;
  ban_rate: number;
  kda: number;
  tier: number;
  rank: number;
}

// `position` only selects which builds/counters the server computes; the
// summary stats it returns are champion-wide, so any valid lane works as a
// probe and the champion's real primary lane comes back in `positions`.
const PROBE_LANE: LanePosition = "mid";

const COUNTER_FIELDS = [
  "data.strong_counters[].{champion_name,my_win_rate,play}",
  "data.weak_counters[].{champion_name,my_win_rate,play}",
];

function decodeCounters(raw: unknown): CounterMatchup[] {
  const entries = (raw ?? []) as Array<Record<string, any>>;
  return entries.map((entry) => ({
    championName: entry.champion_name,
    championWinRate: entry.my_win_rate,
    games: entry.play,
  }));
}

async function analyzeChampion(
  opggName: string,
  lane: LanePosition,
  fields: string[],
): Promise<any> {
  const payload = await callTool("lol_get_champion_analysis", {
    champion: opggName,
    position: lane,
    game_mode: "ranked",
    desired_output_fields: fields,
  });
  return decodeCompactPayload(payload);
}

// `lane` narrows the matchup data and lane rates to that lane; omit it to use
// whichever lane the champion is most played in.
export async function getChampionMetaStats(
  displayName: string,
  lane?: LanePosition,
): Promise<ChampionMetaStats | null> {
  const opggName = toOpggChampionName(displayName);
  const queryLane = lane ?? PROBE_LANE;
  const decoded = await analyzeChampion(opggName, queryLane, [
    "data.summary.average_stats.{play,win_rate,pick_rate,ban_rate,kda,tier,rank}",
    "data.summary.positions[].name",
    "data.summary.positions[].stats.{play,win_rate,pick_rate,role_rate,ban_rate,kda}",
    "data.summary.positions[].stats.tier_data.{tier,rank}",
    "data.trends.win.version",
    ...COUNTER_FIELDS,
  ]);

  const averageStats = decoded?.data?.summary?.average_stats as
    | AverageStats
    | undefined;
  if (!averageStats) {
    logError("opgg", `no summary stats in response for ${displayName}`);
    return null;
  }

  const lanes = decodeLanes(decoded?.data?.summary?.positions);
  log(
    "opgg",
    `${opggName}: patch ${decoded?.data?.trends?.win?.version ?? "?"}, ` +
      `${averageStats.play} games overall, lanes [${lanes.map((entry) => entry.lane).join(", ") || "none"}]`,
  );
  const selectedLane =
    (lane ? lanes.find((entry) => entry.lane === lane) : lanes[0]) ?? null;

  // Matchups are only computed for the lane queried, so a champion whose main
  // lane is not the probe lane needs a second call to get its counters.
  let counterSource = decoded;
  const needsPrimaryLaneCall =
    !lane && selectedLane && selectedLane.lane !== queryLane;
  if (needsPrimaryLaneCall) {
    log(
      "opgg",
      `${opggName}: probed ${queryLane} but main lane is ${selectedLane.lane}; refetching matchups`,
    );
    counterSource = await analyzeChampion(
      opggName,
      selectedLane.lane,
      COUNTER_FIELDS,
    );
  }

  return {
    patch: decoded?.data?.trends?.win?.version ?? "current patch",
    overall: {
      games: averageStats.play,
      winRate: averageStats.win_rate,
      pickRate: averageStats.pick_rate,
      banRate: averageStats.ban_rate,
      kda: averageStats.kda,
      tier: averageStats.tier,
      rank: averageStats.rank,
    },
    lanes,
    selectedLane,
    strongAgainst: decodeCounters(counterSource?.data?.strong_counters),
    weakAgainst: decodeCounters(counterSource?.data?.weak_counters),
  };
}

function decodeLanes(raw: unknown): LaneRates[] {
  const positions = (raw ?? []) as Array<Record<string, any>>;
  const lanes: LaneRates[] = [];

  for (const position of positions) {
    const stats = position.stats;
    if (!stats) continue;
    lanes.push({
      lane: String(position.name).toLowerCase() as LanePosition,
      games: stats.play,
      winRate: stats.win_rate,
      pickRate: stats.pick_rate,
      banRate: stats.ban_rate,
      roleRate: stats.role_rate,
      kda: stats.kda,
      tier: stats.tier_data?.tier ?? 0,
      rank: stats.tier_data?.rank ?? 0,
    });
  }
  return lanes;
}

export interface LaneMetaEntry {
  champion: string;
  winRate: number;
  pickRate: number;
  banRate: number;
  games: number;
  tier: number;
  rank: number;
}

export async function getLaneMeta(
  lane: LanePosition,
): Promise<LaneMetaEntry[]> {
  const payload = await callTool("lol_list_lane_meta_champions", {
    position: lane,
    desired_output_fields: [
      `data.positions.${lane}[].{champion,win_rate,pick_rate,ban_rate,play,tier,rank}`,
    ],
  });

  const decoded = decodeCompactPayload(payload) as any;
  const entries = (decoded?.data?.positions?.[lane] ?? []) as Array<
    Record<string, any>
  >;

  log("opgg", `${lane} meta: ${entries.length} champion(s)`);

  return entries.map((entry) => ({
    champion: entry.champion,
    winRate: entry.win_rate,
    pickRate: entry.pick_rate,
    banRate: entry.ban_rate,
    games: entry.play,
    tier: entry.tier,
    rank: entry.rank,
  }));
}

// -- Esports schedules ------------------------------------------------------
//
// Fallback source for the esports commands when Leaguepedia is throttled or
// down. OP.GG covers LoL only, which is all the bot has leagues configured for.

export interface OpggEsportsTeam {
  name: string;
  acronym: string;
  image_url: string;
}

export interface OpggEsportsMatch {
  id: number;
  name: string;
  status: string; // NOT_STARTED | FINISHED | (in-progress states)
  homeScore: number;
  awayScore: number;
  scheduledAt: string; // ISO 8601 UTC
  numberOfGames: number;
  league: string;
  details: string;
  // Null until a bracket slot is filled.
  homeTeam: OpggEsportsTeam | null;
  awayTeam: OpggEsportsTeam | null;
}

export interface EsportsScheduleQuery {
  mode: "schedule" | "result";
  league?: string;
  teamName?: string;
  limit?: number;
}

export async function getEsportsSchedule(
  query: EsportsScheduleQuery,
): Promise<OpggEsportsMatch[]> {
  const args: Record<string, unknown> = { mode: query.mode };
  if (query.league) args.league = query.league;
  if (query.teamName) args.team_name = query.teamName;
  if (query.mode === "result" && query.limit) args.limit = query.limit;

  const matches = await callToolJson<OpggEsportsMatch[]>(
    "lol_esports_list_schedules",
    args,
  );
  log(
    "opgg",
    `esports ${query.mode}: ${matches.length} match(es)` +
      `${query.league ? ` for ${query.league}` : ""}${query.teamName ? ` for ${query.teamName}` : ""}`,
  );
  return matches;
}

// -- Summoner profile -------------------------------------------------------
//
// Supplements the Riot-sourced rank embed with data Riot does not expose in one
// call: regional ladder position, season champion pool, and flex rank.

export interface SummonerChampion {
  championName: string;
  games: number;
  wins: number;
}

export interface SummonerLadder {
  rank: number;
  total: number;
}

export interface SummonerQueueRank {
  tier: string;
  division: number | null;
  lp: number | null;
}

export interface SummonerProfile {
  ladder: SummonerLadder | null;
  championPool: SummonerChampion[];
  flexRank: SummonerQueueRank | null;
}

const FLEX_QUEUE = "FLEXRANKED";

export async function getSummonerProfile(
  gameName: string,
  tagLine: string,
  region: string,
): Promise<SummonerProfile> {
  const payload = await callTool("lol_get_summoner_profile", {
    game_name: gameName,
    tag_line: tagLine,
    region,
    desired_output_fields: [
      "data.summoner.ladder_rank.{rank,total}",
      "data.summoner.ranked_most_champions.my_champion_stats[].{champion_name,play,win,lose}",
      "data.summoner.league_stats[].game_type",
      "data.summoner.league_stats[].tier_info.{tier,division,lp}",
    ],
  });

  const decoded = decodeCompactPayload(payload) as any;
  const summoner = decoded?.data?.summoner;

  const championStats = (summoner?.ranked_most_champions?.my_champion_stats ??
    []) as Array<Record<string, any>>;
  const championPool = championStats.map((champion) => ({
    championName: champion.champion_name,
    games: champion.play,
    wins: champion.win,
  }));

  const leagueStats = (summoner?.league_stats ?? []) as Array<
    Record<string, any>
  >;
  const flexEntry = leagueStats.find(
    (entry) => entry.game_type === FLEX_QUEUE && entry.tier_info?.tier,
  );

  const ladderRank = summoner?.ladder_rank;

  log(
    "opgg",
    `${gameName}#${tagLine}: ${championPool.length} champion(s), ladder ${ladderRank?.rank ?? "?"}, flex ${flexEntry?.tier_info?.tier ?? "none"}`,
  );

  return {
    ladder:
      ladderRank?.rank && ladderRank?.total
        ? { rank: ladderRank.rank, total: ladderRank.total }
        : null,
    championPool,
    flexRank: flexEntry
      ? {
          tier: flexEntry.tier_info.tier,
          division: flexEntry.tier_info.division ?? null,
          lp: flexEntry.tier_info.lp ?? null,
        }
      : null,
  };
}
