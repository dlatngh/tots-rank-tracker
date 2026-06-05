// ANSI-colored log prefixes. Wraps console.log so each subsystem's lines are
// scannable at a glance in the terminal.

const RESET = "\x1b[0m";
const COLORS: Record<string, string> = {
  cmd: "\x1b[36m", // cyan
  btn: "\x1b[35m", // magenta
  riot: "\x1b[31m", // red
  henrik: "\x1b[32m", // green
  cache: "\x1b[34m", // blue
  valapi: "\x1b[90m", // gray
};

function color(tag: string): string {
  const code = COLORS[tag] ?? "\x1b[37m";
  return `${code}[${tag}]${RESET}`;
}

export function log(tag: string, ...args: unknown[]): void {
  console.log(color(tag), ...args);
}

export function logError(tag: string, ...args: unknown[]): void {
  console.error(`\x1b[31m[${tag}]${RESET}`, ...args);
}
