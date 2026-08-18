// HTTP endpoint the patch watcher POSTs to. Authenticated with the shared
// secret (same pattern as the autobalance web app). Keeps the bot's only patch
// responsibility to receiving structured changes and fanning them out.

import { Client } from "discord.js";
import { config } from "./config.ts";
import {
  handlePatchNotification,
  isPatchNotification,
  isWatcherError,
  reportWatcherFailure,
} from "./champion-patch.ts";
import { log, logError } from "./log.ts";

const PATCH_PATH = "/internal/patch";
const ERROR_PATH = "/internal/patch-error";

export function startPatchWebhook(client: Client): void {
  Bun.serve({
    port: config.patchWebhookPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        (url.pathname !== PATCH_PATH && url.pathname !== ERROR_PATH)
      ) {
        return new Response("Not found", { status: 404 });
      }
      if (request.headers.get("x-bot-secret") !== config.botSharedSecret) {
        return new Response("Unauthorized", { status: 401 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("Malformed JSON", { status: 400 });
      }

      try {
        if (url.pathname === ERROR_PATH) {
          if (!isWatcherError(body)) {
            return new Response("Invalid payload", { status: 422 });
          }
          await reportWatcherFailure(client, body.message);
          return Response.json({ status: "alerted" });
        }

        if (!isPatchNotification(body)) {
          return new Response("Invalid payload", { status: 422 });
        }
        const status = await handlePatchNotification(client, body);
        return Response.json({ status });
      } catch (err) {
        logError("patch", "webhook handler failed:", err);
        return new Response("Internal error", { status: 500 });
      }
    },
  });

  log(
    "patch",
    `webhook listening on :${config.patchWebhookPort} (${PATCH_PATH}, ${ERROR_PATH})`,
  );
}
