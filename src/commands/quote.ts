import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  MessageReferenceType,
  SlashCommandBuilder,
  TextChannel,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { config } from "../utility/config.ts";
import { renderQuoteImage, type QuoteEntry } from "../utility/quote-image.ts";
import { log } from "../utility/log.ts";

// Accepts a bare id or a full message link, since copying the link is what
// Discord's UI offers on desktop.
const MESSAGE_LINK_PATTERN =
  /channels\/\d+\/(?<channelId>\d+)\/(?<messageId>\d+)/;

interface MessageAddress {
  channelId: string | null;
  messageId: string;
}

// Several ids or links can be given at once, separated however the quoter
// pasted them, so a handful of scattered messages can be collected into one
// quote without them having to be next to each other.
function parseMessageReferences(input: string): MessageAddress[] {
  const parts = input.split(/[\s,]+/).filter(Boolean);
  const addresses: MessageAddress[] = [];
  for (const part of parts) {
    const address = parseMessageReference(part);
    if (!address) return [];
    addresses.push(address);
  }
  return addresses;
}

function parseMessageReference(input: string): MessageAddress | null {
  const link = input.match(MESSAGE_LINK_PATTERN);
  if (link?.groups) {
    return {
      channelId: link.groups.channelId!,
      messageId: link.groups.messageId!,
    };
  }
  return /^\d+$/.test(input.trim())
    ? { channelId: null, messageId: input.trim() }
    : null;
}

export const data = new SlashCommandBuilder()
  .setName("quote")
  .setDescription("Put a message in the quotes channel.")
  .addStringOption((opt) =>
    opt
      .setName("message")
      .setDescription(
        "Message id or link. Several, separated by spaces, quotes them together.",
      )
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("to")
      .setDescription(
        "Last message of a conversation. Quotes everything from `message` to here.",
      ),
  )
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("Channel the message is in. Defaults to this one."),
  );

// A forwarded message carries the original's words in a snapshot but not its
// author — Discord leaves that out — so the forward is followed back to the
// real message. Replies are left alone: a reply is its own remark.
async function followForward(message: Message): Promise<Message | null> {
  if (message.reference?.type !== MessageReferenceType.Forward) return message;

  const { channelId, messageId } = message.reference;
  if (!messageId) return null;

  const originChannel = await message.client.channels
    .fetch(channelId)
    .catch(() => null);
  if (!originChannel?.isTextBased()) return null;

  return originChannel.messages.fetch(messageId).catch(() => null);
}

// Discord answers a channel the bot cannot see and a message that does not
// exist with different codes, and the difference is the whole diagnosis: one is
// a permission to fix, the other a bad id.
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === MISSING_ACCESS || code === MISSING_PERMISSIONS;
}

// A conversation is rendered as lines of dialogue, so it stays readable where
// a wall of separate embeds would not. Discord caps an embed description at
// 4096 characters; the rest is summarised rather than dropped silently.
const MAX_QUOTED_MESSAGES = 40;
// A message carries at most ten embeds, one of which is the quote itself.
const MAX_EXTRA_IMAGE_EMBEDS = 9;
const EMBED_COLOR = 0x5865f2;
const MAX_DESCRIPTION_CHARS = 3800;

// Forwards keep their words in a snapshot rather than in `content`.
function rawText(message: Message): string {
  if (message.content) return message.content;
  return message.messageSnapshots.first()?.content ?? "";
}

// A linked image is shown as a picture, so leaving its URL in the text would
// print the same thing twice, once as an unreadable line of characters.
function quotedText(message: Message): string {
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

function speakerName(message: Message): string {
  return message.member?.displayName ?? message.author.displayName;
}

async function fetchConversation(
  channel: TextBasedChannel,
  first: Message,
  lastId: string,
): Promise<Message[]> {
  const following = await channel.messages.fetch({
    after: first.id,
    limit: 100,
  });

  const conversation = [first];
  for (const message of [...following.values()].reverse()) {
    conversation.push(message);
    if (message.id === lastId) break;
  }
  return conversation;
}

function describeImages(imageUrls: string[]): string {
  if (imageUrls.length === 0) return "";
  return imageUrls.length === 1 ? "[image]" : `[${imageUrls.length} images]`;
}

function formatConversation(messages: Message[]): string {
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

function imageAttachmentUrls(message: Message): string[] {
  const uploaded = message.attachments
    .filter((attachment) => attachment.contentType?.startsWith("image/"))
    .map((attachment) => attachment.url);
  return [...uploaded, ...embeddedImageUrls(message)];
}

async function resolveMessage(
  interaction: ChatInputCommandInteraction,
  address: MessageAddress,
  defaultChannelId: string,
): Promise<Message | string> {
  const channelId = address.channelId ?? defaultChannelId;

  const channel = await interaction.client.channels
    .fetch(channelId)
    .catch((err) => (isPermissionError(err) ? "forbidden" : null));
  if (channel === "forbidden") {
    return `I can't see <#${channelId}>. Give me View Channel and Read Message History there.`;
  }
  if (!channel?.isTextBased()) return "I can't read that channel.";

  const found = await channel.messages
    .fetch(address.messageId)
    .catch((err) => (isPermissionError(err) ? "forbidden" : null));
  if (found === "forbidden") {
    return `I can't read messages in <#${channelId}>. Give me View Channel and Read Message History there.`;
  }
  if (!found) {
    return `I couldn't find message ${address.messageId}. If it's in another channel, pass \`channel\` or use the message link.`;
  }

  const original = await followForward(found);
  if (!original) {
    return "That's a forwarded message, and I can't reach the original to see who said it. Quote it with the original message's link instead.";
  }
  return original;
}

function quoteEntry(message: Message): QuoteEntry {
  return {
    speaker: speakerName(message),
    avatarUrl: message.author.displayAvatarURL({ extension: "png", size: 64 }),
    text: quotedText(message),
    imageUrls: imageAttachmentUrls(message),
  };
}

export async function execute(interaction: ChatInputCommandInteraction) {
  // Only the quoter sees the confirmation and any error; the quote itself is
  // the public part, and it lands in the quotes channel.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!config.quotesChannelId) {
    await interaction.editReply(
      "No quotes channel is configured. Set QUOTES_CHANNEL_ID first.",
    );
    return;
  }

  const input = interaction.options.getString("message", true);
  const addresses = parseMessageReferences(input);
  if (addresses.length === 0) {
    await interaction.editReply(
      `**${input}** isn't a message id or a message link.`,
    );
    return;
  }

  const lastInput = interaction.options.getString("to");
  if (lastInput && addresses.length > 1) {
    await interaction.editReply(
      "Use `to:` with a single starting message, or list the messages you want in `message:` instead.",
    );
    return;
  }

  const defaultChannelId =
    interaction.options.getChannel("channel")?.id ?? interaction.channelId;

  const picked: Message[] = [];
  for (const address of addresses) {
    const resolved = await resolveMessage(
      interaction,
      address,
      defaultChannelId,
    );
    if (typeof resolved === "string") {
      await interaction.editReply(resolved);
      return;
    }
    picked.push(resolved);
  }
  picked.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const message = picked[0]!;
  const lastAddress = lastInput ? parseMessageReference(lastInput) : null;
  if (lastInput && !lastAddress) {
    await interaction.editReply(
      `**${lastInput}** isn't a message id or a message link.`,
    );
    return;
  }
  if (lastAddress?.channelId && lastAddress.channelId !== message.channelId) {
    await interaction.editReply(
      "Both ends of a conversation have to be in the same channel.",
    );
    return;
  }

  const conversation = lastAddress
    ? await fetchConversation(message.channel, message, lastAddress.messageId)
    : picked;
  if (conversation.length > MAX_QUOTED_MESSAGES) {
    await interaction.editReply(
      `That's ${conversation.length} messages. Quote at most ${MAX_QUOTED_MESSAGES} at a time.`,
    );
    return;
  }

  const imageUrls = conversation.flatMap(imageAttachmentUrls);
  const text = quotedText(message);
  const body =
    conversation.length > 1
      ? formatConversation(conversation)
      : text
        ? `"${text}"`
        : "";
  if (!body.trim() && imageUrls.length === 0) {
    await interaction.editReply("That message has nothing to quote.");
    return;
  }

  const quotesChannel = await interaction.client.channels
    .fetch(config.quotesChannelId)
    .catch(() => null);
  if (!quotesChannel?.isTextBased() || !("send" in quotesChannel)) {
    await interaction.editReply(
      `I can't post in <#${config.quotesChannelId}>. Give me View Channel, Send Messages, and Embed Links there.`,
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTimestamp(message.createdAt)
    .setFooter({ text: `Quoted by ${interaction.user.displayName}` });

  // An image posted without a caption is the whole quote; empty quote marks
  // above it would just look like a mistake.
  if (body) embed.setDescription(body);

  // A single quote is attributed in the embed's author line; a conversation
  // names each speaker inline instead, since there is no one author.
  if (conversation.length === 1) {
    embed.setAuthor({
      name: speakerName(message),
      iconURL: message.author.displayAvatarURL(),
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
    if (body) embed.setDescription(null);
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
    ? [
        new AttachmentBuilder(transcript.buffer, {
          name: transcript.fileName,
        }),
      ]
    : [];

  const posted = await sendQuote(
    quotesChannel as TextChannel,
    embeds,
    files,
    message,
  );
  if (!posted) {
    await interaction.editReply(
      `I can't post in <#${config.quotesChannelId}>. Give me Send Messages and Embed Links there.`,
    );
    return;
  }

  log(
    "cmd",
    `/quote saved ${message.id} by ${message.author.tag} to #${(quotesChannel as TextChannel).name}`,
  );
  await interaction.editReply(`Quoted in ${posted.url}`);
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
