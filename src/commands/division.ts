import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import {
  getAllRegistrations,
  getRegistration,
  setDivision,
  type Division,
} from "../utility/storage.ts";

const DIVISION_CHOICES = [
  { name: "Upper", value: "upper" },
  { name: "Lower", value: "lower" },
] as const;

export const data = new SlashCommandBuilder()
  .setName("division")
  .setDescription("Manage ranked-race divisions.")
  .addSubcommand((sc) =>
    sc.setName("list").setDescription("List players grouped by division."),
  )
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Assign a player to a division.")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player to assign.").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("division")
          .setDescription("Target division.")
          .setRequired(true)
          .addChoices(...DIVISION_CHOICES),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove a player from any division (stays registered).")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player to remove.").setRequired(true),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("move")
      .setDescription("Move a player from one division to another.")
      .addUserOption((o) =>
        o.setName("user").setDescription("Player to move.").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("from")
          .setDescription("Current division (sanity check).")
          .setRequired(true)
          .addChoices(...DIVISION_CHOICES),
      )
      .addStringOption((o) =>
        o
          .setName("to")
          .setDescription("New division.")
          .setRequired(true)
          .addChoices(...DIVISION_CHOICES),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "list") return handleList(interaction);
  if (sub === "add") return handleAdd(interaction);
  if (sub === "remove") return handleRemove(interaction);
  if (sub === "move") return handleMove(interaction);
}

async function handleList(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const all = await getAllRegistrations();
  const groups: Record<Division | "none", string[]> = {
    upper: [],
    lower: [],
    none: [],
  };
  for (const r of all) {
    const key: Division | "none" = r.division ?? "none";
    groups[key].push(`<@${r.discordId}>`);
  }

  const section = (label: string, members: string[]) =>
    `**${label} (${members.length})**\n${members.join("\n") || "_empty_"}`;

  const embed = new EmbedBuilder()
    .setTitle("Ranked Race Divisions")
    .setColor(0x5865f2)
    .setDescription(
      [
        section("Upper", groups.upper),
        section("Lower", groups.lower),
        section("Not Playing", groups.none),
      ].join("\n\n"),
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleAdd(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const user = interaction.options.getUser("user", true);
  const division = interaction.options.getString("division", true) as Division;

  try {
    const { previous } = await setDivision(user.id, division);
    const note = previous
      ? `Moved <@${user.id}> from **${previous}** to **${division}**.`
      : `Assigned <@${user.id}> to **${division}**.`;
    await interaction.editReply(note);
  } catch {
    await interaction.editReply(
      `<@${user.id}> isn't registered yet. Use \`/register\` first.`,
    );
  }
}

async function handleRemove(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const user = interaction.options.getUser("user", true);

  try {
    const { previous } = await setDivision(user.id, null);
    if (!previous) {
      await interaction.editReply(`<@${user.id}> wasn't in any division.`);
    } else {
      await interaction.editReply(
        `Removed <@${user.id}> from **${previous}** division.`,
      );
    }
  } catch {
    await interaction.editReply(`<@${user.id}> isn't registered yet.`);
  }
}

async function handleMove(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const user = interaction.options.getUser("user", true);
  const from = interaction.options.getString("from", true) as Division;
  const to = interaction.options.getString("to", true) as Division;

  if (from === to) {
    await interaction.editReply(
      `\`from\` and \`to\` are the same — nothing to do.`,
    );
    return;
  }

  const current = await getRegistration(user.id);
  if (!current) {
    await interaction.editReply(`<@${user.id}> isn't registered yet.`);
    return;
  }
  if (current.division !== from) {
    await interaction.editReply(
      `<@${user.id}> is in **${current.division ?? "no"}** division, not **${from}**. Aborting.`,
    );
    return;
  }

  await setDivision(user.id, to);
  await interaction.editReply(
    `Moved <@${user.id}> from **${from}** to **${to}**.`,
  );
}
