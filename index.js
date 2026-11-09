require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const Anthropic = require("@anthropic-ai/sdk");
const http = require("http");
const QRCode = require("qrcode");

const OWNER_NAME = process.env.OWNER_NAME || "the owner";
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const MAX_HISTORY = 10;
const REPLY_COOLDOWN_MS = 3000;
const PAUSE_AFTER_OWNER_REPLY_MS = 60 * 60 * 1000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let botEnabled = true;
const history = new Map();
const lastReply = new Map();
const pausedUntil = new Map();

const SYSTEM_PROMPT = `You are an AI assistant replying on WhatsApp on behalf of ${OWNER_NAME}, who is currently offline.
- Say once, at the start of a conversation, that you're ${OWNER_NAME}'s AI assistant.
- Keep replies short, friendly and natural, like a WhatsApp message.
- Help with simple questions. Take messages and note what the person needs.
- Never make commitments, promises, payments, or share private info on ${OWNER_NAME}'s behalf.
- If something is urgent or sensitive, say you'll pass it on and that ${OWNER_NAME} will reply when back.
- Reply in the same language the person uses.`;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.SESSION_PATH || "./.wwebjs_auth" }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  },
});

let latestQR = null;
let isReady = false;
const QR_KEY = process.env.QR_KEY || "change-me";

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/qr") {
      if (url.searchParams.get("key") !== QR_KEY) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      if (isReady) return res.end("<h2>WhatsApp is linked and running.</h2>");
      if (!latestQR) return res.end("<h3>QR not ready yet. Refresh in a few seconds.</h3><script>setTimeout(()=>location.reload(),4000)</script>");
      const img = await QRCode.toDataURL(latestQR, { width: 320 });
      return res.end(`<h3>WhatsApp > Linked Devices > Link a device</h3><img src="${img}"><script>setTimeout(()=>location.reload(),15000)</script>`);
    }
    res.writeHead(200).end("OK");
  })
  .listen(process.env.PORT || 3000);

client.on("qr", (qr) => {
  latestQR = qr;
  console.log("QR received. Open /qr?key=YOUR_KEY in your browser to scan.");
});

client.on("ready", () => {
  isReady = true;
  latestQR = null;
  console.log("Bot is ready.");
});

client.on("disconnected", (reason) => {
  console.log("Disconnected:", reason);
  process.exit(1);
});

client.on("message_create", async (msg) => {
  if (!msg.fromMe) return;
  const me = client.info.wid._serialized;

  if (msg.to === me) {
    const cmd = msg.body.trim().toLowerCase();
    if (cmd === "!off") {
      botEnabled = false;
      await client.sendMessage(me, "🤖 Bot is OFF.");
    } else if (cmd === "!on") {
      botEnabled = true;
      await client.sendMessage(me, "🤖 Bot is ON.");
    } else if (cmd === "!status") {
      await client.sendMessage(me, `🤖 Bot is ${botEnabled ? "ON" : "OFF"}.`);
    } else if (cmd === "!clear") {
      history.clear();
      await client.sendMessage(me, "🤖 Memory cleared.");
    }
    return;
  }

  pausedUntil.set(msg.to, Date.now() + PAUSE_AFTER_OWNER_REPLY_MS);
});

client.on("message", async (msg) => {
  try {
    if (!botEnabled) return;
    if (msg.fromMe || msg.isStatus) return;

    const chat = await msg.getChat();
    if (chat.isGroup) return;

    const id = msg.from;
    if (Date.now() < (pausedUntil.get(id) || 0)) return;
    if (Date.now() - (lastReply.get(id) || 0) < REPLY_COOLDOWN_MS) return;

    if (!msg.body) {
      await msg.reply("I can only read text messages for now 🙂");
      return;
    }

    const msgs = history.get(id) || [];
    msgs.push({ role: "user", content: msg.body });
    while (msgs.length > MAX_HISTORY) msgs.shift();
    if (msgs[0].role !== "user") msgs.shift();

    await chat.sendStateTyping();

    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: msgs,
    });

    const reply = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!reply) return;

    msgs.push({ role: "assistant", content: reply });
    history.set(id, msgs);
    lastReply.set(id, Date.now());

    await msg.reply(reply);
  } catch (err) {
    console.error("Error handling message:", err.message);
  }
});

client.initialize();
