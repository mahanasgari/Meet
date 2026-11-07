// Uploads a file to a private Telegram channel as the store bot (fresh session, nothing saved).
// Usage (inside the music-bot container): node tg-upload.mjs <channel id> <file> <caption>
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
const [channel, file, caption] = process.argv.slice(2);
const c = new TelegramClient(new StringSession(""), Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 5 });
c.setLogLevel("error");
await c.start({ botAuthToken: process.env.TG_STORE_BOT_TOKEN });
const peer = await c.getEntity(Number(channel));
const msg = await c.sendFile(peer, { file, caption, forceDocument: true, workers: 4 });
console.log("SENT message", msg.id, "size", String(msg.media?.document?.size ?? "?"));
await c.disconnect();
process.exit(0);
