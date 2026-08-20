import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import {
  followForward,
  MAX_QUOTED_MESSAGES,
  postQuote,
} from "../utility/quote-post.ts";

// Accepts a bare id or a full message link, since copying the link is what
// Discord's UI offers on desktop.
const MESSAGE_LINK_PATTERN =
  /channels\/\d+\/(?<channelId>\d+)\/(?<messageId>\d+)/;

interface MessageAddress {
  channelId: string | null;
  messageId: string;
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

// Discord answers a channel the bot cannot see and a message that does not
// exist with different codes, and the difference is the whole diagnosis: one is
// a permission to fix, the other a bad id.
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === MISSING_ACCESS || code === MISSING_PERMISSIONS;
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

export async function execute(interaction: ChatInputCommandInteraction) {
  // Only the quoter sees the confirmation and any error; the quote itself is
  // the public part, and it lands in the quotes channel.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

  const first = picked[0]!;
  const lastAddress = lastInput ? parseMessageReference(lastInput) : null;
  if (lastInput && !lastAddress) {
    await interaction.editReply(
      `**${lastInput}** isn't a message id or a message link.`,
    );
    return;
  }
  if (lastAddress?.channelId && lastAddress.channelId !== first.channelId) {
    await interaction.editReply(
      "Both ends of a conversation have to be in the same channel.",
    );
    return;
  }

  const conversation = lastAddress
    ? await fetchConversation(first.channel, first, lastAddress.messageId)
    : picked;
  if (conversation.length > MAX_QUOTED_MESSAGES) {
    await interaction.editReply(
      `That's ${conversation.length} messages. Quote at most ${MAX_QUOTED_MESSAGES} at a time.`,
    );
    return;
  }

  const outcome = await postQuote(
    interaction.client,
    conversation,
    interaction.user,
  );
  await interaction.editReply(
    outcome.url ? `Quoted in ${outcome.url}` : outcome.error!,
  );
}
