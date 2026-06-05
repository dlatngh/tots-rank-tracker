// Simple JSON-file persistence mapping a Discord user ID -> Riot PUUID.
// PUUIDs are stable across Riot ID changes, so storing them keeps the
// registration valid even if a player renames themselves.
// Writes are serialized to avoid races between concurrent interactions.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DATA_FILE = resolve(process.cwd(), "data", "registrations.json");

export type Division = "upper" | "lower";

export interface Registration {
  puuid: string;
  updatedAt: string;
  division?: Division;
}

type Store = Record<string, Registration>;

let writeQueue: Promise<void> = Promise.resolve();

async function read(): Promise<Store> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    return JSON.parse(raw) as Store;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function write(store: Store): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

export async function getRegistration(
  discordId: string,
): Promise<Registration | undefined> {
  const store = await read();
  return store[discordId];
}

export async function getAllRegistrations(): Promise<
  Array<{ discordId: string } & Registration>
> {
  const store = await read();
  return Object.entries(store).map(([discordId, r]) => ({ discordId, ...r }));
}

/**
 * Create or update the PUUID for a Discord user.
 * Division semantics:
 *   - undefined: preserve existing division (or none if new player)
 *   - "upper" | "lower": set to that division
 *   - null: explicitly clear (player no longer in the ranked race)
 */
export async function setRegistration(
  discordId: string,
  puuid: string,
  division?: Division | null,
): Promise<{ previous?: string }> {
  let previous: string | undefined;

  const task = writeQueue.then(async () => {
    const store = await read();
    const existing = store[discordId];
    previous = existing?.puuid;

    let nextDivision: Division | undefined;
    if (division === null) nextDivision = undefined;
    else if (division === undefined) nextDivision = existing?.division;
    else nextDivision = division;

    store[discordId] = {
      puuid,
      updatedAt: new Date().toISOString(),
      ...(nextDivision ? { division: nextDivision } : {}),
    };
    await write(store);
  });

  writeQueue = task.catch(() => {});
  await task;

  return { previous };
}

/**
 * Update only the division for a user. Returns the previous division (or
 * undefined). Throws if the user isn't registered.
 */
export async function setDivision(
  discordId: string,
  division: Division | null,
): Promise<{ previous?: Division }> {
  let previous: Division | undefined;
  let missing = false;

  const task = writeQueue.then(async () => {
    const store = await read();
    const existing = store[discordId];
    if (!existing) {
      missing = true;
      return;
    }
    previous = existing.division;
    store[discordId] = {
      ...existing,
      ...(division ? { division } : {}),
    };
    if (!division) delete store[discordId].division;
    await write(store);
  });

  writeQueue = task.catch(() => {});
  await task;

  if (missing) throw new Error("User not registered");
  return { previous };
}
