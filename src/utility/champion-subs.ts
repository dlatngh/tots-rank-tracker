// Champion patch-change subscriptions: a many-to-many map of Discord users to
// the champions they follow. Stored as discordId -> championId[] (the per-user
// list is what the subscribe/unsubscribe/list commands read); the notifier
// inverts it once per patch. Writes are serialized like the other JSON stores.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SUBS_FILE = resolve(process.cwd(), "data", "champion-subs.json");

type SubsStore = Record<string, string[]>;

let writeQueue: Promise<void> = Promise.resolve();

async function read(): Promise<SubsStore> {
  try {
    const raw = await readFile(SUBS_FILE, "utf8");
    return JSON.parse(raw) as SubsStore;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function write(store: SubsStore): Promise<void> {
  await mkdir(dirname(SUBS_FILE), { recursive: true });
  await writeFile(SUBS_FILE, JSON.stringify(store, null, 2), "utf8");
}

export async function getSubscriptions(discordId: string): Promise<string[]> {
  const store = await read();
  return store[discordId] ?? [];
}

export async function getAllSubscriptions(): Promise<SubsStore> {
  return read();
}

export async function subscribe(
  discordId: string,
  championId: string,
): Promise<{ added: boolean }> {
  let added = false;

  const task = writeQueue.then(async () => {
    const store = await read();
    const current = store[discordId] ?? [];
    if (current.includes(championId)) return;
    store[discordId] = [...current, championId];
    added = true;
    await write(store);
  });

  writeQueue = task.catch(() => {});
  await task;

  return { added };
}

export async function unsubscribe(
  discordId: string,
  championId: string,
): Promise<{ removed: boolean }> {
  let removed = false;

  const task = writeQueue.then(async () => {
    const store = await read();
    const current = store[discordId] ?? [];
    if (!current.includes(championId)) return;
    const next = current.filter((id) => id !== championId);
    if (next.length > 0) store[discordId] = next;
    else delete store[discordId];
    removed = true;
    await write(store);
  });

  writeQueue = task.catch(() => {});
  await task;

  return { removed };
}
