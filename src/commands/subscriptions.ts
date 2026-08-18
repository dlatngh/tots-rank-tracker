import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getChampions } from "../utility/riot.ts";
import { getSubscriptions } from "../utility/champion-subs.ts";

export const data = new SlashCommandBuilder()
  .setName("subscriptions")
  .setDescription("List the champions you're subscribed to for patch changes.")
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("Whose subscriptions to view. Defaults to yourself."),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const user = interaction.options.getUser("user") ?? interaction.user;
  const subscribedIds = await getSubscriptions(user.id);

  if (subscribedIds.length === 0) {
    await interaction.editReply(
      `<@${user.id}> isn't subscribed to any champions. Use \`/subscribe\` to follow one.`,
    );
    return;
  }

  const champions = await getChampions();
  const nameById = new Map(champions.map((c) => [c.id, c.name]));
  const names = subscribedIds
    .map((id) => nameById.get(id) ?? id)
    .sort((a, b) => a.localeCompare(b));

  await interaction.editReply(
    `<@${user.id}> is subscribed to: ${names.map((n) => `**${n}**`).join(", ")}.`,
  );
}
