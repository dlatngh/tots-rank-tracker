// Standalone LoL patch watcher. Run by cron (see README/crontab). Discovers the
// latest patch from Riot's patch-notes listing, scrapes that patch's notes page
// for the champions it changed and their plain-English summaries, and POSTs the
// full set to the bot's webhook. It knows nothing about subscriptions — the bot
// filters to subscribers on its end. No bot code is imported so this stays a
// self-contained service that could move off-box unchanged.

const WEBHOOK_URL =
  process.env.PATCH_WEBHOOK_URL ?? "http://localhost:8787/internal/patch";
const ERROR_URL = new URL("/internal/patch-error", WEBHOOK_URL).toString();
const SECRET = process.env.BOT_SHARED_SECRET;

const PATCH_NOTES_LISTING =
  "https://www.leagueoflegends.com/en-us/news/tags/patch-notes/";
const PATCH_SLUG_PATTERN = /(?:league-of-legends-)?patch-(\d+)-(\d+)-notes/g;
const USER_AGENT = "racker-patch-watcher/1.0";

// Plain timestamped logging (no ANSI) since this runs under cron into a file.
function logLine(message: string): void {
  console.log(`${new Date().toISOString()} [patch-watcher] ${message}`);
}

function logFailure(message: string): void {
  console.error(`${new Date().toISOString()} [patch-watcher] ERROR ${message}`);
}

// Best-effort: tell the bot so it can post an alert. If the bot itself is down
// this can't reach it, so failures here are only logged locally.
async function reportFailure(message: string): Promise<void> {
  if (!SECRET) return;
  try {
    const res = await fetch(ERROR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bot-secret": SECRET },
      body: JSON.stringify({ message }),
    });
    logLine(`reported failure to bot -> ${res.status}`);
  } catch (err) {
    logFailure(
      `could not reach bot to report failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface PatchNotes {
  patch: string;
  url: string;
}

interface ChangeSection {
  title: string;
  entries: string[];
}

interface PatchChange {
  championId: string;
  championName: string;
  summary: string;
  sections: ChangeSection[];
}

function normalizeChampionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Riot's markup leaves literal &nbsp; entities and badge padding in the text.
function normalizeText(text: string): string {
  return text.replace(/&nbsp;/g, " ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function latestPatchNotes(): Promise<PatchNotes | null> {
  const res = await fetch(PATCH_NOTES_LISTING, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    logFailure(`listing fetch failed (${res.status})`);
    return null;
  }
  const html = await res.text();

  let newest: { major: number; minor: number; slug: string } | null = null;
  for (const match of html.matchAll(PATCH_SLUG_PATTERN)) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const isNewer =
      !newest ||
      major > newest.major ||
      (major === newest.major && minor > newest.minor);
    if (isNewer) newest = { major, minor, slug: match[0] };
  }
  if (!newest) return null;

  return {
    patch: `${newest.major}.${newest.minor}`,
    url: `https://www.leagueoflegends.com/en-us/news/game-updates/${newest.slug}/`,
  };
}

async function getRoster(): Promise<Map<string, { id: string; name: string }>> {
  const versions = (await (
    await fetch("https://ddragon.leagueoflegends.com/api/versions.json")
  ).json()) as string[];
  const version = versions[0];
  const json = (await (
    await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`,
    )
  ).json()) as { data: Record<string, { id: string; name: string }> };

  const roster = new Map<string, { id: string; name: string }>();
  for (const champion of Object.values(json.data)) {
    roster.set(normalizeChampionName(champion.name), {
      id: champion.id,
      name: champion.name,
    });
  }
  return roster;
}

// Each champion sits in its own <div class="patch-change-block">, holding an
// <h3 class="change-title"> with the champion name, a <blockquote
// class="blockquote context"> with the designer blurb, then repeating
// <h4 class="change-detail-title"> / <ul><li> pairs with the actual stat
// changes. Scoping every handler to the enclosing block keeps unrelated list
// items elsewhere on the page (nav, footer) out of the results.
interface ChampionBlock {
  name: string;
  summary: string;
  sections: ChangeSection[];
}

async function parseChampionBlocks(html: string): Promise<ChampionBlock[]> {
  const blocks: ChampionBlock[] = [];
  let current: ChampionBlock | null = null;
  let currentSection: ChangeSection | null = null;
  let capturing: "name" | "summary" | "section" | "entry" | null = null;

  const rewriter = new HTMLRewriter()
    .on("div.patch-change-block", {
      element(el) {
        current = { name: "", summary: "", sections: [] };
        currentSection = null;
        capturing = null;
        blocks.push(current);
        el.onEndTag(() => {
          current = null;
          currentSection = null;
          capturing = null;
        });
      },
    })
    .on("h3.change-title", {
      element(el) {
        if (!current) return;
        capturing = "name";
        el.onEndTag(() => {
          capturing = null;
        });
      },
      text(chunk) {
        if (capturing === "name" && current) current.name += chunk.text;
      },
    })
    .on("blockquote.context", {
      element(el) {
        if (!current || current.summary.trim()) return;
        capturing = "summary";
        el.onEndTag(() => {
          capturing = null;
        });
      },
      text(chunk) {
        if (capturing === "summary" && current) current.summary += chunk.text;
      },
    })
    .on("h4.change-detail-title", {
      element(el) {
        if (!current) return;
        currentSection = { title: "", entries: [] };
        current.sections.push(currentSection);
        capturing = "section";
        el.onEndTag(() => {
          capturing = null;
        });
      },
      text(chunk) {
        if (capturing === "section" && currentSection) {
          currentSection.title += chunk.text;
        }
      },
    })
    .on("li", {
      element(el) {
        if (!current || !currentSection) return;
        currentSection.entries.push("");
        capturing = "entry";
        el.onEndTag(() => {
          capturing = null;
        });
      },
      text(chunk) {
        if (capturing === "entry" && currentSection) {
          const lastIndex = currentSection.entries.length - 1;
          currentSection.entries[lastIndex] += chunk.text;
        }
      },
    });

  await rewriter.transform(new Response(html)).text();
  return blocks;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  logLine("run started");

  if (!SECRET) {
    logFailure("BOT_SHARED_SECRET is not set; cannot authenticate to the bot.");
    process.exit(1);
  }

  const notes = await latestPatchNotes();
  if (!notes) {
    logFailure("could not determine latest patch");
    await reportFailure("could not determine latest patch (Riot listing unreachable or its format changed)");
    process.exit(1);
  }
  logLine(`latest patch is ${notes.patch} (${notes.url})`);

  const res = await fetch(notes.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    // Notes page not live yet; a later run will pick it up.
    logLine(
      `notes for ${notes.patch} not available yet (${res.status}); will retry next run`,
    );
    logLine(`run finished in ${Date.now() - startedAt}ms`);
    return;
  }

  const html = await res.text();
  const blocks = await parseChampionBlocks(html);
  const roster = await getRoster();

  const changesById = new Map<string, PatchChange>();
  for (const block of blocks) {
    const champion = roster.get(normalizeChampionName(block.name));
    if (!champion || changesById.has(champion.id)) continue;
    const sections = block.sections
      .map((section) => ({
        title: normalizeText(section.title),
        entries: section.entries.map(normalizeText).filter(Boolean),
      }))
      .filter((section) => section.entries.length > 0);

    changesById.set(champion.id, {
      championId: champion.id,
      championName: champion.name,
      summary: normalizeText(block.summary),
      sections,
    });
  }
  const changes = [...changesById.values()];
  logLine(
    `parsed ${changes.length} champion change(s): ${changes.map((c) => c.championName).join(", ") || "none"}`,
  );

  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-secret": SECRET,
    },
    body: JSON.stringify({ patch: notes.patch, url: notes.url, changes }),
  });
  const result = await response.text();

  if (response.ok) {
    logLine(`posted patch ${notes.patch} to bot -> ${response.status} ${result}`);
  } else {
    logFailure(`bot rejected patch ${notes.patch} -> ${response.status} ${result}`);
    await reportFailure(`bot rejected patch ${notes.patch}: ${response.status} ${result}`);
  }
  logLine(`run finished in ${Date.now() - startedAt}ms`);
}

main().catch(async (err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logFailure(`run crashed: ${detail}`);
  await reportFailure(
    `run crashed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
