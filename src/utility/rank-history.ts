// Daily solo/duo rank snapshots, used to show LP movement ("+32 today") on the
// /lol command. One snapshot per player per calendar day is recorded at local
// midnight (with a catch-up run on startup). "Today's delta" is the player's
// current LP minus the snapshot taken at the start of the day.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { log, logError } from "./log.ts";
import {
  cumulativeSoloLp,
  getRank,
  invalidateRank,
  type GameRank,
} from "./riot.ts";
import { getAllRegistrations } from "./storage.ts";

const HISTORY_FILE = resolve(process.cwd(), "data", "rank-history.json");
const MAX_SNAPSHOTS_PER_PLAYER = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RankSnapshot {
  date: string; // local calendar day, "YYYY-MM-DD"
  tier: string | null;
  division: string | null;
  points: number;
  cumulativeLp: number | null;
}

type HistoryStore = Record<string, RankSnapshot[]>;

export interface LpDelta {
  amount: number;
  since: "today" | "recent";
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function read(): Promise<HistoryStore> {
  try {
    const raw = await readFile(HISTORY_FILE, "utf8");
    return JSON.parse(raw) as HistoryStore;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function write(store: HistoryStore): Promise<void> {
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(store, null, 2), "utf8");
}

function snapshotFromRank(date: string, rank: GameRank): RankSnapshot {
  return {
    date,
    tier: rank.tier,
    division: rank.division,
    points: rank.points,
    cumulativeLp: cumulativeSoloLp(rank),
  };
}

/**
 * Record a start-of-day solo/duo snapshot for every registered player who
 * doesn't already have one dated today. Idempotent per calendar day, so it is
 * safe to call on every startup and on each midnight tick without duplicating
 * work or spamming the Riot API.
 */
export async function recordDailySnapshots(): Promise<void> {
  const today = localDateKey(new Date());
  const registrations = await getAllRegistrations();
  const store = await read();

  const pending = registrations.filter((reg) => {
    const snapshots = store[reg.puuid];
    return !snapshots?.some((snapshot) => snapshot.date === today);
  });

  if (pending.length === 0) {
    log("snapshot", `all ${registrations.length} players already snapshotted for ${today}`);
    return;
  }

  log("snapshot", `recording ${pending.length} snapshot(s) for ${today}`);

  const results = await Promise.allSettled(
    pending.map(async (reg) => {
      // Force a fresh fetch so the baseline reflects the rank at day start
      // rather than a possibly hours-old cached value.
      invalidateRank(reg.puuid, "lol");
      const rank = await getRank(reg.puuid, "lol", {
        gameName: reg.gameName,
        tagLine: reg.tagLine,
      });
      return { puuid: reg.puuid, rank };
    }),
  );

  let recorded = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { puuid, rank } = result.value;
    const snapshots = store[puuid] ?? [];
    snapshots.push(snapshotFromRank(today, rank));
    store[puuid] = snapshots.slice(-MAX_SNAPSHOTS_PER_PLAYER);
    recorded++;
  }

  if (recorded > 0) await write(store);
  log("snapshot", `recorded ${recorded}/${pending.length} snapshot(s)`);
}

// Baseline for "today's delta" is the snapshot recorded at the start of today.
// When the bot was down at midnight and no snapshot exists for today, fall back
// to the most recent earlier snapshot (labelled "recent") so a delta still
// shows, just against a fuzzier starting point.
function deltaFromSnapshots(
  snapshots: RankSnapshot[] | undefined,
  currentLp: number,
  today: string,
): LpDelta | null {
  if (!snapshots?.length) return null;

  const todaySnapshot = snapshots.find((snapshot) => snapshot.date === today);
  const baseline =
    todaySnapshot ??
    [...snapshots].reverse().find((snapshot) => snapshot.date < today);

  if (!baseline || baseline.cumulativeLp === null) return null;

  return {
    amount: currentLp - baseline.cumulativeLp,
    since: todaySnapshot ? "today" : "recent",
  };
}

/**
 * Current solo/duo LP minus the start-of-today baseline. Returns null when
 * there's no baseline yet or the player is unranked.
 */
export async function getSoloLpDelta(
  puuid: string,
  currentRank: GameRank,
): Promise<LpDelta | null> {
  const currentLp = cumulativeSoloLp(currentRank);
  if (currentLp === null) return null;

  const store = await read();
  return deltaFromSnapshots(store[puuid], currentLp, localDateKey(new Date()));
}

/**
 * Batch variant of {@link getSoloLpDelta} for the leaderboard: reads the history
 * file once and returns a puuid -> delta map, skipping unranked players and
 * those without a baseline.
 */
export async function getSoloLpDeltaMap(
  entries: Array<{ puuid: string; rank: GameRank }>,
): Promise<Map<string, LpDelta>> {
  const store = await read();
  const today = localDateKey(new Date());
  const deltas = new Map<string, LpDelta>();

  for (const { puuid, rank } of entries) {
    const currentLp = cumulativeSoloLp(rank);
    if (currentLp === null) continue;
    const delta = deltaFromSnapshots(store[puuid], currentLp, today);
    if (delta) deltas.set(puuid, delta);
  }

  return deltas;
}

/** Drop a player's snapshot history (used when they're removed from tracking). */
export async function deleteRankHistory(puuid: string): Promise<void> {
  const store = await read();
  if (!(puuid in store)) return;
  delete store[puuid];
  await write(store);
}

function msUntilNextLocalMidnight(): number {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 5, 0); // 00:00:05 the following day
  return nextMidnight.getTime() - now.getTime();
}

/**
 * Kick off the daily snapshot loop: a catch-up run now, then one at each local
 * midnight. Errors are logged, never thrown, so a single failed night can't
 * crash the bot.
 */
export function startDailySnapshotScheduler(): void {
  const run = () =>
    recordDailySnapshots().catch((err) =>
      logError("snapshot", "daily snapshot run failed:", err),
    );

  run();
  setTimeout(() => {
    run();
    setInterval(run, DAY_MS);
  }, msUntilNextLocalMidnight());
}
