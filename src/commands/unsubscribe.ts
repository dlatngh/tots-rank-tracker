import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { getChampions, normalizeChampionName } from "../utility/riot.ts";
import { getSubscriptions, unsubscribe } from "../utility/champion-subs.ts";

export const data = new SlashCommandBuilder()
  .setName("unsubscribe")
  .setDescription("Stop getting pinged for a champion you follow.")
  .addStringOption((opt) =>
    opt
      .setName("champion")
      .setDescription("Champion to stop following.")
      .setRequired(true)
      .setAutocomplete(true),
  );

// Autocomplete over only the user's current subscriptions so they can't pick a
// champion they don't follow.
export async function autocomplete(interaction: AutocompleteInteraction) {
  const [subscribedIds, champions] = await Promise.all([
    getSubscriptions(interaction.user.id),
    getChampions(),
  ]);
  const nameById = new Map(champions.map((c) => [c.id, c.name]));

  const query = normalizeChampionName(interaction.options.getFocused());
  const matches = subscribedIds
    .map((id) => ({ id, name: nameById.get(id) ?? id }))
    .filter((c) => normalizeChampionName(c.name).includes(query))
    .slice(0, 25)
    .map((c) => ({ name: c.name, value: c.id }));
  await interaction.respond(matches);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const input = interaction.options.getString("champion", true);
  const champions = await getChampions();
  const champion =
    champions.find((c) => c.id === input) ??
    champions.find(
      (c) => normalizeChampionName(c.name) === normalizeChampionName(input),
    );
  const championId = champion?.id ?? input;
  const label = champion?.name ?? input;

  const { removed } = await unsubscribe(interaction.user.id, championId);
  await interaction.editReply(
    removed
      ? `Unsubscribed from **${label}**.`
      : `You weren't subscribed to **${label}**.`,
  );
}
