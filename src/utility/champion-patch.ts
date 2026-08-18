// Champion patch-change notifier (bot side). The bot does NOT scrape or parse
// patch notes; a standalone watcher (scripts/patch-watcher.ts, run by cron)
// does that and POSTs the changed champions here via the webhook in
// patch-webhook.ts. This module owns only the Discord-specific half: dedup
// against the last handled patch, match changed champions to subscribers, and
// post the ping.

import { Client, EmbedBuilder } from "discord.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "./config.ts";
import { getAllSubscriptions } from "./champion-subs.ts";
import { championIconUrl } from "./riot.ts";
import { log, logError } from "./log.ts";

const STATE_FILE = resolve(process.cwd(), "data", "patch-state.json");
const MAX_SUMMARY_LENGTH = 400;
const MAX_EMBED_DESCRIPTION = 4096;

// Wire contract shared with the watcher (both ends agree on this JSON shape).
export interface ChangeSection {
  title: string;
  entries: string[];
}

export interface PatchChange {
  championId: string;
  championName: string;
  summary: string;
  // Absent from payloads sent by a watcher older than the detail-scraping one.
  sections?: ChangeSection[];
}

export interface PatchNotification {
  patch: string; // "26.16"
  url: string;
  changes: PatchChange[];
}

interface PatchState {
  lastNotifiedPatch?: string;
}

async function readState(): Promise<PatchState> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw) as PatchState;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function writeState(state: PatchState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export interface WatcherError {
  message: string;
}

export function isWatcherError(body: unknown): body is WatcherError {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).message === "string"
  );
}

export function isPatchNotification(body: unknown): body is PatchNotification {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.patch !== "string" || typeof candidate.url !== "string") {
    return false;
  }
  if (!Array.isArray(candidate.changes)) return false;
  return candidate.changes.every((change) => {
    const c = change as Record<string, unknown>;
    return (
      typeof c.championId === "string" &&
      typeof c.championName === "string" &&
      typeof c.summary === "string"
    );
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function buildChampionMessage(
  notification: PatchNotification,
  change: PatchChange,
  subscribers: string[],
  iconUrl: string,
): { content: string; embed: EmbedBuilder } {
  const mentions = subscribers.map((id) => `<@${id}>`).join(" ");
  const content = `**Patch ${notification.patch}** changed **${change.championName}**: ${mentions}`;

  const parts: string[] = [];
  if (change.summary) {
    parts.push(`> ${truncate(change.summary, MAX_SUMMARY_LENGTH)}`);
  }
  for (const section of change.sections ?? []) {
    const entries = section.entries.map((entry) => `- ${entry}`).join("\n");
    parts.push(`**${section.title}**\n${entries}`);
  }

  const description = parts.length
    ? truncate(parts.join("\n\n"), MAX_EMBED_DESCRIPTION)
    : "No change details were listed for this champion.";

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${change.championName} - Patch ${notification.patch}`)
    .setURL(notification.url)
    .setThumbnail(iconUrl)
    .setDescription(description);

  return { content, embed };
}

async function postNotifications(
  client: Client,
  notification: PatchNotification,
): Promise<void> {
  const subscriptions = await getAllSubscriptions();

  const affected: Array<{ change: PatchChange; subscribers: string[] }> = [];
  for (const change of notification.changes) {
    const subscribers = Object.entries(subscriptions)
      .filter(([, championIds]) => championIds.includes(change.championId))
      .map(([discordId]) => discordId);
    if (subscribers.length > 0) affected.push({ change, subscribers });
  }

  if (affected.length === 0) {
    log(
      "patch",
      `${notification.patch}: no subscribers for the ${notification.changes.length} changed champion(s)`,
    );
    return;
  }

  const channel = await client.channels.fetch(config.patchNotesChannelId);
  if (!channel?.isTextBased() || !("send" in channel)) {
    throw new Error(
      `configured channel ${config.patchNotesChannelId} is not a sendable text channel`,
    );
  }

  const notifiedUserIds = new Set<string>();
  for (const { change, subscribers } of affected) {
    const iconUrl = await championIconUrl(change.championId);
    const { content, embed } = buildChampionMessage(
      notification,
      change,
      subscribers,
      iconUrl,
    );
    await channel.send({
      content,
      embeds: [embed],
      allowedMentions: { users: subscribers },
    });
    for (const id of subscribers) notifiedUserIds.add(id);
  }

  log(
    "patch",
    `${notification.patch}: sent ${affected.length} champion message(s) to ${notifiedUserIds.size} user(s)`,
  );
}

// A persistent watcher failure (e.g. Riot down) would otherwise alert every
// cron cycle; suppress a repeat of the same message within this window. State
// is in-memory, so a bot restart re-arms it — acceptable for an ops alert.
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let lastAlert: { message: string; at: number } | null = null;

/** Post a patch-watcher failure to the alert channel, deduped by message. */
export async function reportWatcherFailure(
  client: Client,
  message: string,
): Promise<void> {
  const now = Date.now();
  if (
    lastAlert &&
    lastAlert.message === message &&
    now - lastAlert.at < ALERT_COOLDOWN_MS
  ) {
    log("patch", "suppressing repeat watcher alert");
    return;
  }

  const channelId = config.alertChannelId || config.patchNotesChannelId;
  if (!channelId) {
    logError("patch", "watcher failure but no alert channel configured:", message);
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("send" in channel)) {
    logError("patch", `alert channel ${channelId} is not a sendable text channel`);
    return;
  }

  const mentionedUserIds = config.alertMentionUserId
    ? [config.alertMentionUserId]
    : [];
  const mentionPrefix = config.alertMentionUserId
    ? `<@${config.alertMentionUserId}> `
    : "";

  await channel.send({
    content: `${mentionPrefix}**Patch watcher failed:** ${truncate(message, 1500)}`,
    allowedMentions: { users: mentionedUserIds },
  });
  lastAlert = { message, at: now };
  log("patch", "posted watcher failure alert");
}

export type PatchHandlerStatus = "seeded" | "duplicate" | "notified";

/**
 * Process a patch notification from the watcher. The first ever notification
 * just seeds the baseline (so we don't ping for an already-live patch on first
 * deploy); repeats of the current patch are ignored; a genuinely new patch fans
 * out to subscribers. State only advances after a successful post, so a failed
 * send is retried on the watcher's next run.
 */
export async function handlePatchNotification(
  client: Client,
  notification: PatchNotification,
): Promise<PatchHandlerStatus> {
  const state = await readState();

  if (!state.lastNotifiedPatch) {
    await writeState({ lastNotifiedPatch: notification.patch });
    log("patch", `seeded baseline at patch ${notification.patch}`);
    return "seeded";
  }

  if (notification.patch === state.lastNotifiedPatch) return "duplicate";

  await postNotifications(client, notification);
  await writeState({ lastNotifiedPatch: notification.patch });
  return "notified";
}
