import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import {
  EsportsError,
  getPastMatches,
  getTeamPastMatches,
  getTeamRecentGames,
  getTeamUpcomingMatches,
  getUpcomingMatches,
  leaguesFor,
  resolveLeague,
  resolveTeam,
  searchTeams,
  type EsportsGame,
  type GameStats,
  type Match,
  type TeamRef,
} from "../utility/esports.ts";

const EMBED_COLOR = 0x0acbe6;

const DEFAULT_COUNT = 1;
const MAX_COUNT = 5;

// `stats` is team-based and defaults to just the most recent match.
const STATS_DEFAULT_MATCHES = 1;
const STATS_MAX_MATCHES = 5;

// upcoming/past accept either a team or a league in one free-text field.
function targetOption() {
  return (o: any) =>
    o
      .setName("target")
      .setDescription("Team or league (e.g. T1, GEN, LCK, Worlds).")
      .setRequired(true)
      .setAutocomplete(true);
}

function countOption() {
  return (o: any) =>
    o
      .setName("count")
      .setDescription(`How many to show (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).`)
      .setMinValue(1)
      .setMaxValue(MAX_COUNT);
}

function teamOption() {
  return (o: any) =>
    o
      .setName("team")
      .setDescription("Team name or tricode (e.g. T1, GEN, Gen.G).")
      .setRequired(true)
      .setAutocomplete(true);
}

function matchCountOption() {
  return (o: any) =>
    o
      .setName("count")
      .setDescription(
        `How many recent matches (1-${STATS_MAX_MATCHES}, default ${STATS_DEFAULT_MATCHES}).`,
      )
      .setMinValue(1)
      .setMaxValue(STATS_MAX_MATCHES);
}

export const data = new SlashCommandBuilder()
  .setName("esports")
  .setDescription("Esports schedules and results.")
  .addSubcommandGroup((g) =>
    g
      .setName("lol")
      .setDescription("League of Legends esports.")
      .addSubcommand((sc) =>
        sc
          .setName("upcoming")
          .setDescription("Upcoming matches for a team or league.")
          .addStringOption(targetOption())
          .addIntegerOption(countOption()),
      )
      .addSubcommand((sc) =>
        sc
          .setName("past")
          .setDescription("Recent results for a team or league.")
          .addStringOption(targetOption())
          .addIntegerOption(countOption()),
      )
      .addSubcommand((sc) =>
        sc
          .setName("stats")
          .setDescription("Recent match stats for a team (results spoiler-tagged).")
          .addStringOption(teamOption())
          .addIntegerOption(matchCountOption()),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  // Subcommand group is the game; only "lol" is wired up for now.
  const game = interaction.options.getSubcommandGroup() as EsportsGame;
  const action = interaction.options.getSubcommand();

  try {
    // `stats` is team-based; `upcoming`/`past` are league-based.
    if (action === "stats") {
      const teamQuery = interaction.options.getString("team", true);
      const count =
        interaction.options.getInteger("count") ?? STATS_DEFAULT_MATCHES;
      const team = await resolveTeam(game, teamQuery);
      if (!team) {
        return interaction.editReply(
          `Couldn't find a team matching **${teamQuery}**.`,
        );
      }
      return await renderStats(interaction, game, team, count);
    }

    // `upcoming`/`past` accept a team OR a league. Resolve as a league first
    // (static, no request); fall back to a team lookup.
    const query = interaction.options.getString("target", true);
    const count = interaction.options.getInteger("count") ?? DEFAULT_COUNT;
    const league = resolveLeague(game, query);
    const team = league ? null : await resolveTeam(game, query);
    if (!league && !team) {
      return interaction.editReply(
        `Couldn't find a team or league matching **${query}**.`,
      );
    }
    const label = league ? league.short : team!.name;
    const matches =
      action === "upcoming"
        ? league
          ? await getUpcomingMatches(game, league, count)
          : await getTeamUpcomingMatches(game, team!, count)
        : league
          ? await getPastMatches(game, league, count)
          : await getTeamPastMatches(game, team!, count);

    if (action === "upcoming") return renderUpcoming(interaction, matches, label);
    if (action === "past") return renderPast(interaction, matches, label);
  } catch (err) {
    return interaction.editReply(errorMessage(err));
  }
}

// Suggests leagues (for the `target` option) and teams (for `target` and
// `team`) as the user types. Leagues are matched statically (instant); teams
// are fetched once the query is long enough, and results are cached. Discord
// caps responses at 25 choices.
export async function autocomplete(interaction: AutocompleteInteraction) {
  const game = (interaction.options.getSubcommandGroup() ?? "lol") as EsportsGame;
  const focused = interaction.options.getFocused(true);
  const q = (focused.value ?? "").toString();
  const lc = q.trim().toLowerCase();
  const choices: { name: string; value: string }[] = [];

  // Leagues only apply to the combined `target` option.
  if (focused.name === "target") {
    for (const l of leaguesFor(game)) {
      const hay = [l.short, l.name, ...(l.aliases ?? [])].map((s) =>
        s.toLowerCase(),
      );
      if (!lc || hay.some((h) => h.includes(lc))) {
        choices.push({ name: `${l.short} — ${l.name}`, value: l.short });
      }
    }
  }

  // Teams require an API lookup, so only once the query is specific enough.
  if (lc.length >= 2) {
    try {
      for (const t of await searchTeams(game, q)) {
        choices.push({
          name: t.short ? `${t.name} (${t.short})` : t.name,
          value: t.name,
        });
      }
    } catch {
      // Autocomplete is best-effort; ignore lookup failures (e.g. throttling).
    }
  }

  await interaction.respond(choices.slice(0, 25)).catch(() => {});
}

async function renderUpcoming(
  interaction: ChatInputCommandInteraction,
  matches: Match[],
  label: string,
) {
  if (matches.length === 0) {
    return interaction.editReply(
      `No upcoming **${label}** matches on the schedule.`,
    );
  }
  const embed = new EmbedBuilder()
    .setTitle(`${label} · Upcoming`)
    .setColor(EMBED_COLOR)
    .setDescription(matches.map(upcomingLine).join("\n\n"))
    .setFooter({ text: "Leaguepedia" });
  return interaction.editReply({ embeds: [embed] });
}

async function renderPast(
  interaction: ChatInputCommandInteraction,
  matches: Match[],
  label: string,
) {
  if (matches.length === 0) {
    return interaction.editReply(`No recent **${label}** results found.`);
  }
  const embed = new EmbedBuilder()
    .setTitle(`${label} · Recent Results`)
    .setColor(EMBED_COLOR)
    .setDescription(matches.map(pastLine).join("\n"))
    .setFooter({ text: "Leaguepedia" });
  return interaction.editReply({ embeds: [embed] });
}

async function renderStats(
  interaction: ChatInputCommandInteraction,
  game: EsportsGame,
  team: TeamRef,
  count: number,
) {
  const games = await getTeamRecentGames(game, team);
  if (games.length === 0) {
    return interaction.editReply(
      `No recent games found for **${team.name}**.`,
    );
  }
  // One embed per match (games arrive newest-first, so matches stay newest-
  // first). Each embed: matchup title, tournament + series score in the
  // description, and one inline field per game so results aren't crammed onto a
  // single line. Games are sorted back into play order within the match.
  const matches = groupByMatch(games).slice(0, count);
  const embeds = matches.map((series, i) => {
    const order = [...series].sort(
      (a, b) => (a.gameInMatch ?? 0) - (b.gameInMatch ?? 0),
    );
    const first = order[0]!;
    const when = first.startTime
      ? ` · <t:${Math.floor(Date.parse(first.startTime) / 1000)}:R>`
      : "";
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${first.team1} vs ${first.team2}`)
      .setDescription(`**${first.tournament}**${when}\n${seriesScore(order)}`)
      .addFields(order.map(gameField));
    if (i === 0) embed.setAuthor({ name: `${team.name} · Recent Matches` });
    if (i === matches.length - 1) embed.setFooter({ text: "Leaguepedia" });
    return embed;
  });
  return interaction.editReply({ embeds });
}

// Series header: "**T1** 3-2 Gen.G" with the leader bolded, derived from the
// grouped games. If Game 1 is missing the window cut the series short, so the
// count is incomplete — flag it rather than show a wrong score. `order` must be
// sorted by game number ascending.
function seriesScore(order: GameStats[]): string {
  const teamA = order[0]!.team1;
  const teamB = order[0]!.team2;
  let a = 0;
  let b = 0;
  for (const g of order) {
    if (g.winner === teamA) a++;
    else if (g.winner === teamB) b++;
  }
  const labelA = a > b ? `**${teamA}**` : teamA;
  const labelB = b > a ? `**${teamB}**` : teamB;
  const partial = (order[0]!.gameInMatch ?? 1) !== 1 ? " *(partial)*" : "";
  // The score reveals the winner, so spoiler it too; the "(partial)" flag is
  // outside the spoiler since it gives nothing away.
  return `Series: ||${labelA} ${a}-${b} ${labelB}||${partial}`;
}

// One inline field per game. The name carries the game number and length (no
// spoiler — field names don't render them anyway); the value stacks the result
// (matchup with that game's actual sides, kills, winner, gold) on separate
// lines inside a single `||spoiler||` so it stays hidden until clicked.
function gameField(g: GameStats): { name: string; value: string; inline: boolean } {
  const label = g.gameInMatch ? `Game ${g.gameInMatch}` : "Game ?";
  const t1 = g.winner === g.team1 ? `**${g.team1}**` : g.team1;
  const t2 = g.winner === g.team2 ? `**${g.team2}**` : g.team2;
  const winner = g.winner ? `\n🏆 ${g.winner}` : "";
  const gold =
    g.team1Gold && g.team2Gold
      ? `\n💰 ${(g.team1Gold / 1000).toFixed(1)}k - ${(g.team2Gold / 1000).toFixed(1)}k`
      : "";
  return {
    name: g.length ? `${label} · ${g.length}` : label,
    value: `||${t1} ${g.team1Kills}-${g.team2Kills} ${t2}${winner}${gold}||`,
    inline: true,
  };
}

// Bucket games into series by matchId, preserving first-seen (newest-first)
// order. Games without a matchId each form their own single-game group.
function groupByMatch(games: GameStats[]): GameStats[][] {
  const groups: GameStats[][] = [];
  const byId = new Map<string, GameStats[]>();
  games.forEach((g, i) => {
    const key = g.matchId ?? `solo-${i}`;
    let group = byId.get(key);
    if (!group) {
      byId.set(key, (group = []));
      groups.push(group);
    }
    group.push(g);
  });
  return groups;
}

// -- line formatters --------------------------------------------------------

function upcomingLine(m: Match): string {
  const unix = Math.floor(Date.parse(m.startTime) / 1000);
  const live = m.live ? " · 🔴 **LIVE**" : "";
  const when = m.startTime ? `<t:${unix}:F> · <t:${unix}:R>` : "TBD";
  return `**${m.team1} vs ${m.team2}** · Bo${m.bestOf}${live}\n${when} · ${m.tournament}`;
}

function pastLine(m: Match): string {
  const win1 = m.score1 > m.score2;
  const t1 = win1 ? `**${m.team1}**` : m.team1;
  const t2 = win1 ? m.team2 : `**${m.team2}**`;
  return `${t1} ${m.score1}-${m.score2} ${t2} · ${m.tournament}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof EsportsError && err.code === "ratelimited") {
    return "Leaguepedia is rate-limiting right now. Try again in a moment.";
  }
  return `Failed to load esports data: ${err instanceof Error ? err.message : String(err)}`;
}
