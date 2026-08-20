// Centralized configuration. Bun automatically loads variables from `.env`.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  // Optional: register commands to a single guild for instant updates during dev.
  guildId: process.env.DISCORD_GUILD_ID ?? "",
  riotApiKey: required("RIOT_API_KEY"),
  henrikApiKey: required("HENRIK_API_KEY"),
  // Optional Fandom bot-password credentials (Special:BotPasswords). When set,
  // the esports client logs in to lift Leaguepedia's ~1 req/min anonymous rate
  // limit. Username is "MainAccount@BotName"; password is the generated string.
  leaguepediaUsername: process.env.LEAGUEPEDIA_USERNAME ?? "",
  leaguepediaPassword: process.env.LEAGUEPEDIA_PASSWORD ?? "",
  // LoL autobalancer web app. Override WEB_APP_BASE_URL to point at a local dev
  // server (http://localhost:3000) while testing.
  webAppBaseUrl: process.env.WEB_APP_BASE_URL ?? "https://autobalance.lol",
  botSharedSecret: required("BOT_SHARED_SECRET"),
  // Optional: channel the champion patch-change notifier posts to. When unset,
  // the notifier stays dormant (subscriptions still work, just no auto-pings).
  patchNotesChannelId: process.env.PATCH_NOTES_CHANNEL_ID ?? "",
  // Port the bot listens on for the patch watcher's webhook (see
  // scripts/patch-watcher.ts). Authenticated with botSharedSecret.
  patchWebhookPort: Number(process.env.PATCH_WEBHOOK_PORT ?? 8787),
  // Optional: channel for patch-watcher crash alerts. Falls back to the patch
  // channel when unset.
  alertChannelId: process.env.ALERT_CHANNEL_ID ?? "",
  // Optional: user pinged on a patch-watcher crash alert so an operator sees it.
  alertMentionUserId: process.env.ALERT_MENTION_USER_ID ?? "",
  // Optional: channel `/quote` posts saved quotes to. Unset disables the
  // command rather than guessing at a channel.
  quotesChannelId: process.env.QUOTES_CHANNEL_ID ?? "",
  // Optional: NeatQueue API token from its `/webhooks generatetoken` command.
  // Betting reads game rosters and results without it where NeatQueue allows
  // anonymous reads; set it if those calls start coming back unauthorized.
  neatQueueApiToken: process.env.NEATQUEUE_API_TOKEN ?? "",
};

// Region routing (NA). See https://developer.riotgames.com/docs/lol#routing-values
export const RIOT_PLATFORM = "na1"; // platform routing (summoner / league endpoints)
export const RIOT_REGION = "americas"; // regional routing (account-v1 endpoint)

// HenrikDev Valorant API routing
export const VAL_REGION = "na";
export const VAL_PLATFORM = "pc";
