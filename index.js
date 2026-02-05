"use strict";

require("dotenv").config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

// ====== CONFIG ======
const TOKEN = process.env.DISCORD_TOKEN;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// Canale LOG ticket
const TICKET_LOG_CHANNEL_ID = "1467257072243703828";

// Categoria ticket (opzionale)
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;

// Banner: URL http/https (solo pannello ticket)
const BANNER_URL = process.env.BANNER_URL || process.env.IMAGE_URL || "";

// Emoji del titolo
const TICKET_TITLE_EMOJI = process.env.TICKET_TITLE_EMOJI || "🎫";

// Ruolo che può aprire ticket sempre
const ALWAYS_OPEN_ROLE_ID = "1463112389296918599";

// Ruolo abilitato alla chiusura ticket (oltre agli admin)
const TICKET_CLOSE_ROLE_ID = "1461816600733815090";

// Footer log: utente da mostrare
const LOG_FOOTER_USER_ID = "1387684968536477756";

// Embed thumbnail (immagine a lato)
const WELCOME_THUMB_URL = "https://i.imgur.com/wUuHZUk.png";

// ====== AUTO REFRESH PANNELLO ======
const PANEL_STATE_FILE = path.join(process.cwd(), "ticket_panel_state.json");
const PANEL_REFRESH_MS = 60 * 60 * 1000; // 1 ora

// Transcript lib (file scaricabile)
let discordTranscripts = null;
try {
  discordTranscripts = require("discord-html-transcripts"); // npm i discord-html-transcripts
} catch {
  discordTranscripts = null;
  console.log("⚠️ Installa discord-html-transcripts: npm i discord-html-transcripts");
}

if (!TOKEN) throw new Error("DISCORD_TOKEN mancante nel .env");
if (!STAFF_ROLE_ID) throw new Error("STAFF_ROLE_ID mancante nel .env");
if (!CLIENT_ID) throw new Error("CLIENT_ID mancante nel .env");
if (!GUILD_ID) throw new Error("GUILD_ID mancante nel .env");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ====== LOCKS ANTI DOPPI ======
const openingLock = new Map(); // userId -> timestamp
const closingLock = new Set(); // channelId

// Pannello auto-refresh state in memoria
let panelState = null; // { guildId, channelId, messageId, lastSentAt }
let panelTimer = null;

function lockUserOpen(userId, ttlMs = 15_000) {
  const now = Date.now();
  const last = openingLock.get(userId);
  if (last && now - last < ttlMs) return false;
  openingLock.set(userId, now);
  setTimeout(() => {
    const v = openingLock.get(userId);
    if (v === now) openingLock.delete(userId);
  }, ttlMs).unref?.();
  return true;
}

// ====== SLASH COMMANDS ======
const commands = [
  new SlashCommandBuilder().setName("ticketpanel").setDescription("Invia il pannello ticket"),
  new SlashCommandBuilder()
    .setName("ticketadd")
    .setDescription("Aggiunge un utente a questo ticket")
    .addUserOption((opt) => opt.setName("utente").setDescription("Utente da aggiungere").setRequired(true)),
  new SlashCommandBuilder()
    .setName("ticketremove")
    .setDescription("Rimuove un utente da questo ticket")
    .addUserOption((opt) => opt.setName("utente").setDescription("Utente da rimuovere").setRequired(true)),
].map((c) => c.toJSON());

async function registerCommandsSafe() {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("Slash commands registrati OK.");
  } catch (err) {
    console.error("ERRORE registrazione slash commands:");
    console.error(err?.rawError || err);
  }
}

// ====== VALIDAZIONE URL BANNER (solo pannello ticket) ======
function isValidHttpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ====== UI (Components v2) ======
function buildTicketPanelComponents() {
  const hasBanner = isValidHttpUrl(BANNER_URL);

  const inner = [
    { type: 10, content: `# <:icona_ticket:1467182266554908953> Famiglia Gotti – Ticket Fazione` },
    { type: 14, divider: false, spacing: 1 },
    { type: 10, content: "**Seleziona una delle Seguenti Opzioni in Base alla Desiderata:**" },
    { type: 14, divider: false, spacing: 1 },
    { type: 10, content: "- **🕒・Orario di Controllo Ticket**: <t:1762506000:t> - <t:1762470000:t>\n" },
    { type: 14, divider: true, spacing: 2 },
  ];

  if (hasBanner) inner.push({ type: 12, items: [{ media: { url: BANNER_URL } }] });
  else console.log("⚠️ BANNER_URL non valido o mancante, invio pannello senza immagine.");

  inner.push(
    { type: 14, divider: true, spacing: 2 },
    {
      type: 1,
      components: [
        { type: 2, style: 1, custom_id: "ticket_btn_braccio", label: "🔫・Ticket Braccio Armato" },
        { type: 2, style: 4, custom_id: "ticket_btn_info", label: "📄・Ticket Informativa" },
        { type: 2, style: 3, custom_id: "ticket_btn_wl", label: "🛠️・Ticket Fazionati", disabled: true },
      ],
    }
  );

  return [{ type: 17, components: inner }];
}

// ====== PERMESSI ======
function hasRole(interactionOrMember, roleId) {
  const member = interactionOrMember?.member ?? interactionOrMember;
  return member?.roles?.cache?.has(roleId);
}

function canCloseTicket(interaction) {
  const member = interaction?.member;
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  return hasRole(interaction, TICKET_CLOSE_ROLE_ID);
}

// ====== ORARI ======
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
  "**Per Aprire Ticket anche al di fuori degli Orari di Supporto Acquista ora l'@&1463112389296918599 a 4,99€ per ottenere assistenza rapida senza tempi di Attesa per qualsiasi tipo di problema o richiesta!**";

// ====== TICKET HELPERS ======
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

function sanitizeForChannelUsername(username) {
  const s = String(username || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return s || "utente";
}

function channelNameForTicket(ticketType, username) {
  const u = sanitizeForChannelUsername(username);
  if (ticketType === "Braccio Armato") return `🔫・ticket-${u}`;
  if (ticketType === "Informativa") return `📄・ticket-${u}`;
  if (ticketType === "Prossimamente...") return `❓・ticket-${u}`;
  return `ticket-${u}`;
}

function topicForTicket(ticketType, userId) {
  return `**Categoria:** ${ticketType} | **Utente:** <@${userId}>`;
}

function findExistingTicket(guild, userId) {
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

// ====== WELCOME MESSAGE + CLOSE BUTTON ======
function buildWelcomeEmbed() {
  return new EmbedBuilder()
    .setTitle("Benvenuto nel Sistema Ticket della Famiglia Gotti <:icona_ticket:1467182266554908953>")
    .setDescription("Esponi il Tuo Problema Verrai Assisstito a Breve in Base alla Categoria del Ticket Selezionata.")
    .setThumbnail(WELCOME_THUMB_URL)
    .setColor(0xed4245);
}

function buildCloseButtonRow(disabled = false) {
  const btn = new ButtonBuilder()
    .setCustomId("ticket_close_now")
    .setStyle(ButtonStyle.Danger)
    .setLabel("🔐・Chiudi Ticket")
    .setDisabled(disabled);

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
  const welcomeMsg = await channel.send({
    content: `Benvenuto <@${userId}> nel Sistema Ticket della **${guildName}**`,
    embeds: [buildWelcomeEmbed()],
    components: [buildCloseButtonRow(false)],
    allowedMentions: { users: [userId], roles: [], repliedUser: false },
  });

  pinAndCleanupPinSystemMessage(welcomeMsg).catch(() => {});
  return welcomeMsg;
}

// ====== TRANSCRIPT (FILE SCARICABILE) ======
async function buildTranscriptAttachment(channel) {
  if (!discordTranscripts) return null;

  const safeName = String(channel?.name || "transcript")
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 60);

  const attachment = await discordTranscripts.createTranscript(channel, {
    limit: -1,
    returnType: "attachment",
    filename: `${safeName}.html`,
    saveImages: false,
    poweredBy: false,
  });

  return attachment;
}

// ====== LOG (stile ticket, NO immagine, bottone sotto) ======
async function getLogChannel(guild) {
  const ch = await guild.channels.fetch(TICKET_LOG_CHANNEL_ID).catch(() => null);
  if (!ch) return null;
  if (typeof ch.isTextBased === "function" && !ch.isTextBased()) return null;
  return ch;
}

function formatRomeHHMM(date = new Date()) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function buildTicketLogV2Components({
  ticketName,
  openerId,
  closedById,
  category,
  reason,
  closedAt,
}) {
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

  return [{ type: 17, components: inner }];
}

function buildTranscriptButtonV2Components(attUrl) {
  return [
    {
      type: 17,
      components: [
        { type: 14, divider: false, spacing: 1 },
        {
          type: 1,
          components: [{ type: 2, style: 5, label: "⬇️・Scarica Transcript", url: attUrl }],
        },
      ],
    },
  ];
}

async function sendTicketLogV2WithAttachment({
  guild,
  ticketName,
  openerId,
  closedById,
  category,
  reason,
  transcriptAttachment,
  closedAt,
}) {
  const logChannel = await getLogChannel(guild);
  if (!logChannel) {
    console.log("⚠️ Log channel non trovato o non testuale: controlla TICKET_LOG_CHANNEL_ID e permessi.");
    return;
  }

  // 1) invio LOG (stile ticket) + allegato transcript
  const logComponents = buildTicketLogV2Components({
    ticketName,
    openerId,
    closedById,
    category,
    reason,
    closedAt,
  });

  const sentLog = await logChannel.send({
    flags: 32768,
    components: logComponents,
    files: transcriptAttachment ? [transcriptAttachment] : [],
    allowedMentions: { parse: [] },
  });

  // 2) invio SEPARATO del pulsante SOTTO (nessun edit => nessun "Modificato")
  const attUrl = sentLog.attachments.first()?.url || null;
  if (!attUrl) return;

  await logChannel.send({
    flags: 32768,
    components: buildTranscriptButtonV2Components(attUrl),
    allowedMentions: { parse: [] },
  });
}

// ====== MODAL chiusura ticket (motivazione) ======
function buildCloseReasonModal(channelId) {
  const modal = new ModalBuilder().setCustomId(`ticket_close_reason:${channelId}`).setTitle("Sez. Ticket - Chiudi Ticket");

  const reasonInput = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("❓・Motivazione:")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(400)
    .setPlaceholder("Scrivi una Motivazione (es: Risolto, Non Risolto, ecc.).");

  const row = new ActionRowBuilder().addComponents(reasonInput);
  modal.addComponents(row);
  return modal;
}

// ====== TICKET CREATE ======
async function createTicketChannel(interaction, ticketType) {
  const guild = interaction.guild;
  const user = interaction.user;

  const existing = findExistingTicket(guild, user.id);
  if (existing) return { already: true, channel: existing };

  const parentId = resolveTicketParentId(guild);
  const desiredName = channelNameForTicket(ticketType, user.username);
  const topic = topicForTicket(ticketType, user.id);

  let channel;
  try {
    channel = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildText,
      parent: parentId ?? undefined,
      topic,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
        {
          id: STAFF_ROLE_ID,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
      ],
    });
  } catch {
    channel = await guild.channels.create({
      name: `ticket-${user.id}`,
      type: ChannelType.GuildText,
      parent: parentId ?? undefined,
      topic,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
        {
          id: STAFF_ROLE_ID,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        },
      ],
    });
  }

  sendTicketWelcome(channel, guild.name, user.id).catch(() => {});
  return { already: false, channel };
}

// ====== AUTO REFRESH PANNELLO ======
async function loadPanelState() {
  try {
    const raw = await fsp.readFile(PANEL_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.guildId || !parsed.channelId || !parsed.messageId || !parsed.lastSentAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function savePanelState(state) {
  try {
    await fsp.writeFile(PANEL_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("Errore salvataggio panel state:", e);
  }
}

async function deleteMessageSafe(channel, messageId) {
  try {
    const msg = await channel.messages.fetch(messageId);
    if (msg) await msg.delete().catch(() => {});
  } catch {}
}

async function sendPanelInChannel(channel) {
  return channel.send({
    flags: 32768,
    components: buildTicketPanelComponents(),
  });
}

function clearPanelTimer() {
  if (panelTimer) clearTimeout(panelTimer);
  panelTimer = null;
}

function scheduleNextPanelRefresh() {
  clearPanelTimer();
  if (!panelState?.lastSentAt) return;

  const dueIn = Math.max(5_000, PANEL_REFRESH_MS - (Date.now() - Number(panelState.lastSentAt)));
  panelTimer = setTimeout(async () => {
    try {
      await refreshPanelNow();
    } catch (e) {
      console.error("Errore refresh pannello:", e);
    } finally {
      scheduleNextPanelRefresh();
    }
  }, dueIn);
}

async function refreshPanelNow() {
  if (!panelState?.guildId || !panelState?.channelId) return;

  const guild = await client.guilds.fetch(panelState.guildId).catch(() => null);
  if (!guild) return;

  const channel = await guild.channels.fetch(panelState.channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;

  // cancella vecchio pannello
  if (panelState.messageId) {
    await deleteMessageSafe(channel, panelState.messageId);
  }

  // invia nuovo pannello
  const newMsg = await sendPanelInChannel(channel);

  panelState = {
    guildId: guild.id,
    channelId: channel.id,
    messageId: newMsg.id,
    lastSentAt: Date.now(),
  };
  await savePanelState(panelState);
}

// ====== READY ======
client.once("ready", async () => {
  console.log(`Online: ${client.user.tag}`);
  await registerCommandsSafe();

  panelState = await loadPanelState();
  if (panelState) scheduleNextPanelRefresh();
});

// Fallback per postare pannello se gli slash non si registrano
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
    if (msg.content !== "!ticketpanel") return;

    const member = await msg.guild.members.fetch(msg.author.id);
    if (!hasRole(member, STAFF_ROLE_ID)) {
      await msg.reply("Non hai il ruolo staff.");
      return;
    }

    // se esiste stato, prova a cancellare il precedente
    if (panelState?.guildId === msg.guild.id && panelState?.channelId === msg.channel.id && panelState?.messageId) {
      await deleteMessageSafe(msg.channel, panelState.messageId);
    }

    const sent = await msg.channel.send({
      flags: 32768,
      components: buildTicketPanelComponents(),
    });

    panelState = {
      guildId: msg.guild.id,
      channelId: msg.channel.id,
      messageId: sent.id,
      lastSentAt: Date.now(),
    };
    await savePanelState(panelState);
    scheduleNextPanelRefresh();
  } catch (e) {
    console.error(e);
  }
});

// ====== INTERACTIONS ======
client.on("interactionCreate", async (interaction) => {
  try {
    // MODAL SUBMIT: chiusura con motivazione
    if (
      interaction.isModalSubmit() &&
      typeof interaction.customId === "string" &&
      interaction.customId.startsWith("ticket_close_reason:")
    ) {
      const channelId = interaction.customId.split(":")[1] || "";
      if (!interaction.guild || !interaction.channel) return;

      if (interaction.channel.id !== channelId) {
        await interaction.reply({ content: "Questo ticket non corrisponde alla richiesta di chiusura.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      if (!isTicketChannel(interaction.channel)) {
        await interaction.reply({ content: "Questa azione è valida solo nei canali ticket.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      if (!canCloseTicket(interaction)) {
        await interaction.reply({
          content: `Non hai i permessi per chiudere i ticket.\nServe il ruolo <@&${TICKET_CLOSE_ROLE_ID}> oppure permesso Amministratore.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      if (closingLock.has(interaction.channel.id)) {
        await interaction.reply({ content: "⏳ Chiusura già in corso...", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      closingLock.add(interaction.channel.id);

      // ACK tecnico, poi lo elimino: niente messaggi permanenti “solo a te”
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      setTimeout(() => interaction.deleteReply().catch(() => {}), 800).unref?.();

      const reason = String(interaction.fields.getTextInputValue("reason") || "").trim();
      const closedAt = new Date();

      const guild = interaction.guild;
      const ticketChannel = interaction.channel;

      const staffUsername = interaction.user?.username || "staff";

      // Messaggio di chiusura (UNO SOLO) nel ticket
      await ticketChannel
        .send({
          content: `${staffUsername}: Chiusura Ticket in Corso... | **Motivazione**: ${reason}`,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});

      const ticketNameSnapshot = ticketChannel.name;
      const openerId = extractUserIdFromTopic(ticketChannel.topic);
      const category = extractCategoryFromTopic(ticketChannel.topic);

      // transcript file
      let transcriptAttachment = null;
      try {
        transcriptAttachment = await buildTranscriptAttachment(ticketChannel);
      } catch (e) {
        console.error("Errore creazione transcript file:", e?.rawError || e);
        transcriptAttachment = null;
      }

      // log v2 stile ticket + allegato + (messaggio sotto) con bottone download
      try {
        await sendTicketLogV2WithAttachment({
          guild,
          ticketName: ticketNameSnapshot,
          openerId,
          closedById: interaction.user.id,
          category,
          reason,
          transcriptAttachment,
          closedAt,
        });
      } catch (e) {
        console.error("Errore invio log:", e?.rawError || e);
      }

      setTimeout(async () => {
        try {
          await ticketChannel.delete("Chiusura Ticket (transcript allegato)");
        } catch (e) {
          console.error("Errore chiusura ticket:", e?.rawError || e);
        } finally {
          closingLock.delete(ticketChannel.id);
        }
      }, 1200);

      return;
    }

    // Slash commands
    if (interaction.isChatInputCommand()) {
      await interaction.reply({ content: "⏳ Operazione in corso...", flags: MessageFlags.Ephemeral }).catch(() => {});

      if (interaction.commandName === "ticketpanel") {
        // Cancella vecchio pannello se esiste nello stesso canale
        if (panelState?.guildId === interaction.guildId && panelState?.channelId === interaction.channelId && panelState?.messageId) {
          await deleteMessageSafe(interaction.channel, panelState.messageId);
        }

        const sent = await interaction.channel.send({ flags: 32768, components: buildTicketPanelComponents() });
        await interaction.editReply({ content: "Pannello ticket inviato." }).catch(() => {});

        panelState = {
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          messageId: sent.id,
          lastSentAt: Date.now(),
        };
        await savePanelState(panelState);
        scheduleNextPanelRefresh();

        return;
      }

      if (interaction.commandName === "ticketadd") {
        if (!hasRole(interaction, STAFF_ROLE_ID)) {
          await interaction.editReply({ content: "Non hai il ruolo staff." }).catch(() => {});
          return;
        }
        if (!isTicketChannel(interaction.channel)) {
          await interaction.editReply({ content: "Usa questo comando dentro un canale ticket." }).catch(() => {});
          return;
        }

        const target = interaction.options.getUser("utente", true);

        await interaction.channel.permissionOverwrites.create(
          target.id,
          { ViewChannel: true, SendMessages: true, ReadMessageHistory: true },
          { reason: `Ticket add by ${interaction.user.tag}` }
        );

        await interaction.editReply({ content: `✅ Utente Aggiunto: <@${target.id}>` }).catch(() => {});
        await interaction.channel.send({
          content: `✅ Aggiunto al Ticket: <@${target.id}>`,
          allowedMentions: { users: [target.id] },
        });
        return;
      }

      if (interaction.commandName === "ticketremove") {
        if (!hasRole(interaction, STAFF_ROLE_ID)) {
          await interaction.editReply({ content: "Non hai il ruolo staff." }).catch(() => {});
          return;
        }
        if (!isTicketChannel(interaction.channel)) {
          await interaction.editReply({ content: "Usa questo comando dentro un canale ticket." }).catch(() => {});
          return;
        }

        const target = interaction.options.getUser("utente", true);

        await interaction.channel.permissionOverwrites.delete(target.id, `Ticket remove by ${interaction.user.tag}`);

        await interaction.editReply({ content: `❌ Utente Rimosso: <@${target.id}>` }).catch(() => {});
        await interaction.channel.send({
          content: `❌ Rimosso dal Ticket: <@${target.id}>`,
          allowedMentions: { users: [target.id] },
        });
        return;
      }

      await interaction.editReply({ content: "Comando non gestito." }).catch(() => {});
      return;
    }

    // Buttons: apertura ticket
    if (interaction.isButton() && ["ticket_btn_braccio", "ticket_btn_info", "ticket_btn_wl"].includes(interaction.customId)) {
      if (interaction.customId === "ticket_btn_wl") {
        await interaction.reply({ content: "❓・Prossimamente...", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      const canBypass = hasRole(interaction, ALWAYS_OPEN_ROLE_ID);
      if (!canBypass && !isWithinSupportHoursRome()) {
        await interaction.reply({ content: CLOSED_MESSAGE, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      if (!lockUserOpen(interaction.user.id)) {
        await interaction.reply({ content: "⏳ Ticket già in creazione, attendi...", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      await interaction.reply({ content: "⏳ Sto creando il ticket...", flags: MessageFlags.Ephemeral }).catch(() => {});

      const ticketType = interaction.customId === "ticket_btn_braccio" ? "Braccio Armato" : "Informativa";
      const res = await createTicketChannel(interaction, ticketType);

      if (res.already) {
        await interaction.editReply({ content: `Hai già un ticket aperto: ${res.channel}` }).catch(() => {});
        return;
      }

      await interaction.editReply({ content: `Ticket Aperto: ${res.channel}` }).catch(() => {});
      return;
    }

    // Button chiusura ticket -> apre modal motivazione
    if (interaction.isButton() && interaction.customId === "ticket_close_now") {
      if (!isTicketChannel(interaction.channel)) {
        await interaction.reply({ content: "Questo bottone funziona solo nei canali ticket.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      if (!canCloseTicket(interaction)) {
        await interaction.reply({
          content: `Non hai i permessi per chiudere i ticket.\nServe il ruolo <@&${TICKET_CLOSE_ROLE_ID}> oppure permesso Amministratore.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const modal = buildCloseReasonModal(interaction.channel.id);
      await interaction.showModal(modal);
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = "Errore interno. Controlla console/log.";
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg }).catch(() => {});
      else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(TOKEN);

process.on("unhandledRejection", (err) => console.error("UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));
