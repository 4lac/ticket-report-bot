require('dotenv').config();
const fs = require('fs');
const path = require('path');
const momentHijri = require('moment-hijri');
const {
  Client, GatewayIntentBits, EmbedBuilder, Partials,
} = require('discord.js');

// أسماء الشهور الهجرية اللي تطلع بلوق Wick
const HIJRI_MONTHS = {
  'محرم': 1,
  'صفر': 2,
  'ربيع الأول': 3,
  'ربيع الآخر': 4,
  'ربيع الثاني': 4,
  'جمادى الأولى': 5,
  'جمادى الآخرة': 6,
  'جمادى الثانية': 6,
  'رجب': 7,
  'شعبان': 8,
  'رمضان': 9,
  'شوال': 10,
  'ذو القعدة': 11,
  'ذو الحجة': 12,
};

// يحاول يفهم تاريخ هجري بصيغة: "الأربعاء، 15 صفر 1448 11:15 م"
function parseHijriDate(str) {
  const monthNames = Object.keys(HIJRI_MONTHS).sort((a, b) => b.length - a.length);
  const monthPattern = monthNames.join('|');
  const re = new RegExp(
    `(\\d{1,2})\\s+(${monthPattern})\\s+(\\d{3,4}).*?(\\d{1,2}):(\\d{2})\\s*(ص|م)`
  );
  const m = str.match(re);
  if (!m) return null;

  let [, day, monthName, year, hour, minute, ampm] = m;
  day = parseInt(day, 10);
  year = parseInt(year, 10);
  hour = parseInt(hour, 10);
  minute = parseInt(minute, 10);
  const monthNum = HIJRI_MONTHS[monthName];

  if (ampm === 'م' && hour < 12) hour += 12;
  if (ampm === 'ص' && hour === 12) hour = 0;

  const hijriStr = `${year}/${String(monthNum).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
  const g = momentHijri(hijriStr, 'iYYYY/iMM/iDD');
  if (!g.isValid()) return null;

  g.hour(hour).minute(minute).second(0);
  return g.toDate();
}

// يجرب ميلادي أول، ولو فشل يجرب هجري
function parseArabicDate(str) {
  const trimmed = str.trim();

  // صيغة توقيت ديسكورد: <t:1785444905:F>
  const discordTimestamp = trimmed.match(/<t:(\d+):[a-zA-Z]?>/);
  if (discordTimestamp) {
    return new Date(parseInt(discordTimestamp[1], 10) * 1000);
  }

  // JS Date() ما يفهم كلمة "at" بمنتصف التاريخ (صيغة Wick: "29 July 2026 at 7:15 AM")
  const withoutAt = trimmed.replace(/\bat\b/i, '');
  const gregorian = new Date(withoutAt);
  if (!isNaN(gregorian.getTime())) return gregorian;
  return parseHijriDate(trimmed);
}

const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID;
const PULL_LOG_CHANNEL_ID = process.env.PULL_LOG_CHANNEL_ID; // روم سجل السحب اليدوي (تقرير-سحب-يدوي)
const VOICE_LOG_CHANNEL_ID = process.env.VOICE_LOG_CHANNEL_ID; // روم لوق نقل الصوت التلقائي من Wicks
// IDs مستخدمين/بوتات نتجاهلهم كلياً بلوق الصوت (مثلاً بوت مشكلته يدخل/يطلع بشكل متكرر ويغرق الروم)
const IGNORED_USER_IDS = (process.env.IGNORED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
// رتب الدعم/الإدارة - قائمة مفصولة بفواصل، يُشترط وجود رتبة وحدة منها عشان يُحسب الشخص
const SUPPORT_ROLE_IDS = (process.env.SUPPORT_ROLE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const STATE_FILE = path.join(__dirname, 'last-report.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- تخزين بسيط لآخر تقرير (ملف JSON) ----------
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ---------- استخراج بيانات من إيمبد لوق Wick ----------
// يرجع { closedById, closedAt } أو null لو مو رسالة إغلاق تذكرة
function parseTicketLogEmbed(embed) {
  if (!embed || !embed.fields || embed.fields.length === 0) return null;

  const getField = (needle) =>
    embed.fields.find((f) => f.name && f.name.includes(needle));

  const closedByField = getField('تم الإغلاق بواسطة');
  const closedAtField = getField('وقت الإغلاق');
  if (!closedByField || !closedAtField) return null;

  const mentionMatch = closedByField.value.match(/<@!?(\d+)>/);
  if (!mentionMatch) return null; // "لا أحد" أو صيغة غير متوقعة

  const closedAt = parseArabicDate(closedAtField.value);
  if (!closedAt || isNaN(closedAt.getTime())) return null;

  return { closedById: mentionMatch[1], closedAt };
}

// ---------- يجمع بيانات آخر 7 أيام من روم السجل ----------
// لو محدد SUPPORT_ROLE_ID، ما يحسب إلا الأعضاء اللي عندهم هذي الرتبة
// (يمنع احتساب عضو عادي قفل تذكرته هو بنفسه)
async function collectWeeklyStats(channel, guild) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const counts = {}; // userId -> count
  const roleCheckCache = new Map(); // userId -> true/false، يتجنب طلبات مكررة
  let before;
  let keepGoing = true;

  async function isSupportMember(userId) {
    if (SUPPORT_ROLE_IDS.length === 0) return true; // ما فيه رتب محددة، احسب الكل
    if (roleCheckCache.has(userId)) return roleCheckCache.get(userId);
    let result = false;
    try {
      const member = await guild.members.fetch(userId);
      result = SUPPORT_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
      if (process.env.DEBUG_TICKETS === '1') {
        const memberRoleIds = member.roles.cache.map((r) => r.id).join(', ');
        console.log(`[DEBUG isSupportMember] userId=${userId} displayName=${member.displayName} result=${result}`);
        console.log(`[DEBUG isSupportMember] member roles: ${memberRoleIds}`);
      }
    } catch (err) {
      result = false; // العضو غير موجود بالسيرفر
      if (process.env.DEBUG_TICKETS === '1') {
        console.log(`[DEBUG isSupportMember] userId=${userId} fetch failed:`, err.message);
      }
    }
    roleCheckCache.set(userId, result);
    return result;
  }

  while (keepGoing) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.createdTimestamp < weekAgo) {
        keepGoing = false;
        continue;
      }
      for (const embed of msg.embeds) {
        if (process.env.DEBUG_TICKETS === '1') {
          const fieldNames = (embed.fields || []).map((f) => f.name).join(' | ');
          console.log(`[DEBUG] msg ${msg.id} @ ${msg.createdAt.toISOString()} fields: ${fieldNames}`);
          const closedByRaw = (embed.fields || []).find((f) => f.name && f.name.includes('تم الإغلاق بواسطة'));
          const closedAtRaw = (embed.fields || []).find((f) => f.name && f.name.includes('وقت الإغلاق'));
          console.log('[DEBUG] closedBy raw value:', JSON.stringify(closedByRaw && closedByRaw.value));
          console.log('[DEBUG] closedAt raw value:', JSON.stringify(closedAtRaw && closedAtRaw.value));
        }
        const parsed = parseTicketLogEmbed(embed);
        if (process.env.DEBUG_TICKETS === '1') {
          console.log(`[DEBUG] parsed:`, parsed);
        }
        if (parsed && parsed.closedAt.getTime() >= weekAgo) {
          if (await isSupportMember(parsed.closedById)) {
            counts[parsed.closedById] = (counts[parsed.closedById] || 0) + 1;
          }
        }
      }
    }
    before = batch.last().id;
    if (batch.size < 100) keepGoing = false;
  }

  return counts;
}

// ---------- يبني نص الجدول داخل كتلة كود ----------
const ARABIC_CHARS = /[\u0600-\u06FF]/;

function buildTable(adminsData) {
  // adminsData: { displayName: { count, handling, rating } }
  const rows = Object.entries(adminsData).sort((a, b) => b[1].count - a[1].count);
  if (rows.length === 0) {
    return 'ما فيه تذاكر مقفولة بآخر 7 أيام.';
  }

  const nameW = Math.max(12, ...rows.map(([n]) => n.length));
  const header =
    'Admin'.padEnd(nameW) + ' | Tickets | Handling           | Rating';
  const sep = '-'.repeat(header.length);

  const lines = rows.map(([name, d]) => {
    const handling = (d.handling || '-').slice(0, 18).padEnd(18);
    const rating = d.rating ? `${d.rating}/5` : '-';
    return `${name.padEnd(nameW)} | ${String(d.count).padEnd(7)} | ${handling} | ${rating}`;
  });

  const mainTable = '```\n' + [header, sep, ...lines].join('\n') + '\n```';

  // جدول إضافي نظيف (نص عادي، مو صندوق كود) يكرر بس الأسماء العربية بشكل مقروء
  const arabicRows = rows.filter(([name]) => ARABIC_CHARS.test(name));
  if (arabicRows.length === 0) return mainTable;

  const arabicList = arabicRows
    .map(([name, d]) => {
      const handling = d.handling || '-';
      const rating = d.rating ? `${d.rating}/5` : '-';
      return `**${name}** — Tickets: ${d.count} | التعامل: ${handling} | التقييم: ${rating}`;
    })
    .join('\n');

  return `${mainTable}\n**الأسماء العربية (نسخة واضحة):**\n${arabicList}`;
}

// ---------- تقرير-سحب-يدوي: يعتمد على عدد الرسائل اللي كتبها كل إداري بروم سجل السحب ----------
// نمط الرسالة المتوقع: "اسم الإداري : <@ADMIN>" بأي مكان بنص الرسالة
function extractPullAdminIds(content) {
  const ids = [];
  const re = /اسم الإداري\s*:\s*<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

async function collectPullStats(channel) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const counts = {}; // userId -> count
  let before;
  let keepGoing = true;

  while (keepGoing) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.createdTimestamp < weekAgo) {
        keepGoing = false;
        continue;
      }
      const ids = extractPullAdminIds(msg.content || '');
      for (const id of ids) {
        counts[id] = (counts[id] || 0) + 1;
      }
    }
    before = batch.last().id;
    if (batch.size < 100) keepGoing = false;
  }

  return counts;
}

// جدول بسيط: اسم + عدد بس
function buildPullTable(adminsData) {
  const rows = Object.entries(adminsData).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    return 'ما فيه عمليات سحب مسجلة بآخر 7 أيام.';
  }

  const nameW = Math.max(12, ...rows.map(([n]) => n.length));
  const header = 'Admin'.padEnd(nameW) + ' | Pulls';
  const sep = '-'.repeat(header.length);
  const lines = rows.map(([name, count]) => `${name.padEnd(nameW)} | ${count}`);

  const mainTable = '```\n' + [header, sep, ...lines].join('\n') + '\n```';

  const arabicRows = rows.filter(([name]) => ARABIC_CHARS.test(name));
  if (arabicRows.length === 0) return mainTable;

  const arabicList = arabicRows
    .map(([name, count]) => `**${name}** — Pulls: ${count}`)
    .join('\n');

  return `${mainTable}\n**الأسماء العربية (نسخة واضحة):**\n${arabicList}`;
}

// ---------- تقرير-حضور: يحسب وقت الإداري داخل رومات "Support" الصوتية ----------
function extractRoomName(fieldValue) {
  const m = fieldValue && fieldValue.match(/الاسم:\s*`([^`]+)`/);
  return m ? m[1] : null;
}

function extractEventTime(embed) {
  for (const f of embed.fields || []) {
    const m = f.value && f.value.match(/<t:(\d+):[a-zA-Z]?>/);
    if (m) return new Date(parseInt(m[1], 10) * 1000);
  }
  return null;
}

// أسماء الرومات ممكن تجي بخط يونيكود مزخرف (رياضي) زي "𝐖𝐚𝐢𝐭𝐢𝐧𝐠" بدل "Waiting" العادي
// normalize('NFKD') يرجعها لحروفها الأصلية العادية عشان تنقارن صح
function normalizeText(str) {
  return str ? str.normalize('NFKD') : str;
}

function isSupportRoom(roomName) {
  return !!roomName && normalizeText(roomName).includes('Support');
}

function isWaitingRoom(roomName) {
  return !!roomName && normalizeText(roomName).includes('Waiting');
}

// يرجع { type, userId, oldRoom, newRoom, time, adminId } أو null لو الرسالة مو من النوع المتوقع
// type: join | leave | admin_move (نقله إداري) | self_switch (تنقل بنفسه)
function parseVoiceEvent(embed) {
  const desc = embed.description || '';
  const userField = (embed.fields || []).find((f) => f.name === 'معلومات العضو');
  if (!userField) return null;
  const userMatch = userField.value.match(/<@!?(\d+)>/);
  if (!userMatch) return null;
  const userId = userMatch[1];
  const time = extractEventTime(embed);
  if (!time) return null;

  if (desc.includes('انضم إلى الروم الصوتي')) {
    const roomField = (embed.fields || []).find((f) => f.name.includes('المنضم إليها'));
    return { type: 'join', userId, oldRoom: null, newRoom: extractRoomName(roomField && roomField.value), time, adminId: null };
  }
  if (desc.includes('غادر روم صوتي')) {
    const roomField = (embed.fields || []).find((f) => f.name.includes('المغادر'));
    return { type: 'leave', userId, oldRoom: extractRoomName(roomField && roomField.value), newRoom: null, time, adminId: null };
  }
  if (desc.includes('تم نقله إلى روم صوتي آخر') || desc.includes('قام بالتبديل بين الرومات الصوتية')) {
    const oldField = (embed.fields || []).find((f) => f.name.includes('القديم'));
    const newField = (embed.fields || []).find((f) => f.name.includes('الجديد'));
    const adminField = (embed.fields || []).find((f) => f.name.includes('تم النقل بواسطة'));
    let adminId = null;
    if (adminField) {
      const adminMatch = adminField.value.match(/<@!?(\d+)>/);
      if (adminMatch) adminId = adminMatch[1];
    }
    return {
      type: adminField ? 'admin_move' : 'self_switch',
      userId,
      oldRoom: extractRoomName(oldField && oldField.value),
      newRoom: extractRoomName(newField && newField.value),
      time,
      adminId,
    };
  }
  return null;
}

async function collectVoiceStats(channel) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const events = [];
  let before;
  let keepGoing = true;

  while (keepGoing) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (msg.createdTimestamp < weekAgo) {
        keepGoing = false;
        continue;
      }
      for (const embed of msg.embeds) {
        const ev = parseVoiceEvent(embed);
        if (ev && IGNORED_USER_IDS.includes(ev.userId)) continue; // نتجاهله كلياً (زي بوت يدخل/يطلع بشكل متكرر)
        if (ev) events.push(ev);
        if (ev && process.env.DEBUG_TICKETS === '1') {
          const filterId = process.env.DEBUG_VOICE_USER_ID;
          if (!filterId || ev.userId === filterId) {
            console.log(
              `[DEBUG VOICE EVENT] ${ev.type} | user=${ev.userId} | old=${JSON.stringify(ev.oldRoom)} | new=${JSON.stringify(ev.newRoom)} | admin=${ev.adminId} | time=${ev.time.toISOString()}`
            );
          }
        }
      }
    }
    before = batch.last().id;
    if (batch.size < 100) keepGoing = false;
  }

  events.sort((a, b) => a.time.getTime() - b.time.getTime());

  const sessionStart = {}; // userId -> timestamp (ms) لبداية جلسة الدعم الحالية
  const totalMs = {}; // userId -> مجموع الميلي ثانية
  const pulls = {}; // adminId -> عدد مرات سحب عضو من Waiting إلى Support

  const closeSession = (userId, atTime) => {
    if (sessionStart[userId] != null) {
      totalMs[userId] = (totalMs[userId] || 0) + (atTime - sessionStart[userId]);
      delete sessionStart[userId];
    }
  };

  for (const ev of events) {
    const t = ev.time.getTime();
    if (ev.type === 'join') {
      if (isSupportRoom(ev.newRoom) && sessionStart[ev.userId] == null) {
        sessionStart[ev.userId] = t;
      }
    } else if (ev.type === 'leave') {
      closeSession(ev.userId, t);
    } else if (ev.type === 'admin_move' || ev.type === 'self_switch') {
      const wasSupport = isSupportRoom(ev.oldRoom);
      const isNowSupport = isSupportRoom(ev.newRoom);
      if (wasSupport && !isNowSupport) {
        closeSession(ev.userId, t);
      } else if (!wasSupport && isNowSupport && sessionStart[ev.userId] == null) {
        sessionStart[ev.userId] = t;
      }
      // لو الاثنين Support (تنقل بين رومات دعم)، الجلسة تستمر بدون تغيير

      // سحب حقيقي: إداري نقل عضو من Waiting إلى Support
      if (ev.type === 'admin_move' && ev.adminId && isWaitingRoom(ev.oldRoom) && isSupportRoom(ev.newRoom)) {
        pulls[ev.adminId] = (pulls[ev.adminId] || 0) + 1;
      }
    }
  }

  // أي جلسة لسا مفتوحة (الشخص موجود بروم دعم لين الآن) نقفلها عند لحظة التقرير
  for (const userId of Object.keys(sessionStart)) {
    closeSession(userId, now);
  }

  return { totalMs, pulls };
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// جدول واحد بصندوق كود: الاسم + الوقت + عدد السحب
// adminsData: { displayName: { durationMs, pulls } }
function buildCombinedTable(adminsData) {
  const rows = Object.entries(adminsData).sort(
    (a, b) => b[1].durationMs - a[1].durationMs
  );
  if (rows.length === 0) {
    return 'ما فيه نشاط مسجل بآخر 7 أيام.';
  }

  const nameW = Math.max(12, ...rows.map(([n]) => n.length));
  const header = 'Admin'.padEnd(nameW) + ' | Duration   | Pulls';
  const sep = '-'.repeat(header.length);
  const lines = rows.map(([name, d]) => {
    const duration = formatDuration(d.durationMs).padEnd(10);
    return `${name.padEnd(nameW)} | ${duration} | ${d.pulls || 0}`;
  });

  return '```\n' + [header, sep, ...lines].join('\n') + '\n```';
}

client.once('ready', () => {
  console.log(`Logged in as: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ---------- /تقرير-اسبوعي ----------
  if (interaction.commandName === 'تقرير-اسبوعي') {
    await interaction.deferReply();

    const logChannel = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
    const counts = await collectWeeklyStats(logChannel, interaction.guild);

    // نجيب أسماء العرض (display name) بدل الـ ID
    // نحافظ على التقييمات القديمة لو الاسم نفسه تكرر (ما نصفرها إلا لو الاسم اختفى من التقرير)
    const guild = interaction.guild;
    const previousState = loadState();
    const adminsData = {};
    for (const [userId, count] of Object.entries(counts)) {
      let displayName = userId;
      try {
        const member = await guild.members.fetch(userId);
        displayName = member.displayName;
      } catch {
        // العضو غير موجود بالسيرفر حالياً، نستخدم الـ ID
      }
      const previous = previousState && previousState.admins && previousState.admins[displayName];
      adminsData[displayName] = {
        count: previous && previous.count !== count ? previous.count : count,
        handling: previous ? previous.handling : null,
        rating: previous ? previous.rating : null,
      };
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 تقرير نشاط الدعم الأسبوعي')
      .setDescription(buildTable(adminsData))
      .setColor(0x5865f2)
      .setFooter({ text: 'آخر 7 أيام • عبّي التعامل والتقييم عبر أمر /تقييم' })
      .setTimestamp();

    const sent = await interaction.editReply({ embeds: [embed] });

    saveState({
      messageId: sent.id,
      channelId: sent.channelId,
      admins: adminsData,
    });
    return;
  }

  // ---------- /تقرير-سحب-يدوي ----------
  if (interaction.commandName === 'تقرير-سحب-يدوي') {
    await interaction.deferReply();

    const pullChannel = await client.channels.fetch(PULL_LOG_CHANNEL_ID);
    const counts = await collectPullStats(pullChannel);

    // نجيب أسماء العرض (display name) بدل الـ ID
    const guild = interaction.guild;
    const adminsData = {};
    for (const [userId, count] of Object.entries(counts)) {
      let displayName = userId;
      try {
        const member = await guild.members.fetch(userId);
        displayName = member.displayName;
      } catch {
        // العضو غير موجود بالسيرفر حالياً، نستخدم الـ ID
      }
      adminsData[displayName] = count;
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 تقرير السحب اليدوي الأسبوعي')
      .setDescription(buildPullTable(adminsData))
      .setColor(0x57f287)
      .setFooter({ text: 'آخر 7 أيام • عدد الرسائل بروم سجل السحب اليدوي (يعتمد على كتابة الإداري نفسه)' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ---------- /تقرير-حضور (مدمج: سحب + وقت الحضور، بالاعتماد على لوق الصوت التلقائي) ----------
  if (interaction.commandName === 'تقرير-حضور') {
    await interaction.deferReply();

    const voiceChannel = await client.channels.fetch(VOICE_LOG_CHANNEL_ID);
    const { totalMs, pulls } = await collectVoiceStats(voiceChannel);

    // نجمع كل الـ IDs اللي ظهرت (سواء بالوقت أو بالسحب)
    const allUserIds = new Set([...Object.keys(totalMs), ...Object.keys(pulls)]);

    // نجيب أسماء العرض (display name) بدل الـ ID، ونحسب بس رتب الدعم
    const guild = interaction.guild;
    const adminsData = {};
    for (const userId of allUserIds) {
      if (SUPPORT_ROLE_IDS.length > 0) {
        let hasRole = false;
        try {
          const member = await guild.members.fetch(userId);
          hasRole = SUPPORT_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
        } catch {
          hasRole = false;
        }
        if (!hasRole) continue;
      }
      let displayName = userId;
      try {
        const member = await guild.members.fetch(userId);
        displayName = member.displayName;
      } catch {
        // العضو غير موجود بالسيرفر حالياً، نستخدم الـ ID
      }
      adminsData[displayName] = {
        durationMs: totalMs[userId] || 0,
        pulls: pulls[userId] || 0,
      };
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 تقرير الحضور والسحب الأسبوعي')
      .setDescription(buildCombinedTable(adminsData))
      .setColor(0xfee75c)
      .setFooter({ text: 'آخر 7 أيام • وقت الحضور بروم الدعم + عدد مرات السحب من Waiting' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ---------- /تقييم ----------
  if (interaction.commandName === 'تقييم') {
    const state = loadState();
    if (!state) {
      await interaction.reply({
        content: 'ما فيه تقرير حالي. سوّي /تقرير-اسبوعي أول.',
        ephemeral: true,
      });
      return;
    }

    const name = interaction.options.getString('اسم');
    const handling = interaction.options.getString('تعامل');
    const rating = interaction.options.getInteger('تقييم');
    const countOverride = interaction.options.getInteger('عدد'); // اختياري

    if (!state.admins[name]) {
      const availableNames = Object.keys(state.admins).join('، ') || 'لا يوجد';
      await interaction.reply({
        content: `ما لقيت "${name}" بالتقرير الحالي. الأسماء الموجودة: ${availableNames}`,
        ephemeral: true,
      });
      return;
    }

    state.admins[name].handling = handling;
    state.admins[name].rating = rating;
    if (countOverride !== null) {
      state.admins[name].count = countOverride;
    }
    saveState(state);

    if (process.env.DEBUG_TICKETS === '1') {
      console.log('[DEBUG /تقييم] state.channelId:', state.channelId);
      console.log('[DEBUG /تقييم] state.messageId:', state.messageId);
    }

    try {
      const channel = await client.channels.fetch(state.channelId);
      const message = await channel.messages.fetch(state.messageId);
      const oldEmbed = message.embeds[0];

      const newEmbed = EmbedBuilder.from(oldEmbed).setDescription(
        buildTable(state.admins)
      );
      await message.edit({ embeds: [newEmbed] });

      if (process.env.DEBUG_TICKETS === '1') {
        console.log('[DEBUG /تقييم] تم تعديل الرسالة بنجاح، ID:', message.id);
      }

      await interaction.reply({
        content: `تم تحديث تقييم "${name}".`,
        ephemeral: true,
      });
    } catch (err) {
      console.error(err);
      await interaction.reply({
        content: 'صار خطأ وقت تحديث الرسالة. تأكد إن رسالة التقرير ما انحذفت.',
        ephemeral: true,
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
