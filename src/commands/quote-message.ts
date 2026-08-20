import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import { followForward, postQuote } from "../utility/quote-post.ts";

// Right-click a message -> Apps -> Quote. Same result as `/quote`, without
// anyone having to copy an id.
export const data = new ContextMenuCommandBuilder()
  .setName("Quote")
  .setType(ApplicationCommandType.Message);

export async function execute(
  interaction: MessageContextMenuCommandInteraction,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const original = await followForward(interaction.targetMessage);
  if (!original) {
    await interaction.editReply(
      "That's a forwarded message, and I can't reach the original to see who said it. Quote the original instead.",
    );
    return;
  }

  const outcome = await postQuote(interaction.client, [original], interaction.user);
  await interaction.editReply(
    outcome.url ? `Quoted in ${outcome.url}` : outcome.error!,
  );
}
