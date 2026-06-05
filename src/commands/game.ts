import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { getRank, type Game } from "../utility/riot.ts";
import { getAllRegistrations, updateRiotId } from "../utility/storage.ts";

export const data = new SlashCommandBuilder()
  .setName("game")
  .setDescription("Game-related admin utilities.")
  .addSubcommand((sc) =>
    sc
      .setName("populate")
      .setDescription("Pre-warm the rank cache for all registered players.")
      .addStringOption((opt) =>
        opt
          .setName("game")
          .setDescription("Which game to populate.")
          .setRequired(true)
          .addChoices(
            { name: "League of Legends", value: "lol" },
            { name: "Valorant", value: "val" },
          ),
      ),
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "populate") return handlePopulate(interaction);
}

async function handlePopulate(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const game = interaction.options.getString("game", true) as Game;
  const regs = await getAllRegistrations();

  if (regs.length === 0) {
    await interaction.editReply("No registered players.");
    return;
  }

  const total = regs.length;
  await interaction.editReply(
    `Populating **${game}** rank cache for ${total} players (≈${total}s)…`,
  );

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < regs.length; i++) {
    const reg = regs[i]!;
    try {
      const rank = await getRank(reg.puuid, game, {
        gameName: reg.gameName,
        tagLine: reg.tagLine,
      });
      if (rank.gameName !== reg.gameName || rank.tagLine !== reg.tagLine) {
        void updateRiotId(reg.discordId, rank.gameName, rank.tagLine);
      }
      ok++;
    } catch {
      failed++;
    }
    // 1s pacing between players. Skip the trailing sleep on the last entry.
    if (i < regs.length - 1) await sleep(1000);
  }

  await interaction.editReply(
    `Done. ${ok} cached, ${failed} failed (of ${total}).`,
  );
}
