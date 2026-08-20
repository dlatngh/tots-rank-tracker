// gifenc ships no types. Only the three functions the quote renderer uses are
// declared here.
declare module "gifenc" {
  export function quantize(
    rgba: Uint8ClampedArray | Uint8Array,
    maxColors: number,
  ): number[][];

  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: number[][],
  ): Uint8Array;

  export function GIFEncoder(): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: number[][]; delay?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
