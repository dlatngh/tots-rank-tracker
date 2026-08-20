import * as register from "./register.ts";
import * as unregister from "./unregister.ts";
import * as lol from "./lol.ts";
import * as val from "./val.ts";
import * as leaderboard from "./leaderboard.ts";
import * as division from "./division.ts";
import * as game from "./game.ts";
import * as sun from "./sun.ts";
import * as esports from "./esports.ts";
import * as autobalance from "./autobalance.ts";
import * as subscribe from "./subscribe.ts";
import * as unsubscribe from "./unsubscribe.ts";
import * as subscriptions from "./subscriptions.ts";
import * as champ from "./champ.ts";
import * as lanemeta from "./lanemeta.ts";
import * as bet from "./bet.ts";
import * as quote from "./quote.ts";
import * as quoteMessage from "./quote-message.ts";

export const commands = {
  register,
  unregister,
  lol,
  val,
  leaderboard,
  division,
  game,
  sun,
  esports,
  autobalance,
  subscribe,
  unsubscribe,
  subscriptions,
  champ,
  lanemeta,
  bet,
  quote,
};

// Right-click actions are dispatched separately from slash commands: they carry
// a different interaction type, and Discord matches them by their display name.
export const contextMenuCommands = {
  quoteMessage,
};

export const allCommandData = [
  ...Object.values(commands),
  ...Object.values(contextMenuCommands),
].map((command) => command.data);
