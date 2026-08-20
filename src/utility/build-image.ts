// Renders a champion's recommended build as labelled rows of item icons, one
// row per stage of the build, with the win rate for that stage. This is the
// whole build section of the /champ reply: the icons carry the items, so the
// embed does not repeat them as text.

import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { formatRate, type ChampionBuild } from "./opgg.ts";
import { itemIconUrl } from "./riot.ts";
import { logError } from "./log.ts";

const ICON_SIZE = 56;
const ICON_GAP = 8;
const ROW_GAP = 10;
const LABEL_COLUMN_WIDTH = 110;
const WIN_RATE_COLUMN_WIDTH = 100;
const PADDING = 16;
const CORNER_RADIUS = 12;
const LABEL_FONT = "600 20px 'Helvetica Neue', Helvetica, Arial, sans-serif";
const PANEL_COLOR = "#1e1f22";
const LABEL_COLOR = "#b5bac1";
const WIN_RATE_COLOR = "#f2f3f5";

// Data Dragon item icons never change for a given id, so one fetch per item per
// process lifetime is enough.
const iconCache = new Map<number, Promise<Image | null>>();

function loadItemIcon(itemId: number): Promise<Image | null> {
  const cached = iconCache.get(itemId);
  if (cached) return cached;

  const pending = (async () => {
    const response = await fetch(await itemIconUrl(itemId));
    if (!response.ok) {
      throw new Error(`Data Dragon has no icon for item ${itemId}`);
    }
    return loadImage(Buffer.from(await response.arrayBuffer()));
  })().catch((err) => {
    logError("champ", `item icon ${itemId} failed to load:`, err);
    iconCache.delete(itemId);
    return null;
  });

  iconCache.set(itemId, pending);
  return pending;
}

interface BuildStage {
  label: string;
  itemIds: number[];
  // Null for the late row, whose items each come from a different slot and so
  // share no single win rate.
  winRate: number | null;
}

function buildStages(build: ChampionBuild): BuildStage[] {
  const stages: BuildStage[] = [];
  if (build.starterItems) {
    stages.push({
      label: "START",
      itemIds: build.starterItems.itemIds,
      winRate: build.starterItems.winRate,
    });
  }
  if (build.boots) {
    stages.push({
      label: "BOOTS",
      itemIds: build.boots.itemIds,
      winRate: build.boots.winRate,
    });
  }
  if (build.coreItems) {
    stages.push({
      label: "CORE",
      itemIds: build.coreItems.itemIds,
      winRate: build.coreItems.winRate,
    });
  }

  const situationalIds = build.situationalItems.flatMap(
    (items) => items.itemIds,
  );
  if (situationalIds.length > 0) {
    stages.push({ label: "LATE", itemIds: situationalIds, winRate: null });
  }

  return stages.filter((stage) => stage.itemIds.length > 0);
}

interface DrawableStage {
  label: string;
  icons: Image[];
  winRate: number | null;
}

async function loadStageIcons(stages: BuildStage[]): Promise<DrawableStage[]> {
  const drawable = await Promise.all(
    stages.map(async (stage) => {
      const icons = await Promise.all(stage.itemIds.map(loadItemIcon));
      return {
        label: stage.label,
        icons: icons.filter((icon): icon is Image => icon !== null),
        winRate: stage.winRate,
      };
    }),
  );
  return drawable.filter((stage) => stage.icons.length > 0);
}

// Null when nothing could be drawn, so the caller can fall back to the
// text-only embed instead of attaching an empty image.
export async function renderBuildImage(
  build: ChampionBuild,
): Promise<Buffer | null> {
  const stages = await loadStageIcons(buildStages(build));
  if (stages.length === 0) return null;

  const widestRowIconCount = Math.max(
    ...stages.map((stage) => stage.icons.length),
  );
  const iconsWidth =
    widestRowIconCount * ICON_SIZE + (widestRowIconCount - 1) * ICON_GAP;
  const width =
    PADDING * 2 + LABEL_COLUMN_WIDTH + iconsWidth + WIN_RATE_COLUMN_WIDTH;
  const height =
    PADDING * 2 + stages.length * ICON_SIZE + (stages.length - 1) * ROW_GAP;

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  context.fillStyle = PANEL_COLOR;
  context.beginPath();
  context.roundRect(0, 0, width, height, CORNER_RADIUS);
  context.fill();

  context.font = LABEL_FONT;
  context.textBaseline = "middle";

  let y = PADDING;
  for (const stage of stages) {
    context.fillStyle = LABEL_COLOR;
    context.fillText(stage.label, PADDING, y + ICON_SIZE / 2);

    let x = PADDING + LABEL_COLUMN_WIDTH;
    for (const icon of stage.icons) {
      context.drawImage(icon, x, y, ICON_SIZE, ICON_SIZE);
      x += ICON_SIZE + ICON_GAP;
    }

    if (stage.winRate !== null) {
      context.fillStyle = WIN_RATE_COLOR;
      context.textAlign = "right";
      context.fillText(
        `${formatRate(stage.winRate)} win`,
        width - PADDING,
        y + ICON_SIZE / 2,
      );
      context.textAlign = "left";
    }

    y += ICON_SIZE + ROW_GAP;
  }

  return canvas.toBuffer("image/png");
}
