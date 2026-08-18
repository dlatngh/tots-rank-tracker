import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { getChampions, normalizeChampionName } from "../utility/riot.ts";
import { subscribe } from "../utility/champion-subs.ts";

export const data = new SlashCommandBuilder()
  .setName("subscribe")
  .setDescription("Get pinged when a patch changes a champion you follow.")
  .addStringOption((opt) =>
    opt
      .setName("champion")
      .setDescription("Champion to follow.")
      .setRequired(true)
      .setAutocomplete(true),
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const query = normalizeChampionName(interaction.options.getFocused());
  const champions = await getChampions();
  const matches = champions
    .filter((c) => normalizeChampionName(c.name).includes(query))
    .slice(0, 25)
    .map((c) => ({ name: c.name, value: c.id }));
  await interaction.respond(matches);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const input = interaction.options.getString("champion", true);
  const champions = await getChampions();
  const champion =
    champions.find((c) => c.id === input) ??
    champions.find(
      (c) => normalizeChampionName(c.name) === normalizeChampionName(input),
    );

  if (!champion) {
    await interaction.editReply(`Unknown champion \`${input}\`.`);
    return;
  }

  const { added } = await subscribe(interaction.user.id, champion.id);
  await interaction.editReply(
    added
      ? `Subscribed to **${champion.name}**. You'll be pinged when a patch changes them.`
      : `You're already subscribed to **${champion.name}**.`,
  );
}
