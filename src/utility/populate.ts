// Pre-warm the rank cache for every registered player, paced at one fetch
// per second to stay well under upstream rate limits.

import { ChatInputCommandInteraction } from "discord.js";
import {
  getRank,
  invalidateRank,
  RiotApiError,
  type Game,
} from "./riot.ts";
import { getAllRegistrations, updateRiotId } from "./storage.ts";
import { log } from "./log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function populateRankCache(
  interaction: ChatInputCommandInteraction,
  game: Game,
): Promise<void> {
  await interaction.deferReply();

  const registrations = await getAllRegistrations();
  const total = registrations.length;
  if (total === 0) {
    await interaction.editReply("No players registered.");
    return;
  }

  let done = 0;
  let failed = 0;
  await interaction.editReply(
    `Populating **${game}** cache for ${total} players (1/sec)... 0/${total}`,
  );

  for (let i = 0; i < registrations.length; i++) {
    const reg = registrations[i]!;
    try {
      invalidateRank(reg.puuid, game);
      const rank = await getRank(reg.puuid, game, {
        gameName: reg.gameName,
        tagLine: reg.tagLine,
      });
      if (rank.gameName !== reg.gameName || rank.tagLine !== reg.tagLine) {
        void updateRiotId(reg.discordId, rank.gameName, rank.tagLine);
      }
      done++;
    } catch (err) {
      failed++;
      const status = err instanceof RiotApiError ? err.status : "?";
      log("cache", `populate failed for ${reg.puuid.slice(0, 8)} (${status})`);
    }

    // Edit reply roughly every 3 players to avoid Discord's edit rate limits.
    if ((i + 1) % 3 === 0 || i === registrations.length - 1) {
      await interaction
        .editReply(
          `Populating **${game}** cache... ${done + failed}/${total}` +
            (failed > 0 ? ` (${failed} failed)` : ""),
        )
        .catch(() => {});
    }

    // Pace to ~1 fetch per second. Skip the wait after the last one.
    if (i < registrations.length - 1) await sleep(1000);
  }

  await interaction.editReply(
    `✅ Populated **${game}** cache: ${done}/${total}` +
      (failed > 0 ? ` (${failed} failed)` : ""),
  );
}
