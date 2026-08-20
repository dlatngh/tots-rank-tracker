// Reads NeatQueue's queue message, which is the fastest signal that a game is
// about to start: NeatQueue edits it as people join and leave, so an edit
// arrives the moment the queue fills, well before its API shows a match.
//
// The count lives in an embed field name, e.g. "Queue 9/10". Message embeds are
// stripped from gateway events unless the application has the Message Content
// intent, so a message that arrives without them is refetched over REST, which
// is not gated.

import { Message, type PartialMessage } from "discord.js";

const QUEUE_FIELD_PATTERN = /^Queue (\d+)\/(\d+)$/;

export interface QueueCount {
  queued: number;
  capacity: number;
}

export function parseQueueCount(message: Message): QueueCount | null {
  for (const embed of message.embeds) {
    for (const field of embed.fields) {
      const match = field.name.match(QUEUE_FIELD_PATTERN);
      if (!match) continue;
      return { queued: Number(match[1]), capacity: Number(match[2]) };
    }
  }
  return null;
}

export async function readQueueCount(
  message: Message | PartialMessage,
): Promise<QueueCount | null> {
  const full = message.partial || message.embeds.length === 0
    ? await message.fetch().catch(() => null)
    : (message as Message);
  return full ? parseQueueCount(full) : null;
}
