import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { getChampions } from "../utility/riot.ts";
import {
  getAllSubscriptions,
  getSubscriptions,
} from "../utility/champion-subs.ts";

export const data = new SlashCommandBuilder()
  .setName("subscriptions")
  .setDescription("List champion patch subscriptions for everyone.")
  .addUserOption((opt) =>
    opt
      .setName("user")
      .setDescription("Show only this user's subscriptions."),
  );

async function championNameLookup(): Promise<Map<string, string>> {
  const champions = await getChampions();
  return new Map(champions.map((champion) => [champion.id, champion.name]));
}

function formatChampionList(
  championIds: string[],
  nameById: Map<string, string>,
): string {
  const names = championIds
    .map((id) => nameById.get(id) ?? id)
    .sort((a, b) => a.localeCompare(b));
  return names.map((name) => `**${name}**`).join(", ");
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const user = interaction.options.getUser("user");
  if (user) {
    const subscribedIds = await getSubscriptions(user.id);
    if (subscribedIds.length === 0) {
      await interaction.editReply(
        `<@${user.id}> isn't subscribed to any champions. Use \`/subscribe\` to follow one.`,
      );
      return;
    }
    const nameById = await championNameLookup();
    await interaction.editReply(
      `<@${user.id}> is subscribed to: ${formatChampionList(subscribedIds, nameById)}.`,
    );
    return;
  }

  const store = await getAllSubscriptions();
  const subscribers = Object.entries(store).filter(
    ([, championIds]) => championIds.length > 0,
  );

  if (subscribers.length === 0) {
    await interaction.editReply(
      "Nobody is subscribed to any champions yet. Use `/subscribe` to follow one.",
    );
    return;
  }

  const nameById = await championNameLookup();
  // Busiest subscribers first, so the most-followed lists are visible even if
  // the description has to be cut short.
  subscribers.sort(([, a], [, b]) => b.length - a.length);
  const lines = subscribers.map(
    ([discordId, championIds]) =>
      `<@${discordId}> - ${formatChampionList(championIds, nameById)}`,
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Champion patch subscriptions")
    .setDescription(lines.join("\n").slice(0, 4096));

  await interaction.editReply({ embeds: [embed] });
}
