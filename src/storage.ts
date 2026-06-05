// Simple JSON-file persistence mapping a Discord user ID -> Riot PUUID.
// PUUIDs are stable across Riot ID changes, so storing them keeps the
// registration valid even if a player renames themselves.
// Writes are serialized to avoid races between concurrent interactions.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DATA_FILE = resolve(process.cwd(), "data", "registrations.json");

export interface Registration {
  puuid: string;
  updatedAt: string;
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
  Array<{ discordId: string; puuid: string; updatedAt: string }>
> {
  const store = await read();
  return Object.entries(store).map(([discordId, r]) => ({
    discordId,
    ...r,
  }));
}

/**
 * Create or update the PUUID for a Discord user.
 * Returns the previous PUUID if one existed.
 */
export async function setRegistration(
  discordId: string,
  puuid: string,
): Promise<{ previous?: string }> {
  let previous: string | undefined;

  const task = writeQueue.then(async () => {
    const store = await read();
    previous = store[discordId]?.puuid;
    store[discordId] = { puuid, updatedAt: new Date().toISOString() };
    await write(store);
  });

  writeQueue = task.catch(() => {});
  await task;

  return { previous };
}
