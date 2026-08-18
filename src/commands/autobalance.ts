import {
  ActionRowBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  AutobalanceError,
  balance,
  buildTeamsPayload,
  cacheLobby,
  getCachedLobby,
  rerollLobby,
  type RankMode,
} from "../utility/autobalance.ts";

const DEFAULT_MODE: RankMode = "SOLO_DUO";

export const data = new SlashCommandBuilder()
  .setName("autobalance")
  .setDescription("Balance a pasted LoL lobby log into two fair teams.")
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("Which rank to use per player. Defaults to Solo/Duo.")
      .addChoices(
        { name: "Solo/Duo only", value: "SOLO_DUO" },
        { name: "Highest (Solo/Duo + Flex peak)", value: "HIGHEST" },
      ),
  );

// `/autobalance` opens a modal so the user can paste a long, multiline lobby log.
// The chosen rank mode is carried through the modal's customId.
export async function execute(interaction: ChatInputCommandInteraction) {
  const mode = (interaction.options.getString("mode") as RankMode) ?? DEFAULT_MODE;

  const modal = new ModalBuilder()
    .setCustomId(`autobalance:modal:${mode}`)
    .setTitle("Autobalance Lobby");

  const input = new TextInputBuilder()
    .setCustomId("chatLog")
    .setLabel("Paste the lobby join log")
    .setPlaceholder("GameName #Tag joined the lobby\n...")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );

  await interaction.showModal(modal);
}

// Modal submit: read the pasted log, call /api/balance, render teams, cache the
// resolved lobby keyed by the reply message id so reroll can reuse it.
export async function handleModal(interaction: ModalSubmitInteraction) {
  const mode = (interaction.customId.split(":")[2] as RankMode) ?? DEFAULT_MODE;
  const chatLog = interaction.fields.getTextInputValue("chatLog");

  await interaction.deferReply();

  let result;
  try {
    result = await balance(chatLog, mode);
  } catch (err) {
    await interaction.editReply(errorMessage(err));
    return;
  }

  await interaction.editReply(buildTeamsPayload(result.teams, mode));
  const reply = await interaction.fetchReply();
  cacheLobby(reply.id, result.lobby, mode);
}

// Reroll button: re-balance the cached lobby (no Riot calls) and edit in place.
export async function handleReroll(interaction: ButtonInteraction) {
  const cached = getCachedLobby(interaction.message.id);
  if (!cached) {
    await interaction.reply({
      content:
        "This lobby is no longer cached (the bot may have restarted). Run `/autobalance` again.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();
  const teams = await rerollLobby(cached.lobby);
  await interaction.editReply(buildTeamsPayload(teams, cached.mode));
}

function errorMessage(err: unknown): string {
  if (err instanceof AutobalanceError) {
    switch (err.status) {
      case 400:
        return err.message;
      case 401:
        return "The bot is not authorized by the web app. Check `BOT_SHARED_SECRET`.";
      case 404:
        return "The balance endpoint isn't deployed yet. Try again shortly.";
      default:
        return `Balancing failed: ${err.message}`;
    }
  }
  return `Balancing failed: ${err instanceof Error ? err.message : String(err)}`;
}
