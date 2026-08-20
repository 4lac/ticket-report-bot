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

// ---------- إعدادات المراقبة اللحظية (اختيارية، تشتغل بس لو فعّلتها بـ .env) ----------
const WAITING_ROOM_CHANNEL_ID = process.env.WAITING_ROOM_CHANNEL_ID;
const AUTO_RETURN_ENABLED = process.env.AUTO_RETURN_ENABLED === '1';
const AUTO_RETURN_MINUTES = parseInt(process.env.AUTO_RETURN_MINUTES || '15', 10);

const GAME_MONITOR_ENABLED = process.env.GAME_MONITOR_ENABLED === '1';
const GAME_MONITOR_GRACE_MINUTES = parseInt(process.env.GAME_MONITOR_GRACE_MINUTES || '3', 10);
const ALLOWED_GAME_NAME = process.env.ALLOWED_GAME_NAME || 'Grand Theft Auto V';

// روم يستقبل تنبيهات "لعبة مخالفة" و"إرجاع للويتنق" (اختياري - لو فاضي ما يرسل تنبيهات)
const ALERTS_CHANNEL_ID = process.env.ALERTS_CHANNEL_ID;

// رومات البريك (لعقوبة "لعبة مخالفة" - ينقل بدل ما يفصل) - مفصولة بفواصل
const BREAK_ROOM_CHANNEL_IDS = (process.env.BREAK_ROOM_CHANNEL_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// حالة بالذاكرة (تصفر لو البوت أعيد تشغيله، مقبول لهالنوع من المراقبة اللحظية)
const aloneTimers = new Map(); // channelId -> Timeout
const gameViolationTimers = new Map(); // userId -> Timeout
const lastPulledBy = new Map(); // userId (المسحوب) -> { adminId, adminTag, time }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// يقرأ خيار "الفترة" (اسبوعي/شهري) من الأمر، ويرجع عدد الأيام والنص للعرض
function getPeriodDays(interaction, defaultLabel) {
  const choice = interaction.options.getString('الفترة') || defaultLabel;
  if (choice === 'شهري') return { days: 30, label: 'آخر 30 يوم' };
  return { days: 7, label: 'آخر 7 أيام' };
}

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
async function collectWeeklyStats(channel, guild, days = 30) {
  const now = Date.now();
  const weekAgo = now - days * 24 * 60 * 60 * 1000;

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

async function collectPullStats(channel, days = 7) {
  const now = Date.now();
  const weekAgo = now - days * 24 * 60 * 60 * 1000;

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

async function collectVoiceStats(channel, days = 7) {
  const now = Date.now();
  const weekAgo = now - days * 24 * 60 * 60 * 1000;

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

// جدول واحد يجمع الثلاث تقارير: تذاكر + وقت الحضور + سحب تلقائي + سحب يدوي
// adminsData: { displayName: { tickets, durationMs, autoPulls, manualPulls } }
function buildMergedTable(adminsData) {
  const rows = Object.entries(adminsData).sort(
    (a, b) => (b[1].tickets || 0) - (a[1].tickets || 0)
  );
  if (rows.length === 0) {
    return 'ما فيه نشاط مسجل بالفترة المحددة.';
  }

  const nameW = Math.max(12, ...rows.map(([n]) => n.length));
  const header =
    'Admin'.padEnd(nameW) + ' | Tickets | Duration   | AutoPulls | ManualPulls';
  const sep = '-'.repeat(header.length);
  const lines = rows.map(([name, d]) => {
    const tickets = String(d.tickets || 0).padEnd(7);
    const duration = formatDuration(d.durationMs || 0).padEnd(10);
    const autoPulls = String(d.autoPulls || 0).padEnd(9);
    const manualPulls = String(d.manualPulls || 0);
    return `${name.padEnd(nameW)} | ${tickets} | ${duration} | ${autoPulls} | ${manualPulls}`;
  });

  return '```\n' + [header, sep, ...lines].join('\n') + '\n```';
}

// ---------- ميزة 1: إرجاع تلقائي للويتنق لو المسحوب لحاله بدون إداري ----------
function memberHasSupportRole(member) {
  if (SUPPORT_ROLE_IDS.length === 0) return false;
  return SUPPORT_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

// يرسل تنبيه لروم التنبيهات كإيمبيد بحقول منفصلة (يتفادى اختلاط اتجاه النص عربي/إنجليزي)
async function sendAlert(title, color, fields) {
  if (!ALERTS_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(ALERTS_CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .addFields(fields)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[ALERT] فشل إرسال التنبيه:', err.message);
  }
}

// يعيد فحص روم دعم معين: يشغّل/يوقف عداد الـ15 دقيقة حسب الوضع الحالي
function reevaluateSupportRoom(channel) {
  if (!AUTO_RETURN_ENABLED || !WAITING_ROOM_CHANNEL_ID) return;
  if (!isSupportRoom(channel.name)) return;

  const members = [...channel.members.values()];
  const staffPresent = members.some((m) => memberHasSupportRole(m));
  const nonStaffMembers = members.filter((m) => !memberHasSupportRole(m) && !m.user.bot);

  const existingTimer = aloneTimers.get(channel.id);

  if (staffPresent || nonStaffMembers.length === 0) {
    // فيه إداري، أو الروم فاضي من غير الإداريين - نوقف أي عداد شغال
    if (existingTimer) {
      clearTimeout(existingTimer);
      aloneTimers.delete(channel.id);
    }
    return;
  }

  // فيه شخص/أشخاص بدون إداري - لو ما فيه عداد شغال، نبدأ وحد جديد
  if (!existingTimer) {
    const timer = setTimeout(async () => {
      aloneTimers.delete(channel.id);
      try {
        const freshChannel = await client.channels.fetch(channel.id);
        const freshMembers = [...freshChannel.members.values()];
        const stillStaffPresent = freshMembers.some((m) => memberHasSupportRole(m));
        if (stillStaffPresent) return; // تغير الوضع قبل التنفيذ، نلغي

        const waitingChannel = await client.channels.fetch(WAITING_ROOM_CHANNEL_ID);
        for (const m of freshMembers) {
          if (!memberHasSupportRole(m) && !m.user.bot) {
            let moveSucceeded = false;
            let moveResultText = 'تم إرجاعه للويتنق';
            try {
              await m.voice.setChannel(waitingChannel);
              moveSucceeded = true;
            } catch (err) {
              console.error('[AUTO_RETURN] فشل نقل العضو:', m.user.tag, err.message);
              moveResultText = `فشلت المحاولة (${err.message})`;
            }

            let pullerField = 'ما لقينا سجل يوضح مين سحبه';
            const pullInfo = lastPulledBy.get(m.id);
            if (pullInfo) {
              try {
                const adminUser = await client.users.fetch(pullInfo.adminId);
                pullerField = `<@${pullInfo.adminId}> (${adminUser.tag})`;
              } catch {
                pullerField = `<@${pullInfo.adminId}>`;
              }
            }

            const now = new Date();
            await sendAlert(
              moveSucceeded ? '⚠️ تم إرجاع عضو للويتنق' : '⚠️ محاولة إرجاع فشلت',
              0xed4245,
              [
                { name: 'العضو', value: `<@${m.id}>`, inline: true },
                { name: 'السبب', value: `بدون إداري ${AUTO_RETURN_MINUTES} دقيقة`, inline: true },
                { name: 'الروم', value: freshChannel.name, inline: true },
                { name: 'النتيجة', value: moveResultText, inline: false },
                { name: 'سحبه', value: pullerField, inline: false },
                { name: 'التوقيت', value: `${now.toLocaleDateString('ar-SA', { timeZone: 'Asia/Riyadh' })} - ${now.toLocaleTimeString('ar-SA', { timeZone: 'Asia/Riyadh' })}`, inline: false },
              ]
            );
          }
        }
        console.log(`[AUTO_RETURN] تم إرجاع أعضاء من ${freshChannel.name} إلى الويتنق (بعد ${AUTO_RETURN_MINUTES} دقيقة بدون إداري).`);
      } catch (err) {
        console.error('[AUTO_RETURN] خطأ:', err.message);
      }
    }, AUTO_RETURN_MINUTES * 60 * 1000);

    aloneTimers.set(channel.id, timer);
  }
}

// ---------- ميزة 2: فصل الإداري لو يلعب لعبة غير مسموحة وقت تواجده بروم الدعم ----------
function isPlayingAllowedGame(presence) {
  if (!presence || !presence.activities) return true; // ما فيه بيانات نشاط، نفترض ولا شي
  const playingActivity = presence.activities.find((a) => a.type === 0); // 0 = Playing
  if (!playingActivity) return true; // ما يلعب أي شي، مالنا دخل
  return playingActivity.name === ALLOWED_GAME_NAME;
}

function reevaluateGameMonitor(member) {
  if (!GAME_MONITOR_ENABLED) return;

  const hasSupportRole = memberHasSupportRole(member);
  const inSupportRoom = member.voice.channel && isSupportRoom(member.voice.channel.name);
  const playingActivity = member.presence && member.presence.activities
    ? member.presence.activities.find((a) => a.type === 0)
    : null;

  if (process.env.DEBUG_TICKETS === '1') {
    console.log(
      `[GAME_MONITOR DEBUG] user=${member.user.tag} hasSupportRole=${hasSupportRole} inSupportRoom=${inSupportRoom} ` +
      `voiceChannel=${member.voice.channel ? member.voice.channel.name : null} ` +
      `presence=${member.presence ? member.presence.status : 'NO_PRESENCE'} ` +
      `activity=${playingActivity ? JSON.stringify(playingActivity.name) : 'NONE'} allowed=${JSON.stringify(ALLOWED_GAME_NAME)}`
    );
  }

  if (!hasSupportRole) return;

  const existingTimer = gameViolationTimers.get(member.id);

  if (!inSupportRoom || isPlayingAllowedGame(member.presence)) {
    if (existingTimer) {
      clearTimeout(existingTimer);
      gameViolationTimers.delete(member.id);
      if (process.env.DEBUG_TICKETS === '1') {
        console.log(`[GAME_MONITOR DEBUG] عداد ${member.user.tag} انلغى (رجع مسموح أو طلع من الدعم)`);
      }
    }
    return;
  }

  // بروم دعم ويلعب لعبة غير مسموحة - لو ما فيه عداد، نبدأ وحد
  if (!existingTimer) {
    if (process.env.DEBUG_TICKETS === '1') {
      console.log(`[GAME_MONITOR DEBUG] بدأ عداد لـ ${member.user.tag} (${GAME_MONITOR_GRACE_MINUTES} دقيقة)`);
    }
    const timer = setTimeout(async () => {
      gameViolationTimers.delete(member.id);
      try {
        const freshMember = await member.guild.members.fetch(member.id);
        const stillInSupport = freshMember.voice.channel && isSupportRoom(freshMember.voice.channel.name);
        const stillPlaying = !isPlayingAllowedGame(freshMember.presence);

        if (process.env.DEBUG_TICKETS === '1') {
          console.log(
            `[GAME_MONITOR DEBUG] وقت التنفيذ: stillInSupport=${stillInSupport} stillPlaying=${stillPlaying} ` +
            `presence=${freshMember.presence ? JSON.stringify(freshMember.presence.activities) : 'NO_PRESENCE'}`
          );
        }

        if (!stillInSupport || !stillPlaying) return; // تغير الوضع، نلغي

        const roomName = freshMember.voice.channel ? freshMember.voice.channel.name : 'غير معروف';
        const playingActivity = freshMember.presence && freshMember.presence.activities
          ? freshMember.presence.activities.find((a) => a.type === 0)
          : null;
        const gameName = playingActivity ? playingActivity.name : 'غير معروف';

        // نختار روم البريك الأقل ازدحام من القائمة
        let targetBreakChannel = null;
        if (BREAK_ROOM_CHANNEL_IDS.length > 0) {
          const breakChannels = [];
          for (const id of BREAK_ROOM_CHANNEL_IDS) {
            try {
              const ch = await client.channels.fetch(id);
              breakChannels.push(ch);
            } catch {
              // روم مو موجود أو ما نقدر نوصله، نتجاهله
            }
          }
          if (breakChannels.length > 0) {
            targetBreakChannel = breakChannels.reduce((least, ch) =>
              ch.members.size < least.members.size ? ch : least
            );
          }
        }

        let actionSucceeded = false;
        let resultText = '';

        if (targetBreakChannel) {
          try {
            await freshMember.voice.setChannel(targetBreakChannel);
            actionSucceeded = true;
            resultText = `نُقل إلى ${targetBreakChannel.name}`;
            console.log(`[GAME_MONITOR] تم نقل ${freshMember.user.tag} لروم ${targetBreakChannel.name} (يلعب غير ${ALLOWED_GAME_NAME} وقت الدعم).`);
          } catch (err) {
            console.error('[GAME_MONITOR] فشل نقل العضو لروم البريك:', freshMember.user.tag, err.message);
            resultText = `فشلت المحاولة (${err.message})`;
          }
        } else {
          try {
            await freshMember.voice.disconnect();
            actionSucceeded = true;
            resultText = 'تم فصله (ما فيه رومات بريك معرّفة)';
            console.log(`[GAME_MONITOR] تم فصل ${freshMember.user.tag} (يلعب غير ${ALLOWED_GAME_NAME} وقت الدعم).`);
          } catch (err) {
            console.error('[GAME_MONITOR] فشل فصل العضو:', freshMember.user.tag, err.message);
            resultText = `فشلت المحاولة (${err.message})`;
          }
        }

        const now = new Date();
        await sendAlert(
          actionSucceeded ? '🎮 تم نقل إداري لروم البريك' : '🎮 محاولة إجراء فشلت',
          0xfee75c,
          [
            { name: 'الإداري', value: `<@${freshMember.id}>`, inline: true },
            { name: 'اللعبة', value: gameName, inline: true },
            { name: 'الروم الأصلي', value: roomName, inline: true },
            { name: 'النتيجة', value: resultText, inline: false },
            { name: 'التوقيت', value: `${now.toLocaleDateString('ar-SA', { timeZone: 'Asia/Riyadh' })} - ${now.toLocaleTimeString('ar-SA', { timeZone: 'Asia/Riyadh' })}`, inline: false },
          ]
        );
      } catch (err) {
        console.error('[GAME_MONITOR] خطأ:', err.message);
      }
    }, GAME_MONITOR_GRACE_MINUTES * 60 * 1000);

    gameViolationTimers.set(member.id, timer);
  }
}

// يراقب روم لوق الصوت لحظياً عشان يعرف "مين سحب مين" وقت حدوثه (يفيد تنبيه الإرجاع للويتنق)
client.on('messageCreate', (msg) => {
  if (!AUTO_RETURN_ENABLED) return;
  if (!VOICE_LOG_CHANNEL_ID || msg.channelId !== VOICE_LOG_CHANNEL_ID) return;

  for (const embed of msg.embeds) {
    const ev = parseVoiceEvent(embed);
    if (
      ev &&
      ev.type === 'admin_move' &&
      ev.adminId &&
      isWaitingRoom(ev.oldRoom) &&
      isSupportRoom(ev.newRoom)
    ) {
      lastPulledBy.set(ev.userId, {
        adminId: ev.adminId,
        time: ev.time,
      });
    }
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (AUTO_RETURN_ENABLED) {
    if (oldState.channel) reevaluateSupportRoom(oldState.channel);
    if (newState.channel) reevaluateSupportRoom(newState.channel);
  }
  if (GAME_MONITOR_ENABLED) {
    const member = newState.member || oldState.member;
    if (member) reevaluateGameMonitor(member);
  }
});

client.on('presenceUpdate', (oldPresence, newPresence) => {
  if (!GAME_MONITOR_ENABLED) return;
  const member = newPresence && newPresence.member;
  if (member) reevaluateGameMonitor(member);
});

client.once('ready', () => {
  console.log(`Logged in as: ${client.user.tag}`);

  // فحص دوري (كل 30 ثانية) - يغطي الحالات اللي ما فيها حدث جديد يشغل الفحص
  // (مثلاً شخص موجود بالروم أصلاً قبل ما البوت يشتغل أو يعاد تشغيله)
  if (AUTO_RETURN_ENABLED || GAME_MONITOR_ENABLED) {
    setInterval(async () => {
      try {
        for (const guild of client.guilds.cache.values()) {
          const voiceChannels = guild.channels.cache.filter(
            (ch) => ch.isVoiceBased && ch.isVoiceBased() && isSupportRoom(ch.name)
          );
          for (const channel of voiceChannels.values()) {
            if (AUTO_RETURN_ENABLED) {
              reevaluateSupportRoom(channel);
            }
            if (GAME_MONITOR_ENABLED) {
              for (const member of channel.members.values()) {
                reevaluateGameMonitor(member);
              }
            }
          }
        }
      } catch (err) {
        console.error('[SWEEP] خطأ بالفحص الدوري:', err.message);
      }
    }, 30 * 1000);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ---------- /تقرير-اسبوعي ----------
  if (interaction.commandName === 'تقرير-اسبوعي') {
    await interaction.deferReply();

    const { days, label } = getPeriodDays(interaction, 'شهري');
    const logChannel = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
    const counts = await collectWeeklyStats(logChannel, interaction.guild, days);

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
      .setTitle(days === 30 ? '📊 تقرير نشاط الدعم الشهري' : '📊 تقرير نشاط الدعم الأسبوعي')
      .setDescription(buildTable(adminsData))
      .setColor(0x5865f2)
      .setFooter({ text: `${label} • عبّي التعامل والتقييم عبر أمر /تقييم` })
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

    const { days, label } = getPeriodDays(interaction, 'اسبوعي');
    const pullChannel = await client.channels.fetch(PULL_LOG_CHANNEL_ID);
    const counts = await collectPullStats(pullChannel, days);

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
      .setTitle(days === 30 ? '📊 تقرير السحب اليدوي الشهري' : '📊 تقرير السحب اليدوي الأسبوعي')
      .setDescription(buildPullTable(adminsData))
      .setColor(0x57f287)
      .setFooter({ text: `${label} • عدد الرسائل بروم سجل السحب اليدوي (يعتمد على كتابة الإداري نفسه)` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ---------- /تقرير-حضور (مدمج: سحب + وقت الحضور، بالاعتماد على لوق الصوت التلقائي) ----------
  if (interaction.commandName === 'تقرير-حضور') {
    await interaction.deferReply();

    const { days, label } = getPeriodDays(interaction, 'اسبوعي');
    const voiceChannel = await client.channels.fetch(VOICE_LOG_CHANNEL_ID);
    const { totalMs, pulls } = await collectVoiceStats(voiceChannel, days);

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
      .setTitle(days === 30 ? '📊 تقرير الحضور والسحب الشهري' : '📊 تقرير الحضور والسحب الأسبوعي')
      .setDescription(buildCombinedTable(adminsData))
      .setColor(0xfee75c)
      .setFooter({ text: `${label} • وقت الحضور بروم الدعم + عدد مرات السحب من Waiting` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ---------- /تقرير-شامل (يجمع الثلاثة: تذاكر + حضور/سحب تلقائي + سحب يدوي) ----------
  if (interaction.commandName === 'تقرير-شامل') {
    await interaction.deferReply();

    const { days, label } = getPeriodDays(interaction, 'اسبوعي');

    const ticketChannel = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
    const ticketCounts = await collectWeeklyStats(ticketChannel, interaction.guild, days);

    const voiceChannel = await client.channels.fetch(VOICE_LOG_CHANNEL_ID);
    const { totalMs, pulls: autoPulls } = await collectVoiceStats(voiceChannel, days);

    const manualPullChannel = await client.channels.fetch(PULL_LOG_CHANNEL_ID);
    const manualPulls = await collectPullStats(manualPullChannel, days);

    // نجمع كل الـ IDs اللي ظهرت بأي مصدر من الثلاثة
    const allUserIds = new Set([
      ...Object.keys(ticketCounts),
      ...Object.keys(totalMs),
      ...Object.keys(autoPulls),
      ...Object.keys(manualPulls),
    ]);

    const guild = interaction.guild;
    const adminsData = {};
    for (const userId of allUserIds) {
      let displayName = userId;
      try {
        const member = await guild.members.fetch(userId);
        displayName = member.displayName;
      } catch {
        // العضو غير موجود بالسيرفر حالياً، نستخدم الـ ID
      }
      adminsData[displayName] = {
        tickets: ticketCounts[userId] || 0,
        durationMs: totalMs[userId] || 0,
        autoPulls: autoPulls[userId] || 0,
        manualPulls: manualPulls[userId] || 0,
      };
    }

    const embed = new EmbedBuilder()
      .setTitle(days === 30 ? '📊 التقرير الشامل الشهري' : '📊 التقرير الشامل الأسبوعي')
      .setDescription(buildMergedTable(adminsData))
      .setColor(0x5865f2)
      .setFooter({ text: `${label} • يجمع: التذاكر + وقت الحضور والسحب التلقائي + السحب اليدوي` })
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
