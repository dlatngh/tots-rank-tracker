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
};

// Region routing (NA). See https://developer.riotgames.com/docs/lol#routing-values
export const RIOT_PLATFORM = "na1"; // platform routing (summoner / league endpoints)
export const RIOT_REGION = "americas"; // regional routing (account-v1 endpoint)

// HenrikDev Valorant API routing
export const VAL_REGION = "na";
export const VAL_PLATFORM = "pc";
