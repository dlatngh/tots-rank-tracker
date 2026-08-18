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
};

// Region routing (NA). See https://developer.riotgames.com/docs/lol#routing-values
export const RIOT_PLATFORM = "na1"; // platform routing (summoner / league endpoints)
export const RIOT_REGION = "americas"; // regional routing (account-v1 endpoint)

// HenrikDev Valorant API routing
export const VAL_REGION = "na";
export const VAL_PLATFORM = "pc";
