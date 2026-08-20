// Renders a quoted conversation as a single image. Discord puts every embed
// image below the text, which scrambles a conversation where pictures and words
// alternate, so the transcript is drawn instead: each line in the order it was
// said, pictures included.
//
// When one of those pictures is an animated gif the transcript is encoded as a
// gif too, so the quote still moves. Everything else comes out as a png.

import { createCanvas, loadImage, type Canvas, type Image } from "@napi-rs/canvas";
import { decompressFrames, parseGIF } from "gifuct-js";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { log, logError } from "./log.ts";

const WIDTH = 760;
const PADDING = 24;
const AVATAR_SIZE = 40;
const AVATAR_GAP = 14;
const NAME_FONT = "600 16px 'Helvetica Neue', Helvetica, Arial, sans-serif";
const TEXT_FONT = "15px 'Helvetica Neue', Helvetica, Arial, sans-serif";
const LINE_HEIGHT = 21;
const NAME_HEIGHT = 24;
const TURN_GAP = 14;
const IMAGE_GAP = 8;
const MAX_IMAGE_HEIGHT = 320;
const MAX_TOTAL_HEIGHT = 4000;
const BACKGROUND = "#313338";
const NAME_COLOR = "#f2f3f5";
const TEXT_COLOR = "#dbdee1";

// Animation is resampled onto one clock: gifs in the same conversation rarely
// share a frame rate, and a quote only has to convey the motion.
const FRAME_DELAY_MS = 100;
const MAX_ANIMATION_MS = 4000;
const MAX_GIF_BYTES = 9 * 1024 * 1024;
const GIF_PALETTE_SIZE = 256;

const CONTENT_X = PADDING + AVATAR_SIZE + AVATAR_GAP;
const CONTENT_WIDTH = WIDTH - CONTENT_X - PADDING;

export interface QuoteEntry {
  speaker: string;
  avatarUrl: string | null;
  text: string;
  imageUrls: string[];
}

export interface RenderedQuote {
  buffer: Buffer;
  fileName: string;
}

interface Animation {
  frames: Canvas[];
  width: number;
  height: number;
  durationMs: number;
}

// A picture in the transcript is either a still or an animation; both know how
// big they are so the layout can be measured before anything is drawn.
interface Media {
  still: Image | null;
  animation: Animation | null;
  width: number;
  height: number;
}

function isGif(bytes: Buffer): boolean {
  return bytes.subarray(0, 3).toString("ascii") === "GIF";
}

// gifuct hands back each frame as a patch to paint over the last one, so the
// frames are composed here into whole pictures the canvas can draw directly.
function composeGifFrames(bytes: Buffer): Animation | null {
  const frameData = new Uint8Array(bytes).buffer;
  const parsed = parseGIF(frameData);
  const patches = decompressFrames(parsed, true);
  if (patches.length <= 1) return null;

  const { width, height } = parsed.lsd;
  const running = createCanvas(width, height);
  const runningContext = running.getContext("2d");
  const patchCanvas = createCanvas(width, height);
  const patchContext = patchCanvas.getContext("2d");

  const frames: Canvas[] = [];
  let durationMs = 0;

  for (const patch of patches) {
    const { top, left, width: patchWidth, height: patchHeight } = patch.dims;
    const imageData = patchContext.createImageData(patchWidth, patchHeight);
    imageData.data.set(patch.patch);
    patchContext.putImageData(imageData, 0, 0);
    runningContext.drawImage(
      patchCanvas,
      0,
      0,
      patchWidth,
      patchHeight,
      left,
      top,
      patchWidth,
      patchHeight,
    );

    const frame = createCanvas(width, height);
    frame.getContext("2d").drawImage(running, 0, 0);
    frames.push(frame);

    // gif delays are in hundredths of a second; a zero delay means "as fast as
    // possible", which browsers treat as 100ms.
    durationMs += (patch.delay || 100);

    // Disposal 2 clears the patch area before the next frame is painted.
    if (patch.disposalType === 2) {
      runningContext.clearRect(left, top, patchWidth, patchHeight);
    }
  }

  return { frames, width, height, durationMs };
}

async function loadMedia(url: string): Promise<Media | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());

    if (isGif(bytes)) {
      const animation = composeGifFrames(bytes);
      if (animation) {
        return {
          still: null,
          animation,
          width: animation.width,
          height: animation.height,
        };
      }
    }

    const still = await loadImage(bytes);
    return { still, animation: null, width: still.width, height: still.height };
  } catch (err) {
    logError("quote", `couldn't load ${url}:`, err);
    return null;
  }
}

async function loadAvatar(url: string | null): Promise<Image | null> {
  if (!url) return null;
  const media = await loadMedia(url);
  return media?.still ?? null;
}

function wrapText(context: any, text: string): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (context.measureText(candidate).width <= CONTENT_WIDTH) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = word;
    }
    lines.push(current);
  }
  return lines;
}

interface DrawableTurn {
  // Null when this turn continues the previous speaker's.
  speaker: string | null;
  avatar: Image | null;
  lines: string[];
  media: Media[];
  height: number;
}

function scaledSize(media: Media): { width: number; height: number } {
  const scale = Math.min(
    CONTENT_WIDTH / media.width,
    MAX_IMAGE_HEIGHT / media.height,
    1,
  );
  return { width: media.width * scale, height: media.height * scale };
}

async function buildTurns(
  entries: QuoteEntry[],
  context: any,
): Promise<DrawableTurn[]> {
  const turns: DrawableTurn[] = [];
  let previousSpeaker: string | null = null;

  for (const entry of entries) {
    const loaded = await Promise.all(entry.imageUrls.map(loadMedia));
    const media = loaded.filter((item): item is Media => item !== null);

    context.font = TEXT_FONT;
    const lines = entry.text ? wrapText(context, entry.text) : [];
    if (lines.length === 0 && media.length === 0) continue;

    const isNewSpeaker = entry.speaker !== previousSpeaker;
    previousSpeaker = entry.speaker;

    const mediaHeight = media.reduce(
      (total, item) => total + scaledSize(item).height + IMAGE_GAP,
      0,
    );
    turns.push({
      speaker: isNewSpeaker ? entry.speaker : null,
      avatar: isNewSpeaker ? await loadAvatar(entry.avatarUrl) : null,
      lines,
      media,
      height:
        (isNewSpeaker ? NAME_HEIGHT + TURN_GAP : 0) +
        lines.length * LINE_HEIGHT +
        mediaHeight,
    });
  }
  return turns;
}

function drawAvatar(context: any, avatar: Image, x: number, y: number): void {
  context.save();
  context.beginPath();
  context.arc(
    x + AVATAR_SIZE / 2,
    y + AVATAR_SIZE / 2,
    AVATAR_SIZE / 2,
    0,
    Math.PI * 2,
  );
  context.clip();
  context.drawImage(avatar, x, y, AVATAR_SIZE, AVATAR_SIZE);
  context.restore();
}

// Where an animation ended up on the page, so each output frame can repaint
// just that rectangle over the otherwise static transcript.
interface AnimationSlot {
  animation: Animation;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Transcript {
  canvas: Canvas;
  slots: AnimationSlot[];
}

function drawTranscript(turns: DrawableTurn[]): Transcript {
  const contentHeight = turns.reduce((total, turn) => total + turn.height, 0);
  const height = Math.min(PADDING * 2 + contentHeight, MAX_TOTAL_HEIGHT);

  const canvas = createCanvas(WIDTH, height);
  const context = canvas.getContext("2d");
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, WIDTH, height);
  context.textBaseline = "top";

  const slots: AnimationSlot[] = [];
  let y = PADDING;

  for (const turn of turns) {
    if (y + turn.height > height - PADDING && turn !== turns[0]) break;

    if (turn.speaker) {
      y += TURN_GAP;
      if (turn.avatar) drawAvatar(context, turn.avatar, PADDING, y);
      context.font = NAME_FONT;
      context.fillStyle = NAME_COLOR;
      context.fillText(turn.speaker, CONTENT_X, y + 2);
      y += NAME_HEIGHT;
    }

    context.font = TEXT_FONT;
    context.fillStyle = TEXT_COLOR;
    for (const line of turn.lines) {
      context.fillText(line, CONTENT_X, y);
      y += LINE_HEIGHT;
    }

    for (const item of turn.media) {
      const { width, height: mediaHeight } = scaledSize(item);
      if (item.animation) {
        slots.push({
          animation: item.animation,
          x: CONTENT_X,
          y,
          width,
          height: mediaHeight,
        });
        // The first frame stands in wherever the animation is not playing.
        context.drawImage(
          item.animation.frames[0]!,
          CONTENT_X,
          y,
          width,
          mediaHeight,
        );
      } else if (item.still) {
        context.drawImage(item.still, CONTENT_X, y, width, mediaHeight);
      }
      y += mediaHeight + IMAGE_GAP;
    }
  }

  return { canvas, slots };
}

// Which frame of an animation is showing at a given point on the shared clock.
function frameAt(animation: Animation, elapsedMs: number): Canvas {
  const position = elapsedMs % animation.durationMs;
  const index = Math.floor(
    (position / animation.durationMs) * animation.frames.length,
  );
  return animation.frames[Math.min(index, animation.frames.length - 1)]!;
}

function encodeAnimation(transcript: Transcript): Buffer | null {
  const { canvas, slots } = transcript;
  const longest = Math.max(...slots.map((slot) => slot.animation.durationMs));
  const durationMs = Math.min(longest, MAX_ANIMATION_MS);
  const frameCount = Math.max(2, Math.round(durationMs / FRAME_DELAY_MS));

  const frameCanvas = createCanvas(canvas.width, canvas.height);
  const context = frameCanvas.getContext("2d");
  const encoder = GIFEncoder();
  let palette: number[][] | null = null;

  for (let index = 0; index < frameCount; index += 1) {
    context.drawImage(canvas, 0, 0);
    for (const slot of slots) {
      context.drawImage(
        frameAt(slot.animation, index * FRAME_DELAY_MS),
        slot.x,
        slot.y,
        slot.width,
        slot.height,
      );
    }

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    // One palette for the whole gif: it keeps the file smaller and stops the
    // text shimmering as colours get requantised frame to frame.
    palette ??= quantize(data, GIF_PALETTE_SIZE);
    encoder.writeFrame(
      applyPalette(data, palette),
      canvas.width,
      canvas.height,
      { palette, delay: FRAME_DELAY_MS },
    );
  }

  encoder.finish();
  const bytes = Buffer.from(encoder.bytes());
  if (bytes.length > MAX_GIF_BYTES) {
    logError(
      "quote",
      `animated transcript came to ${Math.round(bytes.length / 1024 / 1024)}MB; falling back to a still`,
    );
    return null;
  }
  log("quote", `animated transcript: ${frameCount} frames, ${bytes.length}B`);
  return bytes;
}

// Null when nothing could be drawn, so the caller can fall back to a plain
// embed instead of attaching an empty picture.
export async function renderQuoteImage(
  entries: QuoteEntry[],
): Promise<RenderedQuote | null> {
  const measuring = createCanvas(WIDTH, 10).getContext("2d");
  const turns = await buildTurns(entries, measuring);
  if (turns.length === 0) return null;

  const transcript = drawTranscript(turns);

  if (transcript.slots.length > 0) {
    const animated = encodeAnimation(transcript);
    if (animated) return { buffer: animated, fileName: "conversation.gif" };
  }

  return {
    buffer: transcript.canvas.toBuffer("image/png"),
    fileName: "conversation.png",
  };
}
