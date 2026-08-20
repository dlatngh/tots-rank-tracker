// Turning messages into a quote in the quotes channel. Shared by the /quote
// command and the right-click "Quote" action, which differ only in how they
// pick the messages.

import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageReferenceType,
  TextChannel,
  type Client,
  type Message,
  type User,
} from "discord.js";
import { config } from "./config.ts";
import { renderQuoteImage, type QuoteEntry } from "./quote-image.ts";
import { log } from "./log.ts";

export const MAX_QUOTED_MESSAGES = 40;
const MAX_EXTRA_IMAGE_EMBEDS = 9;
const MAX_DESCRIPTION_CHARS = 3800;
const EMBED_COLOR = 0x5865f2;

// Forwards keep their words in a snapshot rather than in `content`.
function rawText(message: Message): string {
  if (message.content) return message.content;
  return message.messageSnapshots.first()?.content ?? "";
}

// A linked image is shown as a picture, so leaving its URL in the text would
// print the same thing twice, once as an unreadable line of characters.
export function quotedText(message: Message): string {
  const linked = new Set(
    message.embeds.map((embed) => embed.url).filter(Boolean),
  );
  if (linked.size === 0) return rawText(message);

  return rawText(message)
    .split(/\s+/)
    .filter((word) => !linked.has(word))
    .join(" ")
    .trim();
}

export function speakerName(message: Message): string {
  return message.member?.displayName ?? message.author.displayName;
}

// Pictures reach a message two ways: uploaded as an attachment, or linked and
// unfurled by Discord into an embed (a Giphy or Tenor gif, an image URL). Both
// count as part of the quote.
function embeddedImageUrls(message: Message): string[] {
  const urls: string[] = [];
  for (const embed of message.embeds) {
    const url = embed.image?.url ?? embed.thumbnail?.url;
    if (url) urls.push(url);
  }
  return urls;
}

export function imageAttachmentUrls(message: Message): string[] {
  const uploaded = message.attachments
    .filter((attachment) => attachment.contentType?.startsWith("image/"))
    .map((attachment) => attachment.url);
  return [...uploaded, ...embeddedImageUrls(message)];
}

// A forwarded message carries the original's words in a snapshot but not its
// author — Discord leaves that out — so the forward is followed back to the
// real message. Replies are left alone: a reply is its own remark.
export async function followForward(
  message: Message,
): Promise<Message | null> {
  if (message.reference?.type !== MessageReferenceType.Forward) return message;

  const { channelId, messageId } = message.reference;
  if (!messageId) return null;

  const originChannel = await message.client.channels
    .fetch(channelId)
    .catch(() => null);
  if (!originChannel?.isTextBased()) return null;

  return originChannel.messages.fetch(messageId).catch(() => null);
}

function describeImages(imageUrls: string[]): string {
  if (imageUrls.length === 0) return "";
  return imageUrls.length === 1 ? "[image]" : `[${imageUrls.length} images]`;
}

// A conversation is rendered as lines of dialogue, so it stays readable where
// a wall of separate embeds would not. Discord caps an embed description at
// 4096 characters; the rest is summarised rather than dropped silently.
export function formatConversation(messages: Message[]): string {
  const lines: string[] = [];
  let length = 0;
  let lastSpeakerId: string | null = null;

  for (const message of messages) {
    const images = imageAttachmentUrls(message);
    // An image with no caption still belongs in the transcript, otherwise its
    // sender vanishes from a conversation they took part in.
    const text = quotedText(message) || describeImages(images);
    if (!text) continue;

    // Consecutive messages from one person read as one turn of dialogue.
    const line =
      message.author.id === lastSpeakerId
        ? text
        : `**${speakerName(message)}:** ${text}`;
    lastSpeakerId = message.author.id;

    const remaining = MAX_DESCRIPTION_CHARS - length;
    if (line.length > remaining) {
      // Keep as much of the line as fits rather than losing it wholesale, which
      // is what a single very long message would otherwise do.
      if (remaining > 0) lines.push(`${line.slice(0, remaining)}...`);
      else lines.push("...");
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

function quoteEntry(message: Message): QuoteEntry {
  return {
    speaker: speakerName(message),
    avatarUrl: message.author.displayAvatarURL({ extension: "png", size: 64 }),
    text: quotedText(message),
    imageUrls: imageAttachmentUrls(message),
  };
}

function sendQuote(
  channel: TextChannel,
  embeds: EmbedBuilder[],
  files: AttachmentBuilder[],
  source: Message,
): Promise<Message | null> {
  return channel
    .send({
      embeds,
      files,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 5, label: "Jump to message", url: source.url },
          ],
        },
      ],
    })
    .catch(() => null);
}

export interface QuoteOutcome {
  url?: string;
  error?: string;
}

export async function postQuote(
  client: Client,
  conversation: Message[],
  quotedBy: User,
): Promise<QuoteOutcome> {
  if (!config.quotesChannelId) {
    return { error: "No quotes channel is configured. Set QUOTES_CHANNEL_ID first." };
  }
  if (conversation.length === 0) return { error: "Nothing to quote." };

  const first = conversation[0]!;
  const imageUrls = conversation.flatMap(imageAttachmentUrls);
  const text = quotedText(first);
  const body =
    conversation.length > 1
      ? formatConversation(conversation)
      : text
        ? `"${text}"`
        : "";
  if (!body.trim() && imageUrls.length === 0) {
    return { error: "That message has nothing to quote." };
  }

  const quotesChannel = await client.channels
    .fetch(config.quotesChannelId)
    .catch(() => null);
  if (!quotesChannel?.isTextBased() || !("send" in quotesChannel)) {
    return {
      error: `I can't post in <#${config.quotesChannelId}>. Give me View Channel, Send Messages, and Embed Links there.`,
    };
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTimestamp(first.createdAt)
    .setFooter({ text: `Quoted by ${quotedBy.displayName}` });

  // An image posted without a caption is the whole quote; empty quote marks
  // above it would just look like a mistake.
  if (body) embed.setDescription(body);

  // A single quote is attributed in the embed's author line; a conversation
  // names each speaker inline instead, since there is no one author.
  if (conversation.length === 1) {
    embed.setAuthor({
      name: speakerName(first),
      iconURL: first.author.displayAvatarURL(),
    });
  }

  // Discord stacks every embed image below the text, so a conversation that
  // mixes words and pictures is drawn as one transcript instead, keeping it in
  // the order it happened. A quote with a single image needs no such help.
  const transcript =
    conversation.length > 1 && imageUrls.length > 0
      ? await renderQuoteImage(conversation.map(quoteEntry))
      : null;

  if (transcript) {
    embed.setImage(`attachment://${transcript.fileName}`);
  } else if (imageUrls[0]) {
    embed.setImage(imageUrls[0]);
  }

  const embeds = [
    embed,
    ...(transcript
      ? []
      : imageUrls
          .slice(1, 1 + MAX_EXTRA_IMAGE_EMBEDS)
          .map((url) => new EmbedBuilder().setColor(EMBED_COLOR).setImage(url))),
  ];
  const files = transcript
    ? [new AttachmentBuilder(transcript.buffer, { name: transcript.fileName })]
    : [];

  const posted = await sendQuote(
    quotesChannel as TextChannel,
    embeds,
    files,
    first,
  );
  if (!posted) {
    return {
      error: `I can't post in <#${config.quotesChannelId}>. Give me Send Messages and Embed Links there.`,
    };
  }

  log(
    "quote",
    `saved ${first.id} by ${first.author.tag} (${conversation.length} message(s))`,
  );
  return { url: posted.url };
}
