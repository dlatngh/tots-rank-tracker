// In-server betting on custom games. Balances are a per-user tot count in a
// JSON store; a round lives in one channel at a time and holds every wager
// placed on it. Payouts are parimutuel: losing stakes are split among the
// winners in proportion to what they staked, so the bot never mints tots.
//
// Wagers are debited when placed, which makes the round itself the escrow: a
// cancelled round refunds, a resolved round pays out, and no other code path
// has to reason about tots that are "in play".

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BETTING_FILE = resolve(process.cwd(), "data", "betting.json");

export const CURRENCY_NAME = "tots";
export const STARTING_BALANCE = 1000;
export const WEEKLY_REFILL = 500;
const REFILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type BetTeam = "team1" | "team2";

export const TEAM_LABELS: Record<BetTeam, string> = {
  team1: "Team 1",
  team2: "Team 2",
};

export interface Wager {
  team: BetTeam;
  amount: number;
}

export interface BettingRound {
  channelId: string;
  guildId: string;
  startedBy: string;
  startedAt: string;
  locked: boolean;
  // One wager per user; adding to an existing wager grows its amount.
  wagers: Record<string, Wager>;
  // Every round is on a NeatQueue game, which is what lets it settle from
  // NeatQueue's recorded winner instead of someone's word.
  gameNumber: number;
  // Player names per team as NeatQueue reported them, in its team order, so
  // team1/team2 here mean the same sides NeatQueue shows.
  teamRosters: string[][];
  // Mean NeatQueue MMR per team when it was known at kick-off, which is what
  // the round shows as odds.
  teamMmr: Array<number | null>;
  // When the round should stop taking bets on its own. Set on rounds the bot
  // opened itself, since no one is around to run `/bet lock` for those.
  autoLockAt: string | null;
}

interface Account {
  balance: number;
  lastRefillAt: string | null;
  wins: number;
  losses: number;
  biggestWin: number;
  // Positive for a run of wins, negative for a run of losses.
  streak: number;
}

export interface BettorRecord {
  balance: number;
  wins: number;
  losses: number;
  biggestWin: number;
  streak: number;
}

interface BettingStore {
  accounts: Record<string, Account>;
  // Keyed by channel id: each channel can run one round at a time.
  rounds: Record<string, BettingRound>;
}

export class BettingError extends Error {}

let writeQueue: Promise<void> = Promise.resolve();

async function read(): Promise<BettingStore> {
  try {
    const raw = await readFile(BETTING_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<BettingStore>;
    return { accounts: parsed.accounts ?? {}, rounds: parsed.rounds ?? {} };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { accounts: {}, rounds: {} };
    throw err;
  }
}

async function write(store: BettingStore): Promise<void> {
  await mkdir(dirname(BETTING_FILE), { recursive: true });
  await writeFile(BETTING_FILE, JSON.stringify(store, null, 2), "utf8");
}

// Every mutation is a read-modify-write, so they are serialized against each
// other the way the other JSON stores in this bot are.
async function mutate<T>(
  change: (store: BettingStore) => T | Promise<T>,
): Promise<T> {
  let result: T;

  const task = writeQueue.then(async () => {
    const store = await read();
    result = await change(store);
    await write(store);
  });

  writeQueue = task.catch(() => {});
  await task;

  return result!;
}

function accountFor(store: BettingStore, discordId: string): Account {
  const existing = store.accounts[discordId];
  if (existing) return existing;

  const opened: Account = {
    balance: STARTING_BALANCE,
    lastRefillAt: null,
    wins: 0,
    losses: 0,
    biggestWin: 0,
    streak: 0,
  };
  store.accounts[discordId] = opened;
  return opened;
}

export async function getBalance(discordId: string): Promise<number> {
  const store = await read();
  return store.accounts[discordId]?.balance ?? STARTING_BALANCE;
}

function recordOf(account: Account): BettorRecord {
  return {
    balance: account.balance,
    wins: account.wins ?? 0,
    losses: account.losses ?? 0,
    biggestWin: account.biggestWin ?? 0,
    streak: account.streak ?? 0,
  };
}

export async function getRecord(discordId: string): Promise<BettorRecord> {
  const store = await read();
  const account = store.accounts[discordId];
  return account
    ? recordOf(account)
    : {
        balance: STARTING_BALANCE,
        wins: 0,
        losses: 0,
        biggestWin: 0,
        streak: 0,
      };
}

export async function getLeaderboard(): Promise<
  Array<{ discordId: string } & BettorRecord>
> {
  const store = await read();
  const standings = Object.entries(store.accounts).map(
    ([discordId, account]) => ({ discordId, ...recordOf(account) }),
  );
  standings.sort((a, b) => b.balance - a.balance);
  return standings;
}

export interface RefillResult {
  amount: number;
  balance: number;
}

export async function claimRefill(
  discordId: string,
  now: Date,
): Promise<RefillResult> {
  return mutate((store) => {
    const account = accountFor(store, discordId);
    if (account.lastRefillAt) {
      const elapsedMs = now.getTime() - Date.parse(account.lastRefillAt);
      if (elapsedMs < REFILL_INTERVAL_MS) {
        const nextRefillAt = new Date(
          Date.parse(account.lastRefillAt) + REFILL_INTERVAL_MS,
        );
        throw new BettingError(
          `You already claimed this week's refill. Next one <t:${Math.floor(nextRefillAt.getTime() / 1000)}:R>.`,
        );
      }
    }

    account.balance += WEEKLY_REFILL;
    account.lastRefillAt = now.toISOString();
    return { amount: WEEKLY_REFILL, balance: account.balance };
  });
}

export async function getRound(
  channelId: string,
): Promise<BettingRound | null> {
  const store = await read();
  return store.rounds[channelId] ?? null;
}

export interface RoundSetup {
  guildId: string;
  gameNumber: number;
  teamRosters: string[][];
  teamMmr?: Array<number | null>;
  autoLockAt?: Date;
}

export async function startRound(
  channelId: string,
  startedBy: string,
  now: Date,
  setup: RoundSetup,
): Promise<BettingRound> {
  return mutate((store) => {
    if (store.rounds[channelId]) {
      throw new BettingError(
        "There's already a betting round in this channel. Finish it with `/bet end` or drop it with `/bet cancel`.",
      );
    }
    const onSameGame = Object.values(store.rounds).find(
      (existing) => existing.gameNumber === setup.gameNumber,
    );
    if (onSameGame) {
      throw new BettingError(
        `Game #${setup.gameNumber} already has a round running in <#${onSameGame.channelId}>.`,
      );
    }

    const round: BettingRound = {
      channelId,
      guildId: setup.guildId,
      startedBy,
      startedAt: now.toISOString(),
      locked: false,
      wagers: {},
      gameNumber: setup.gameNumber,
      teamRosters: setup.teamRosters,
      teamMmr: setup.teamMmr ?? [],
      autoLockAt: setup.autoLockAt?.toISOString() ?? null,
    };
    store.rounds[channelId] = round;
    return round;
  });
}

function requireRound(
  store: BettingStore,
  channelId: string,
): BettingRound {
  const round = store.rounds[channelId];
  if (!round) {
    throw new BettingError(
      "No betting round is running in this channel. Start one with `/bet start`.",
    );
  }
  return round;
}

// Only the person who opened the round can steer it; server managers can step
// in so a round never gets stuck because its starter left.
function requireRoundControl(
  round: BettingRound,
  discordId: string,
  isServerManager: boolean,
): void {
  if (round.startedBy === discordId || isServerManager) return;
  throw new BettingError(
    `Only <@${round.startedBy}> or a server manager can do that.`,
  );
}

export interface PlaceBetResult {
  wager: Wager;
  balance: number;
}

export async function placeBet(
  channelId: string,
  discordId: string,
  team: BetTeam,
  amount: number,
): Promise<PlaceBetResult> {
  return mutate((store) => {
    const round = requireRound(store, channelId);
    if (round.locked) {
      throw new BettingError("Betting is locked for this round.");
    }

    const account = accountFor(store, discordId);
    if (amount > account.balance) {
      throw new BettingError(
        `You only have ${account.balance} ${CURRENCY_NAME}.`,
      );
    }

    const existing = round.wagers[discordId];
    if (existing && existing.team !== team) {
      throw new BettingError(
        `You're already on ${TEAM_LABELS[existing.team]} this round. You can add to that bet, but not switch sides.`,
      );
    }

    account.balance -= amount;
    const wager: Wager = {
      team,
      amount: (existing?.amount ?? 0) + amount,
    };
    round.wagers[discordId] = wager;

    return { wager, balance: account.balance };
  });
}

export async function lockRound(
  channelId: string,
  discordId: string,
  isServerManager: boolean,
): Promise<BettingRound> {
  return mutate((store) => {
    const round = requireRound(store, channelId);
    requireRoundControl(round, discordId, isServerManager);
    if (round.locked) {
      throw new BettingError("Betting is already locked for this round.");
    }
    round.locked = true;
    return round;
  });
}

export function poolFor(round: BettingRound, team: BetTeam): number {
  return Object.values(round.wagers)
    .filter((wager) => wager.team === team)
    .reduce((total, wager) => total + wager.amount, 0);
}

export interface Payout {
  discordId: string;
  stake: number;
  // What the bettor receives back: stake plus their cut of the losing pool.
  returned: number;
}

export interface RoundResult {
  winner: BetTeam | null;
  totalPool: number;
  payouts: Payout[];
  // True when stakes went back untouched because the round had no losing side
  // to pay the winners, or no winning side to pay.
  refunded: boolean;
}

// Parimutuel split: a winner gets their stake back plus a share of the losing
// pool proportional to what they staked. Division is floored, so a few tots
// can go unpaid rather than the bot inventing them.
function settle(round: BettingRound, winner: BetTeam): RoundResult {
  const winningPool = poolFor(round, winner);
  const losingPool = poolFor(round, winner === "team1" ? "team2" : "team1");
  const totalPool = winningPool + losingPool;

  if (winningPool === 0 || losingPool === 0) {
    const refunds = Object.entries(round.wagers).map(([discordId, wager]) => ({
      discordId,
      stake: wager.amount,
      returned: wager.amount,
    }));
    return { winner, totalPool, payouts: refunds, refunded: true };
  }

  const payouts: Payout[] = [];
  for (const [discordId, wager] of Object.entries(round.wagers)) {
    if (wager.team !== winner) {
      payouts.push({ discordId, stake: wager.amount, returned: 0 });
      continue;
    }
    const winnings = Math.floor((wager.amount / winningPool) * losingPool);
    payouts.push({
      discordId,
      stake: wager.amount,
      returned: wager.amount + winnings,
    });
  }

  return { winner, totalPool, payouts, refunded: false };
}

// A refunded round is not a result: nobody won or lost it, so records only
// move when tots actually changed hands.
function recordResult(account: Account, profit: number): void {
  if (profit > 0) {
    account.wins += 1;
    account.streak = account.streak > 0 ? account.streak + 1 : 1;
    account.biggestWin = Math.max(account.biggestWin, profit);
    return;
  }
  if (profit < 0) {
    account.losses += 1;
    account.streak = account.streak < 0 ? account.streak - 1 : -1;
  }
}

function payAndClose(
  store: BettingStore,
  round: BettingRound,
  winner: BetTeam,
): RoundResult {
  const result = settle(round, winner);
  for (const payout of result.payouts) {
    const account = accountFor(store, payout.discordId);
    account.balance += payout.returned;
    if (!result.refunded) {
      recordResult(account, payout.returned - payout.stake);
    }
  }
  delete store.rounds[round.channelId];
  return result;
}

export async function endRound(
  channelId: string,
  discordId: string,
  isServerManager: boolean,
  winner: BetTeam,
): Promise<RoundResult> {
  return mutate((store) => {
    const round = requireRound(store, channelId);
    requireRoundControl(round, discordId, isServerManager);
    return payAndClose(store, round, winner);
  });
}

// Settling on NeatQueue's recorded result, with no user to authorize it. Null
// when the round has already been closed by whoever got there first.
export async function settleRound(
  channelId: string,
  winner: BetTeam,
): Promise<RoundResult | null> {
  return mutate((store) => {
    const round = store.rounds[channelId];
    if (!round) return null;
    return payAndClose(store, round, winner);
  });
}

// Locking on the round's own timer, with no user to authorize it. Null when
// the round is already locked or gone.
export async function autoLockRound(
  channelId: string,
): Promise<BettingRound | null> {
  return mutate((store) => {
    const round = store.rounds[channelId];
    if (!round || round.locked) return null;
    round.locked = true;
    return round;
  });
}

export function isAutoLockDue(round: BettingRound, now: Date): boolean {
  if (round.locked || !round.autoLockAt) return false;
  return now.getTime() >= Date.parse(round.autoLockAt);
}

export async function getOpenRounds(): Promise<BettingRound[]> {
  const store = await read();
  return Object.values(store.rounds);
}

function refundAndClose(
  store: BettingStore,
  round: BettingRound,
): RoundResult {
  const refunds = Object.entries(round.wagers).map(([bettorId, wager]) => ({
    discordId: bettorId,
    stake: wager.amount,
    returned: wager.amount,
  }));
  for (const refund of refunds) {
    accountFor(store, refund.discordId).balance += refund.returned;
  }
  delete store.rounds[round.channelId];

  return {
    winner: null,
    totalPool: refunds.reduce((total, refund) => total + refund.stake, 0),
    payouts: refunds,
    refunded: true,
  };
}

export async function cancelRound(
  channelId: string,
  discordId: string,
  isServerManager: boolean,
): Promise<RoundResult> {
  return mutate((store) => {
    const round = requireRound(store, channelId);
    requireRoundControl(round, discordId, isServerManager);
    return refundAndClose(store, round);
  });
}

// Refunding because NeatQueue cancelled the game, with no user to authorize it.
// Null when the round has already been closed by whoever got there first.
export async function refundRound(
  channelId: string,
): Promise<RoundResult | null> {
  return mutate((store) => {
    const round = store.rounds[channelId];
    if (!round) return null;
    return refundAndClose(store, round);
  });
}
