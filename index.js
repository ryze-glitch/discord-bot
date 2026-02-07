"use strict";

require("dotenv").config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  MessageType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");

// ================== OPTIONAL LIBS ==================
let Canvas = null;
try {
  Canvas = require("@napi-rs/canvas");
} catch {
  Canvas = null;
  console.log("⚠️ Manca @napi-rs/canvas: il banner con testo non verrà generato.");
}

let discordTranscripts = null;
try {
  discordTranscripts = require("discord-html-transcripts");
} catch {
  discordTranscripts = null;
  console.log("⚠️ Installa discord-html-transcripts: npm i discord-html-transcripts");
}

// ================== CONFIG ==================
const TOKEN = process.env.DISCORD_TOKEN;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const PREFIX = process.env.PREFIX || "!";
const BANNER_URL = process.env.BANNER_URL || process.env.IMAGE_URL || "";

const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID || "1467257072243703828";
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;

// ✅ Pannello ticket consentito SOLO in questo canale (mettilo nei secrets)
const TICKET_PANEL_CHANNEL_ID = process.env.TICKET_PANEL_CHANNEL_ID || "";

const ALWAYS_OPEN_ROLE_ID = process.env.ALWAYS_OPEN_ROLE_ID || "1463112389296918599";
const TICKET_CLOSE_ROLE_ID = process.env.TICKET_CLOSE_ROLE_ID || "1461816600733815090";
const LOG_FOOTER_USER_ID = process.env.LOG_FOOTER_USER_ID || "1387684968536477756";

const TICKET_TITLE_EMOJI = process.env.TICKET_TITLE_EMOJI || "🎫";
const WELCOME_THUMB_URL = process.env.WELCOME_THUMB_URL || "https://i.imgur.com/wUuHZUk.png";

// Canali
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || "";
const GOODBYE_CHANNEL_ID = process.env.GOODBYE_CHANNEL_ID || "";

// ✅ Ruolo auto-assegnato all’ingresso
const AUTO_JOIN_ROLE_ID = process.env.AUTO_JOIN_ROLE_ID || "1466504639682973940";

// ✅ Base banner (1200x450)
const WELCOME_BANNER_URL = process.env.WELCOME_BANNER_URL || "https://imgur.com/h1xLKDZ";
const WELCOME_BANNER_PATH = process.env.WELCOME_BANNER_PATH || "";

// Font (file ttf in repo)
const WELCOME_FONT_FAMILY = process.env.WELCOME_FONT_FAMILY || "Lexend";

// Redis (opzionale)
const REDIS_URL = process.env.REDIS_URL || "";

// ✅ Emoji custom per titolo welcome
const WELCOME_TITLE_EMOJI = "<:icona_ticket:1467182266554908953>";

// ================== CHECK ==================
if (!TOKEN) throw new Error("DISCORD_TOKEN mancante nel .env");
if (!STAFF_ROLE_ID) throw new Error("STAFF_ROLE_ID mancante nel .env");
if (!CLIENT_ID) throw new Error("CLIENT_ID mancante nel .env");
if (!GUILD_ID) throw new Error("GUILD_ID mancante nel .env");

// ================== REDIS OPTIONAL ==================
let redis = null;
if (REDIS_URL) {
  try {
    const Redis = require("ioredis");
    redis = new Redis(REDIS_URL, { lazyConnect: true });
  } catch {
    console.log("⚠️ REDIS_URL impostato ma ioredis non installato: npm i ioredis");
  }
}

// ================== DATA DIR ==================
const BASE_DATA_DIR = path.join(os.tmpdir(), `famiglia-gotti-bot-${CLIENT_ID}`);
const LOCKS_DIR = path.join(BASE_DATA_DIR, "locks");
const IDEM_DIR = path.join(LOCKS_DIR, "idem");
const INSTANCE_LOCK_DIR = path.join(LOCKS_DIR, "instance.lockdir");

const PANEL_STATE_FILE = path.join(BASE_DATA_DIR, "panel_state.json");
const TRANSCRIPTS_DIR = path.join(BASE_DATA_DIR, "transcripts");
const TRANSCRIPTS_INDEX_FILE = path.join(BASE_DATA_DIR, "transcripts_index.json");

const LOCK_TTL_MS = 20_000;
const TRANSCRIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureDirsSync() {
  fs.mkdirSync(BASE_DATA_DIR, { recursive: true });
  fs.mkdirSync(LOCKS_DIR, { recursive: true });
  fs.mkdirSync(IDEM_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}
ensureDirsSync();

// ================== LOCK UTILS ==================
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function readPidFromLockDir(lockDir) {
  try {
    const p = fs.readFileSync(path.join(lockDir, "pid.txt"), "utf8").trim();
    const pid = Number(p);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
function removeDirSync(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}
async function acquireDirLock(baseDir, key, ttlMs = LOCK_TTL_MS) {
  const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, "_");
  const lockPath = path.join(baseDir, safe);

  try {
    const st = await fsp.stat(lockPath);
    const age = Date.now() - (st.mtimeMs || 0);
    if (age > ttlMs) await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  } catch {}

  try {
    await fsp.mkdir(lockPath);
    await fsp.writeFile(path.join(lockPath, "pid.txt"), String(process.pid)).catch(() => {});
    return { ok: true, path: lockPath };
  } catch {
    return { ok: false, path: lockPath };
  }
}
async function releaseDirLock(lockPath) {
  if (!lockPath) return;
  await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
}
async function acquireGlobalLock(key, ttlMs = LOCK_TTL_MS) {
  if (redis) {
    try {
      if (redis.status !== "ready") await redis.connect().catch(() => {});
      const ok = await redis.set(`lock:${key}`, String(process.pid), "PX", ttlMs, "NX");
      return { ok: ok === "OK", release: async () => {} };
    } catch {}
  }
  const lock = await acquireDirLock(IDEM_DIR, key, ttlMs);
  return { ok: lock.ok, release: async () => releaseDirLock(lock.path) };
}

// ================== SINGLE INSTANCE (nodemon-safe) ==================
async function acquireInstanceLockOrExit() {
  if (fs.existsSync(INSTANCE_LOCK_DIR)) {
    const pid = readPidFromLockDir(INSTANCE_LOCK_DIR);
    if (pid && isPidAlive(pid)) {
      console.error(`❌ Doppia istanza sullo stesso host (PID attivo: ${pid}). Stop.`);
      process.exit(1);
    }
    removeDirSync(INSTANCE_LOCK_DIR);
  }

  try {
    fs.mkdirSync(INSTANCE_LOCK_DIR);
    fs.writeFileSync(path.join(INSTANCE_LOCK_DIR, "pid.txt"), String(process.pid));
  } catch {
    console.error("❌ Non riesco a creare instance lock. Stop.");
    process.exit(1);
  }

  const keepAlive = setInterval(() => {
    fsp.utimes(INSTANCE_LOCK_DIR, new Date(), new Date()).catch(() => {});
  }, 30_000);
  keepAlive.unref?.();

  const cleanup = () => {
    clearInterval(keepAlive);
    removeDirSync(INSTANCE_LOCK_DIR);
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  process.once("SIGUSR2", () => {
    cleanup();
    process.kill(process.pid, "SIGUSR2");
  });

  process.on("uncaughtException", (e) => {
    console.error(e);
    cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    console.error(e);
    cleanup();
    process.exit(1);
  });
}

// ================== CLIENT ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ================== STATE ==================
let transcriptIndex = new Map();
const closingInProcess = new Set();
const openingInProcess = new Map();

// ================== HELPERS ==================
function isValidHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeImgurToDirectCandidates(url) {
  if (!url || typeof url !== "string") return [url];
  const u = url.trim();

  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);

    if ((host === "imgur.com" || host === "www.imgur.com") && parts.length >= 1) {
      const id = parts[0];
      if (id && !id.includes(".") && id !== "a" && id !== "gallery") {
        return [
          `https://i.imgur.com/${id}.jpg`,
          `https://i.imgur.com/${id}.jpeg`,
          `https://i.imgur.com/${id}.png`,
        ];
      }
    }

    if (host === "i.imgur.com" && parts.length >= 1) {
      const last = parts[parts.length - 1];
      if (last && !last.includes(".")) {
        return [
          `https://i.imgur.com/${last}.jpg`,
          `https://i.imgur.com/${last}.jpeg`,
          `https://i.imgur.com/${last}.png`,
        ];
      }
    }

    return [u];
  } catch {
    return [u];
  }
}

function sanitizeForChannelUsername(username) {
  const s = String(username || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return s || "utente";
}

function hasRole(memberOrInteraction, roleId) {
  const member = memberOrInteraction?.member ?? memberOrInteraction;
  return member?.roles?.cache?.has(roleId);
}

function isAdmin(memberOrInteraction) {
  const member = memberOrInteraction?.member ?? memberOrInteraction;
  return !!member?.permissions?.has?.(PermissionFlagsBits.Administrator);
}

async function notifyUserPrivate(msg, text) {
  await msg.delete().catch(() => {});
  const dmOk = await msg.author.send(text).then(() => true).catch(() => false);
  if (!dmOk) {
    const r = await msg.channel.send({ content: `<@${msg.author.id}> ${text}` }).catch(() => null);
    if (r) setTimeout(() => r.delete().catch(() => {}), 5000).unref?.();
  }
}

function canCloseTicketFromMember(member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  return member.roles?.cache?.has(TICKET_CLOSE_ROLE_ID);
}

function canCloseTicketFromInteraction(interaction) {
  return canCloseTicketFromMember(interaction?.member);
}

function isTicketChannel(channel) {
  return channel?.type === ChannelType.GuildText && typeof channel.name === "string" && channel.name.includes("ticket-");
}

function resolveTicketParentId(guild) {
  if (!TICKET_CATEGORY_ID) return null;
  const ch = guild.channels.cache.get(TICKET_CATEGORY_ID);
  if (!ch) return null;
  if (ch.type !== ChannelType.GuildCategory) return null;
  return ch.id;
}

function channelNameForTicket(ticketType, username) {
  const u = sanitizeForChannelUsername(username);
  if (ticketType === "Braccio Armato") return `🔫・ticket-${u}`;
  if (ticketType === "Informativa") return `📄・ticket-${u}`;
  return `ticket-${u}`;
}

function topicForTicket(ticketType, userId) {
  return `**Categoria:** ${ticketType} | **Utente:** <@${userId}>`;
}

async function findExistingTicketFresh(guild, userId) {
  await guild.channels.fetch().catch(() => null);
  return guild.channels.cache.find(
    (c) => c?.type === ChannelType.GuildText && typeof c.topic === "string" && c.topic.includes(`<@${userId}>`)
  );
}

function extractUserIdFromTopic(topic) {
  if (!topic || typeof topic !== "string") return null;
  const m = topic.match(/<@(\d{17,20})>/);
  return m ? m[1] : null;
}

function extractCategoryFromTopic(topic) {
  if (!topic || typeof topic !== "string") return "Sconosciuta";
  const m = topic.match(/\*\*Categoria:\*\*\s*([^|]+)\s*\|/);
  return m ? m[1].trim() : "Sconosciuta";
}

function formatRomeHHMM(date = new Date()) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function lockUserOpen(userId, ttlMs = 15_000) {
  const now = Date.now();
  const last = openingInProcess.get(userId);
  if (last && now - last < ttlMs) return false;
  openingInProcess.set(userId, now);
  setTimeout(() => {
    const v = openingInProcess.get(userId);
    if (v === now) openingInProcess.delete(userId);
  }, ttlMs).unref?.();
  return true;
}

// ================== SUPPORT HOURS ==================
function minutesNowRome() {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}
function weekdayRome() {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", weekday: "short" })
    .format(new Date())
    .toLowerCase();
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return map[wd] ?? 0;
}
function isWithinSupportHoursRome() {
  const day = weekdayRome();
  const now = minutesNowRome();
  const mins = (h, m) => h * 60 + m;
  if (day >= 1 && day <= 5) return now >= mins(12, 0);
  if (day === 6) return now >= mins(10, 30) || now < mins(1, 30);
  return now >= mins(10, 30);
}

const CLOSED_MESSAGE =
  "Al Momento non è possibile Aprire Nuovi Ticket. Ti Invitiamo a riprovare durante i nostri **Orari di Supporto:**\n" +
  "- Lunedì - Venerdì: 12:00 - 00:00\n" +
  "- Sabato: 10:30 - 01:30\n" +
  "- Domenica: 10:30 - 00:00\n\n" +
  `**Per Aprire Ticket anche al di fuori degli Orari di Supporto Acquista ora l'@&${ALWAYS_OPEN_ROLE_ID} a 4,99€ per ottenere assistenza rapida senza tempi di Attesa per qualsiasi tipo di problema o richiesta!**`;

// ================== WELCOME BANNER (Canvas) ==================
const BANNER_W = 1200;
const BANNER_H = 450;

let __FONT_DONE = false;
function registerWelcomeFontOnce() {
  if (__FONT_DONE) return;
  __FONT_DONE = true;

  if (!Canvas?.GlobalFonts) return;
  if (Canvas.GlobalFonts.has?.(WELCOME_FONT_FAMILY)) return;

  const candidates = [
    path.join(__dirname, "static", "Lexend-VariableFont_wght.ttf"),
    path.join(__dirname, "Lexend-VariableFont_wght.ttf"),
    path.join(__dirname, "static", "fonts", "Lexend-VariableFont_wght.ttf"),
    path.join(__dirname, "assets", "fonts", "Lexend-VariableFont_wght.ttf"),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        Canvas.GlobalFonts.registerFromPath(p, WELCOME_FONT_FAMILY);
        return;
      }
    } catch {}
  }
}

async function fetchToBuffer(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs).unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(t);
  }
}

async function loadImageSmart(source) {
  try {
    return await Canvas.loadImage(source);
  } catch {
    if (typeof source === "string" && isValidHttpUrl(source)) {
      const buf = await fetchToBuffer(source);
      return await Canvas.loadImage(buf);
    }
    throw new Error("loadImage failed");
  }
}

let cachedBaseBanner = null;
async function loadBaseBannerImage() {
  if (!Canvas) return null;
  if (cachedBaseBanner) return cachedBaseBanner;

  const local = (WELCOME_BANNER_PATH || "").trim();
  if (local) {
    try {
      cachedBaseBanner = await loadImageSmart(local);
      return cachedBaseBanner;
    } catch {}
  }

  const candidates = normalizeImgurToDirectCandidates((WELCOME_BANNER_URL || "").trim());
  for (const u of candidates) {
    try {
      cachedBaseBanner = await loadImageSmart(u);
      return cachedBaseBanner;
    } catch {}
  }

  return null;
}

function drawContain(ctx, img, x, y, w, h) {
  const iw = img.width;
  const ih = img.height;
  const imgRatio = iw / ih;
  const canvasRatio = w / h;

  let dw, dh, dx, dy;

  if (imgRatio >= canvasRatio) {
    dw = w;
    dh = dw / imgRatio;
    dx = x;
    dy = y + (h - dh) / 2;
  } else {
    dh = h;
    dw = dh * imgRatio;
    dx = x + (w - dw) / 2;
    dy = y;
  }

  ctx.drawImage(img, dx, dy, dw, dh);
}

function fitFont(ctx, text, maxWidth, startPx, minPx, weight = 900, family = "sans-serif") {
  const t = String(text ?? "");
  let size = startPx;
  while (size > minPx) {
    ctx.font = `${weight} ${size}px "${family}"`;
    if (ctx.measureText(t).width <= maxWidth) return size;
    size -= 2;
  }
  return minPx;
}

function drawCenteredText(ctx, text, x, y, font, fill, stroke, strokeW, shadow = true) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = font;

  if (shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 5;
  }

  if (stroke) {
    ctx.lineWidth = strokeW;
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
  }

  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

async function getFreshMemberCount(guild) {
  let count = guild?.memberCount ?? 0;
  try {
    const fresh = await guild.fetch();
    if (typeof fresh?.memberCount === "number") count = fresh.memberCount;
  } catch {}
  return count;
}

async function renderWelcomeBanner(member) {
  if (!Canvas) return null;

  registerWelcomeFontOnce();

  const canvas = Canvas.createCanvas(BANNER_W, BANNER_H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0b0710";
  ctx.fillRect(0, 0, BANNER_W, BANNER_H);

  const base = await loadBaseBannerImage();
  if (base) {
    drawContain(ctx, base, 0, 0, BANNER_W, BANNER_H);

    const g = ctx.createLinearGradient(0, 0, 0, BANNER_H);
    g.addColorStop(0, "rgba(0,0,0,0.12)");
    g.addColorStop(0.55, "rgba(0,0,0,0.16)");
    g.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, BANNER_W, BANNER_H);
  }

  const cx = BANNER_W / 2;

  const avatarUrl = member.user.displayAvatarURL({ extension: "png", size: 256 });
  let avatar = null;
  try {
    avatar = await loadImageSmart(avatarUrl);
  } catch {}

  const avatarY = 104;
  const r = 62;

  ctx.beginPath();
  ctx.arc(cx, avatarY, r + 12, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, avatarY, r + 5, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fill();

  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, avatarY, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, cx - r, avatarY - r, r * 2, r * 2);
    ctx.restore();
  }

  const family = WELCOME_FONT_FAMILY || "sans-serif";
  const title = "BENVENUTO!";
  const name = (member.displayName || member.user.username || "UTENTE").toUpperCase();

  const memberNumber = await getFreshMemberCount(member.guild);

  // ✅ riga finale aggiornata (N° + numero)
  const countLine = `Sei il Membro N° ${memberNumber}`;

  drawCenteredText(ctx, title, cx, 265, `900 86px "${family}"`, "#ffffff", "rgba(0,0,0,0.45)", 8, true);

  const nameSize = fitFont(ctx, name, 1080, 68, 26, 900, family);
  drawCenteredText(ctx, name, cx, 330, `900 ${nameSize}px "${family}"`, "#ff2b2b", "rgba(0,0,0,0.50)", 7, true);

  drawCenteredText(ctx, countLine, cx, 395, `700 30px "${family}"`, "rgba(255,255,255,0.90)", "rgba(0,0,0,0.35)", 5, false);

  return canvas.toBuffer("image/png");
}

// ================== WELCOME MESSAGE (Components V2) ==================
function buildWelcomeContainerV2({ userId, fileName, hhmm }) {
  return [
    {
      type: 17,
      components: [
        // ✅ titolo con emoji custom davanti
        { type: 10, content: `# ${WELCOME_TITLE_EMOJI} **Fam. Gotti - Sez. Benvenuto**` },
        { type: 14, divider: false, spacing: 1 },
        // ✅ testo richiesto
        { type: 10, content: `Ciao! <@${userId}>, benvenuto nel **Server Discord della Famiglia Gotti.**` },
        { type: 14, divider: true, spacing: 2 },
        { type: 12, items: [{ description: "Welcome banner", media: { url: `attachment://${fileName}` } }] },
        { type: 14, divider: true, spacing: 2 },
        { type: 10, content: `-# 👋・**Sistema di Benvenuto by Ryze** - Oggi alle ${hhmm}` },
      ],
    },
  ];
}

async function sendWelcomeV2(member) {
  if (!WELCOME_CHANNEL_ID) return;

  const ch = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased?.()) return;

  const lock = await acquireGlobalLock(`welcome:welcome:${member.guild.id}:${member.id}`, 60_000);
  if (!lock.ok) return;

  try {
    const buf = await renderWelcomeBanner(member);
    if (!buf) return;

    const fileName = "welcome-banner.png";
    const file = new AttachmentBuilder(buf, { name: fileName });
    const hhmm = formatRomeHHMM(new Date());

    await ch.send({
      flags: MessageFlags.IsComponentsV2,
      components: buildWelcomeContainerV2({ userId: member.id, fileName, hhmm }),
      files: [file],
      allowedMentions: { users: [member.id], roles: [], repliedUser: false },
    });
  } catch {
    // ignore
  } finally {
    await lock.release();
  }
}

async function sendGoodbyeSimple(member) {
  if (!GOODBYE_CHANNEL_ID) return;

  const ch = await member.guild.channels.fetch(GOODBYE_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased?.()) return;

  const userId = member.user?.id || member.id;
  const guildName = member.guild?.name || "questo server";

  await ch
    .send({
      content: `Addio, <@${userId}> ha **Abbandonato la ${guildName}.**`,
      allowedMentions: { users: [userId], roles: [], repliedUser: false },
    })
    .catch(() => {});
}

// ================== TICKET PANEL UI ==================
function buildTicketPanelComponents() {
  const hhmm = formatRomeHHMM(new Date());

  const inner = [
    { type: 10, content: `# <:icona_ticket:1467182266554908953> Famiglia Gotti – Ticket Fazione` },
    { type: 14, divider: false, spacing: 1 },
    { type: 10, content: "**Seleziona una delle Seguenti Opzioni in Base alla Desiderata:**" },
    { type: 14, divider: false, spacing: 1 },
    { type: 10, content: "- **🕒・Orario di Controllo Ticket**: 10:00 - 00:00" },
    { type: 14, divider: true, spacing: 2 },
  ];

  if (isValidHttpUrl(BANNER_URL)) inner.push({ type: 12, items: [{ media: { url: BANNER_URL } }] });

  inner.push(
    { type: 14, divider: true, spacing: 2 },
    {
      type: 1,
      components: [
        { type: 2, style: 1, custom_id: "ticket_btn_braccio", label: "🔫・Ticket Braccio Armato" },
        { type: 2, style: 4, custom_id: "ticket_btn_info", label: "📄・Ticket Informativa" },
        { type: 2, style: 3, custom_id: "ticket_btn_wl", label: "🛠️・Ticket Fazionati", disabled: true },
      ],
    },
    { type: 14, divider: true, spacing: 2 },
    { type: 10, content: `-# 📦・**Sistema di Ticket by Ryze - Oggi alle ${hhmm}**` }
  );

  return [{ type: 17, components: inner }];
}

// ================== PANEL STATE ==================
async function loadPanelState() {
  try {
    const raw = await fsp.readFile(PANEL_STATE_FILE, "utf8");
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}
async function savePanelState(obj) {
  await fsp.writeFile(PANEL_STATE_FILE, JSON.stringify(obj, null, 2), "utf8").catch(() => {});
}
async function getPanelMessageId(guildId, channelId) {
  const key = `panel:${guildId}:${channelId}`;
  if (redis) {
    try {
      if (redis.status !== "ready") await redis.connect().catch(() => {});
      return await redis.get(key);
    } catch {}
  }
  const state = await loadPanelState();
  return state[key] || null;
}
async function setPanelMessageId(guildId, channelId, messageId) {
  const key = `panel:${guildId}:${channelId}`;
  if (redis) {
    try {
      if (redis.status !== "ready") await redis.connect().catch(() => {});
      await redis.set(key, messageId);
      return;
    } catch {}
  }
  const state = await loadPanelState();
  state[key] = messageId;
  await savePanelState(state);
}
async function upsertTicketPanel(channel) {
  const lock = await acquireGlobalLock(`panel:${channel.guild.id}:${channel.id}`, 10_000);
  if (!lock.ok) return null;

  try {
    const existingId = await getPanelMessageId(channel.guild.id, channel.id);
    if (existingId) {
      const existing = await channel.messages.fetch(existingId).catch(() => null);
      if (existing && existing.author?.id === client.user.id) {
        await existing.edit({ components: buildTicketPanelComponents(), allowedMentions: { parse: [] } }).catch(() => {});
        return existing;
      }
    }

    const sent = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: buildTicketPanelComponents(),
      allowedMentions: { parse: [] },
    });

    await setPanelMessageId(channel.guild.id, channel.id, sent.id);
    return sent;
  } finally {
    await lock.release();
  }
}

// ================== TICKET WELCOME (nel ticket) ==================
function buildTicketWelcomeEmbed() {
  return new EmbedBuilder()
    .setTitle("Benvenuto nel Sistema Ticket della Famiglia Gotti <:icona_ticket:1467182266554908953>")
    .setDescription("Esponi il Tuo Problema Verrai Assisstito a Breve in Base alla Categoria del Ticket Selezionata.")
    .setThumbnail(WELCOME_THUMB_URL)
    .setColor(0xed4245);
}
function buildCloseButtonRow() {
  const btn = new ButtonBuilder().setCustomId("ticket_close_now").setStyle(ButtonStyle.Danger).setLabel("🔐・Chiudi Ticket");
  return new ActionRowBuilder().addComponents(btn);
}
async function pinAndCleanupPinSystemMessage(msg) {
  try {
    await msg.pin("Ticket header");
  } catch {
    return;
  }
  try {
    const recent = await msg.channel.messages.fetch({ limit: 5 });
    const sysPin = recent.find((m) => m.type === MessageType.ChannelPinnedMessage);
    if (sysPin) await sysPin.delete().catch(() => {});
  } catch {}
}
async function sendTicketWelcome(channel, guildName, userId) {
  const m = await channel.send({
    content: `Benvenuto <@${userId}> nel Sistema Ticket della **${guildName}**`,
    embeds: [buildTicketWelcomeEmbed()],
    components: [buildCloseButtonRow()],
    allowedMentions: { users: [userId], roles: [], repliedUser: false },
  });
  pinAndCleanupPinSystemMessage(m).catch(() => {});
}

// ================== TRANSCRIPTS ==================
async function loadTranscriptIndex() {
  try {
    const raw = await fsp.readFile(TRANSCRIPTS_INDEX_FILE, "utf8");
    const json = JSON.parse(raw || "{}");
    transcriptIndex = new Map(Object.entries(json || {}));
  } catch {
    transcriptIndex = new Map();
  }
}
async function saveTranscriptIndex() {
  const obj = Object.fromEntries(transcriptIndex.entries());
  await fsp.writeFile(TRANSCRIPTS_INDEX_FILE, JSON.stringify(obj, null, 2), "utf8").catch(() => {});
}
async function cleanupOldTranscripts() {
  const now = Date.now();
  let changed = false;

  for (const [token, meta] of transcriptIndex.entries()) {
    const createdAt = Number(meta?.createdAt || 0);
    if (!createdAt) continue;
    if (now - createdAt <= TRANSCRIPT_TTL_MS) continue;
    await fsp.unlink(meta.file).catch(() => {});
    transcriptIndex.delete(token);
    changed = true;
  }

  if (changed) await saveTranscriptIndex();
}
async function buildTranscriptHtml(channel) {
  if (!discordTranscripts) return null;
  return discordTranscripts.createTranscript(channel, {
    limit: -1,
    returnType: "string",
    saveImages: false,
    poweredBy: false,
  });
}
function makeToken() {
  return crypto.randomBytes(8).toString("hex");
}

// ================== LOG SEND ==================
async function getLogChannel(guild) {
  const ch = await guild.channels.fetch(TICKET_LOG_CHANNEL_ID).catch(() => null);
  if (!ch) return null;
  if (!ch.isTextBased?.()) return null;
  return ch;
}
function buildTicketLogV2Components({ ticketName, openerId, closedById, category, reason, closedAt, transcriptToken }) {
  const safeReason = (String(reason || "").trim() || "Nessuna motivazione fornita.").slice(0, 900);
  const hhmm = formatRomeHHMM(closedAt || new Date());

  const inner = [
    { type: 10, content: `# <:icona_ticket:1467182266554908953> Famiglia Gotti – Log Ticket` },
    { type: 14, divider: false, spacing: 1 },
    { type: 10, content: `**Ticket:** ${TICKET_TITLE_EMOJI} | \`${ticketName}\`` },
    { type: 10, content: `**Aperto da:** ${openerId ? `<@${openerId}>` : "Sconosciuto"}` },
    { type: 10, content: `**Concluso da:** <@${closedById}>` },
    { type: 10, content: `**Categoria:** ${category || "Sconosciuta"}` },
    { type: 10, content: `**Motivazione:** ${safeReason}` },
    { type: 14, divider: true, spacing: 2 },
    { type: 10, content: `-# **LOG Ticket by <@${LOG_FOOTER_USER_ID}> - Oggi alle ${hhmm}**` },
  ];

  if (transcriptToken) {
    inner.push(
      { type: 14, divider: true, spacing: 2 },
      { type: 1, components: [{ type: 2, style: 1, custom_id: `dl_tr:${transcriptToken}`, label: "⬇️・Scarica Transcript" }] }
    );
  }

  return [{ type: 17, components: inner }];
}
async function sendTicketLogOnce({ guild, uniqueKey, ...data }) {
  const lock = await acquireGlobalLock(`log:${uniqueKey}`, 30_000);
  if (!lock.ok) return;

  try {
    const logChannel = await getLogChannel(guild);
    if (!logChannel) return;

    await logChannel.send({
      flags: MessageFlags.IsComponentsV2,
      components: buildTicketLogV2Components(data),
      allowedMentions: { parse: [] },
    });
  } finally {
    await lock.release();
  }
}

// ================== CLOSE CORE ==================
async function closeTicketCore({ guild, channel, closedById, reason }) {
  if (!guild || !channel) return false;
  if (!isTicketChannel(channel)) return false;

  if (closingInProcess.has(channel.id)) return false;
  closingInProcess.add(channel.id);

  const lock = await acquireGlobalLock(`close:${guild.id}:${channel.id}`, 60_000);
  if (!lock.ok) {
    closingInProcess.delete(channel.id);
    return false;
  }

  try {
    const closedAt = new Date();
    const ticketNameSnapshot = channel.name;
    const openerId = extractUserIdFromTopic(channel.topic);
    const category = extractCategoryFromTopic(channel.topic);

    let transcriptToken = null;
    try {
      const html = await buildTranscriptHtml(channel);
      if (html) {
        transcriptToken = makeToken();
        const fileName = `${sanitizeForChannelUsername(ticketNameSnapshot)}.html`;
        const filePath = path.join(TRANSCRIPTS_DIR, `${transcriptToken}.html`);
        await fsp.writeFile(filePath, html, "utf8");

        transcriptIndex.set(transcriptToken, { file: filePath, name: fileName, createdAt: Date.now() });
        await cleanupOldTranscripts();
        await saveTranscriptIndex();
      }
    } catch {}

    await sendTicketLogOnce({
      guild,
      uniqueKey: `${guild.id}:${channel.id}:${closedAt.getTime()}`,
      ticketName: ticketNameSnapshot,
      openerId,
      closedById,
      category,
      reason: reason || "Chiuso.",
      transcriptToken,
      closedAt,
    });

    setTimeout(() => channel.delete("Chiusura Ticket").catch(() => {}), 1200);
    return true;
  } finally {
    await lock.release();
    closingInProcess.delete(channel.id);
  }
}

// ================== MODAL ==================
function buildCloseReasonModal(channelId) {
  const modal = new ModalBuilder().setCustomId(`ticket_close_reason:${channelId}`).setTitle("Sez. Ticket - Chiudi Ticket");
  const reasonInput = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("❓・Motivazione:")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(400);
  modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
  return modal;
}

// ================== CREATE TICKET ==================
async function createTicketChannel(interaction, ticketType) {
  const guild = interaction.guild;
  const user = interaction.user;

  const lock = await acquireGlobalLock(`open:${guild.id}:${user.id}`, 20_000);
  if (!lock.ok) {
    const existing = await findExistingTicketFresh(guild, user.id);
    return { already: true, channel: existing };
  }

  try {
    const existing = await findExistingTicketFresh(guild, user.id);
    if (existing) return { already: true, channel: existing };

    const parentId = resolveTicketParentId(guild);
    const desiredName = channelNameForTicket(ticketType, user.username);
    const topic = topicForTicket(ticketType, user.id);

    const channel = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildText,
      parent: parentId ?? undefined,
      topic,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });

    sendTicketWelcome(channel, guild.name, user.id).catch(() => {});
    return { already: false, channel };
  } finally {
    await lock.release();
  }
}

// ================== SLASH COMMANDS ==================
const commands = [
  new SlashCommandBuilder().setName("ticketpanel").setDescription("Pannello Ticket - Fam. Gotti"),
].map((c) => c.toJSON());

async function registerCommandsSafe() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// ================== EVENTS ==================
function bindEventsOnce() {
  if (global.__FG_BOUND) return;
  global.__FG_BOUND = true;

  client.on("guildMemberAdd", async (member) => {
    try {
      if (AUTO_JOIN_ROLE_ID) {
        await member.roles.add(AUTO_JOIN_ROLE_ID, "Auto-ruolo ingresso").catch(() => {});
      }
      await sendWelcomeV2(member);
    } catch (e) {
      console.error(e);
    }
  });

  client.on("guildMemberRemove", async (member) => {
    try {
      await sendGoodbyeSimple(member);
    } catch (e) {
      console.error(e);
    }
  });

  client.on("messageCreate", async (msg) => {
    try {
      if (!msg.guild || msg.author.bot) return;
      if (!msg.content.startsWith(PREFIX)) return;

      const raw = msg.content.slice(PREFIX.length).trim();
      const [cmdRaw, ...rest] = raw.split(/\s+/);
      const cmd = (cmdRaw || "").toLowerCase();
      const reason = rest.join(" ").trim();

      // ✅ tutti i comandi testuali: SOLO Amministratori
      const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (!member || !isAdmin(member)) {
        await notifyUserPrivate(msg, "❌ Solo gli **Amministratori** possono usare i comandi del bot in chat.");
        return;
      }

      if (cmd === "ticketpanel") {
        if (TICKET_PANEL_CHANNEL_ID && msg.channel.id !== TICKET_PANEL_CHANNEL_ID) {
          await notifyUserPrivate(msg, "❌ Non è possibile inviare/aggiornare il pannello ticket in questo canale.");
          return;
        }
        await upsertTicketPanel(msg.channel);
        return;
      }

      if (cmd === "chiudi") {
        if (!isTicketChannel(msg.channel)) return;

        await msg.reply("⏳ Chiusura ticket in corso...").catch(() => {});
        await closeTicketCore({
          guild: msg.guild,
          channel: msg.channel,
          closedById: msg.author.id,
          reason: reason || "Chiuso tramite !chiudi",
        });
      }
    } catch (e) {
      console.error(e);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      const idem = await acquireGlobalLock(`ix:${interaction.id}`, 20_000);
      if (!idem.ok) return;

      if (interaction.isChatInputCommand() && interaction.commandName === "ticketpanel") {
        if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
          await interaction
            .reply({ content: "❌ Solo gli **Amministratori** possono usare questo comando.", flags: MessageFlags.Ephemeral })
            .catch(() => {});
          return;
        }
        if (TICKET_PANEL_CHANNEL_ID && interaction.channelId !== TICKET_PANEL_CHANNEL_ID) {
          await interaction.reply({ content: "❌ Non è possibile farlo in questo canale.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        await upsertTicketPanel(interaction.channel);
        await interaction.deleteReply().catch(() => {});
        return;
      }

      if (interaction.isButton() && String(interaction.customId).startsWith("dl_tr:")) {
        const token = interaction.customId.split(":")[1] || "";
        const meta = transcriptIndex.get(token);

        if (!meta?.file) {
          await interaction.reply({ content: "❌ Transcript non disponibile.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }

        try {
          const buf = await fsp.readFile(meta.file);
          const file = new AttachmentBuilder(buf, { name: meta.name || "transcript.html" });
          await interaction.reply({ content: "Ecco il transcript:", files: [file], flags: MessageFlags.Ephemeral }).catch(() => {});
        } catch {
          await interaction.reply({ content: "❌ Impossibile leggere il transcript.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }

      if (interaction.isModalSubmit() && String(interaction.customId).startsWith("ticket_close_reason:")) {
        const channelId = interaction.customId.split(":")[1] || "";
        if (!interaction.guild || !interaction.channel) return;
        if (interaction.channel.id !== channelId) return;

        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ content: "Valido solo nei canali ticket.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        if (!canCloseTicketFromInteraction(interaction)) {
          await interaction.reply({ content: "Non hai permessi.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const reason = String(interaction.fields.getTextInputValue("reason") || "").trim();

        const ok = await closeTicketCore({
          guild: interaction.guild,
          channel: interaction.channel,
          closedById: interaction.user.id,
          reason: reason || "Chiuso (senza motivazione).",
        });

        if (ok) await interaction.deleteReply().catch(() => {});
        else await interaction.editReply("❌ Chiusura già in corso.").catch(() => {});
        return;
      }

      if (interaction.isButton() && ["ticket_btn_braccio", "ticket_btn_info", "ticket_btn_wl"].includes(interaction.customId)) {
        if (interaction.customId === "ticket_btn_wl") {
          await interaction.reply({ content: "Prossimamente...", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }

        const canBypass = hasRole(interaction, ALWAYS_OPEN_ROLE_ID);
        if (!canBypass && !isWithinSupportHoursRome()) {
          await interaction.reply({ content: CLOSED_MESSAGE, flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }

        if (!lockUserOpen(interaction.user.id)) {
          await interaction.reply({ content: "⏳ Ticket già in creazione...", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }

        await interaction.reply({ content: "⏳ Sto creando il ticket...", flags: MessageFlags.Ephemeral }).catch(() => {});
        const ticketType = interaction.customId === "ticket_btn_braccio" ? "Braccio Armato" : "Informativa";

        const res = await createTicketChannel(interaction, ticketType);
        if (res.already && res.channel) return interaction.editReply({ content: `Hai già un ticket aperto: ${res.channel}` }).catch(() => {});
        if (res.already) return interaction.editReply({ content: "Hai già un ticket aperto." }).catch(() => {});
        return interaction.editReply({ content: `Ticket aperto: ${res.channel}` }).catch(() => {});
      }

      if (interaction.isButton() && interaction.customId === "ticket_close_now") {
        if (!isTicketChannel(interaction.channel)) {
          await interaction.reply({ content: "Solo nei canali ticket.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        if (!canCloseTicketFromInteraction(interaction)) {
          await interaction.reply({ content: "Non hai permessi.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        await interaction.showModal(buildCloseReasonModal(interaction.channel.id));
      }
    } catch (err) {
      console.error(err);
    }
  });
}

// ================== READY ==================
client.once("ready", async () => {
  console.log(`Online: ${client.user.tag}`);
});

// ================== START ==================
(async () => {
  await acquireInstanceLockOrExit();
  bindEventsOnce();

  await loadTranscriptIndex();
  await cleanupOldTranscripts();
  await registerCommandsSafe().catch((e) => console.error("registerCommands:", e));

  await client.login(TOKEN);
})();

