import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from "discord.js";
import { config } from "./src/utility/config.ts";
import { commands, contextMenuCommands } from "./src/commands/index.ts";
import { registerCommands } from "./src/utility/deploy-commands.ts";
import { startDailySnapshotScheduler } from "./src/utility/rank-history.ts";
import { startPatchWebhook } from "./src/utility/patch-webhook.ts";
import {
  handleChannelCreate,
  handleQueueMessage,
  startBetSync,
} from "./src/utility/bet-sync.ts";
import { log, logError } from "./src/utility/log.ts";

// GuildMessages plus the Message partial let the bot see NeatQueue's queue
// message being edited. Its embeds are stripped from the event unless the
// Message Content intent is enabled, so the handler refetches over REST.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);

  // Auto-register on startup only in guild-dev mode (instant + safe to repeat).
  // Global registration stays a manual `bun run deploy` to avoid rate limits.
  if (config.guildId) {
    await registerCommands().catch((err) =>
      console.error("Auto command registration failed:", err),
    );
  }

  startDailySnapshotScheduler();
  startPatchWebhook(c);
  startBetSync(c);
});

// Discord discards an interaction token if it is not acknowledged within three
// seconds, which happens when the process restarts mid-interaction. Nothing can
// be sent back at that point, so log it plainly instead of a REST stack trace.
function isExpiredInteraction(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: number }).code === 10062
  );
}

// NeatQueue creates a channel per game, named with the game number. The channel
// appearing is the moment the game starts, and it is where the round is posted.
client.on(Events.ChannelCreate, (channel) => {
  handleChannelCreate(client, channel).catch((err) =>
    logError("bet", "opening a round for a new match channel failed:", err),
  );
});

// NeatQueue edits one sticky message as players join and leave its queue; that
// edit is the earliest sign a game is about to start.
for (const event of [Events.MessageCreate, Events.MessageUpdate] as const) {
  client.on(event, (...args) => {
    const message = args[args.length - 1] as Parameters<
      typeof handleQueueMessage
    >[0];
    handleQueueMessage(message).catch((err) =>
      logError("bet", "reading the queue message failed:", err),
    );
  });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commands[interaction.commandName as keyof typeof commands];
    if (command && "autocomplete" in command) {
      try {
        await (command.autocomplete as (i: typeof interaction) => Promise<void>)(
          interaction,
        );
      } catch (err) {
        if (isExpiredInteraction(err)) {
          logError("cmd", `autocomplete for /${interaction.commandName} expired`);
          return;
        }
        logError("cmd", `Autocomplete error for /${interaction.commandName}:`, err);
      }
    } else if (command) {
      logError(
        "cmd",
        `/${interaction.commandName} has no autocomplete handler`,
      );
    }
    return;
  }

  if (interaction.isMessageContextMenuCommand()) {
    const command = Object.values(contextMenuCommands).find(
      (candidate) => candidate.data.name === interaction.commandName,
    );
    if (!command) return;

    const started = Date.now();
    log(
      "cmd",
      `${interaction.commandName} on ${interaction.targetId} by ${interaction.user.tag}`,
    );
    try {
      await command.execute(interaction);
      log("cmd", `${interaction.commandName} done (${Date.now() - started}ms)`);
    } catch (err) {
      if (isExpiredInteraction(err)) {
        logError("cmd", `${interaction.commandName} expired before it could be acknowledged`);
        return;
      }
      logError("cmd", `Error in ${interaction.commandName}:`, err);
      await interaction
        .editReply("I cant do it my sodium is too high.")
        .catch(() => {});
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const command = commands[interaction.commandName as keyof typeof commands];
    if (!command) return;

    const started = Date.now();
    const sub = interaction.options.getSubcommand(false);
    const label = sub
      ? `/${interaction.commandName} ${sub}`
      : `/${interaction.commandName}`;
    const suppliedOptions = interaction.options.data
      .flatMap((option) => option.options ?? [option])
      .map((option) => `${option.name}:${option.value}`)
      .join(" ");
    log(
      "cmd",
      `${label} ${suppliedOptions || "(no options)"} by ${interaction.user.tag} in ${interaction.guild?.name ?? "DM"} #${
        interaction.channel && "name" in interaction.channel
          ? interaction.channel.name
          : "dm"
      }`,
    );
    try {
      await command.execute(interaction);
      log("cmd", `${label} done (${Date.now() - started}ms)`);
    } catch (err) {
      if (isExpiredInteraction(err)) {
        logError(
          "cmd",
          `${label} expired before it could be acknowledged (bot restart, or over 3s to respond)`,
        );
        return;
      }
      logError("cmd", `Error in /${interaction.commandName}:`, err);
      const msg = "I cant do it my sodium is too high.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction
          .reply({ content: msg, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    const [namespace] = interaction.customId.split(":");
    const started = Date.now();
    log("cmd", `modal ${interaction.customId} by ${interaction.user.tag}`);
    try {
      if (namespace === "autobalance") {
        await commands.autobalance.handleModal(interaction);
      }
      log("cmd", `modal ${interaction.customId} done (${Date.now() - started}ms)`);
    } catch (err) {
      if (isExpiredInteraction(err)) {
        logError(
          "cmd",
          `modal ${interaction.customId} expired before it could be acknowledged (bot restart, or over 3s to respond)`,
        );
        return;
      }
      logError("cmd", `Error handling modal ${interaction.customId}:`, err);
      const msg = "I cant do it my sodium is too high.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction
          .reply({ content: msg, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton()) {
    const [namespace] = interaction.customId.split(":");
    const started = Date.now();
    log("btn", `${interaction.customId} by ${interaction.user.tag}`);
    try {
      if (namespace === "lol") {
        await commands.lol.handleRefresh(interaction);
      } else if (namespace === "val") {
        await commands.val.handleRefresh(interaction);
      } else if (namespace === "leaderboard") {
        await commands.leaderboard.handleRefresh(interaction);
      } else if (namespace === "autobalance") {
        await commands.autobalance.handleReroll(interaction);
      }
      log("btn", `${interaction.customId} done (${Date.now() - started}ms)`);
    } catch (err) {
      if (isExpiredInteraction(err)) {
        logError(
          "btn",
          `${interaction.customId} expired before it could be acknowledged (bot restart, or over 3s to respond)`,
        );
        return;
      }
      logError("btn", `Error handling button ${interaction.customId}:`, err);
      const msg = "An error occurred while refreshing.";
      if (interaction.deferred || interaction.replied) {
        await interaction
          .followUp({ content: msg, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      } else {
        await interaction
          .reply({ content: msg, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  }
});

await client.login(config.discordToken);
