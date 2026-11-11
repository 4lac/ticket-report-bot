const path = require('path');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');

const FONTS_DIR = path.join(__dirname, 'assets', 'fonts');
// ---------- هوية السيرفر (من .env) ----------
const BRAND_NAME = (process.env.BRAND_NAME || 'Support Reports').trim();
const BRAND_COLOR = /^#?[0-9a-fA-F]{6}$/.test(process.env.BRAND_COLOR || '')
  ? '#' + process.env.BRAND_COLOR.replace('#', '')
  : '#e2203a';
// مسار الشعار نسبةً لمجلد البوت (مثال: assets/logo/my-logo.png). لو فاضي، يرسم شعار تذكرة افتراضي
const LOGO_PATH = process.env.BRAND_LOGO ? path.resolve(__dirname, process.env.BRAND_LOGO) : null;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
// يفتح أو يغمّق اللون (amount موجب = أفتح، سالب = أغمق)
function shade(hex, amount) {
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c + (target - c) * t));
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}
let fontsRegistered = false;
let logoImagePromise = null;
function ensureFonts() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'NotoKufiArabic.ttf'), 'NKufi');
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Poppins-Bold.ttf'), 'PoppinsBold');
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Poppins-SemiBold.ttf'), 'PoppinsSemiBold');
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Poppins-Regular.ttf'), 'Poppins');
  fontsRegistered = true;
}
function getLogoImage() {
  if (!LOGO_PATH) return Promise.resolve(null);
  if (!logoImagePromise) {
    logoImagePromise = loadImage(LOGO_PATH).catch((err) => {
      console.error('[BRAND] تعذر تحميل الشعار، بنستخدم الشعار الافتراضي:', err.message);
      return null;
    });
  }
  return logoImagePromise;
}

// ---------- ألوان الثيم (اللون الأساسي يجي من BRAND_COLOR) ----------
const COLORS = {
  bgTop: '#0a0a0d',
  bgBottom: '#000000',
  card: '#141418',
  cardAlt: '#17171c',
  border: 'rgba(255,255,255,0.06)',
  red: BRAND_COLOR,
  redDark: shade(BRAND_COLOR, -0.45),
  redLight: shade(BRAND_COLOR, 0.3),
  white: '#ffffff',
  gray: '#9a9aa3',
  grayDark: '#5c5c66',
  gold: '#f1c40f',
  silver: '#c9ccd1',
  bronze: '#cd7f32',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// -------- أيقونات بسيطة (بدون إيموجي عشان ما نعتمد على خط إيموجي قد ما يتوفر) --------
function drawIconTicket(ctx, cx, cy, size, color) {
  const w = size, h = size * 0.62;
  const x = cx - w / 2, y = cy - h / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.09;
  ctx.lineJoin = 'round';
  roundRect(ctx, x, y, w, h, h * 0.22);
  ctx.stroke();
  // خط تقطيع بالمنتصف
  ctx.setLineDash([size * 0.06, size * 0.06]);
  ctx.beginPath();
  ctx.moveTo(cx, y + h * 0.12);
  ctx.lineTo(cx, y + h - h * 0.12);
  ctx.stroke();
  ctx.restore();
}

function drawIconClock(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - size * 0.26);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + size * 0.18, cy + size * 0.1);
  ctx.stroke();
  ctx.restore();
}

function drawIconRefresh(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = 'round';
  const r = size * 0.36;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI * 0.75, Math.PI * 0.9);
  ctx.stroke();
  // رأس السهم
  const ang = Math.PI * 0.9;
  const ax = cx + r * Math.cos(ang);
  const ay = cy + r * Math.sin(ang);
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(ang + Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size * 0.16, -size * 0.05);
  ctx.lineTo(-size * 0.04, size * 0.16);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

function drawIconPencil(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = color;
  const w = size * 0.18, h = size * 0.62;
  roundRect(ctx, -w / 2, -h / 2, w, h * 0.78, w * 0.3);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-w / 2, h * 0.28 - h / 2);
  ctx.lineTo(w / 2, h * 0.28 - h / 2);
  ctx.lineTo(0, h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// -------- الشعار الافتراضي (تذكرة داخل مربع بلون السيرفر) - يطلع لو ما فيه BRAND_LOGO --------
function drawDefaultMark(ctx, x, y, size) {
  const grad = ctx.createLinearGradient(x, y, x, y + size);
  grad.addColorStop(0, COLORS.redLight);
  grad.addColorStop(1, COLORS.redDark);
  ctx.save();
  roundRect(ctx, x, y, size, size, size * 0.24);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
  drawIconTicket(ctx, x + size / 2, y + size / 2, size * 0.58, COLORS.white);
}

function drawDiagonalTicks(ctx, x, y, count, gap, len, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const sx = x + i * gap;
    ctx.beginPath();
    ctx.moveTo(sx, y + len);
    ctx.lineTo(sx + len * 0.45, y);
    ctx.stroke();
  }
  ctx.restore();
}

function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + '…';
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function rankColor(i) {
  if (i === 0) return COLORS.gold;
  if (i === 1) return COLORS.silver;
  if (i === 2) return COLORS.bronze;
  return COLORS.red;
}

/**
 * rows: [{ name, tickets, durationMs, autoPulls, manualPulls }]  (مرتبة مسبقاً)
 * meta: { title, periodLabel, partial, generatedAtText }
 */
async function renderFullReportImage({ rows, title, periodLabel, partial, generatedAtText }) {
  ensureFonts();
  const logoImage = await getLogoImage();

  const W = 1320;
  const PAD = 56;
  const HEADER_H = 300;
  const ROW_H = 118;
  const ROW_GAP = 18;
  const FOOTER_H = 96;
  const bodyRows = rows.length > 0 ? rows.length : 1;
  const H = HEADER_H + bodyRows * (ROW_H + ROW_GAP) - ROW_GAP + FOOTER_H + PAD;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.direction = 'rtl';

  // خلفية متدرجة
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, COLORS.bgTop);
  bgGrad.addColorStop(1, COLORS.bgBottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // توهج أحمر أعلى يمين
  const glow = ctx.createRadialGradient(W - 40, 40, 20, W - 40, 40, 480);
  glow.addColorStop(0, rgba(COLORS.red, 0.35));
  glow.addColorStop(1, rgba(COLORS.red, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, HEADER_H + 150);

  // توهج خفيف أسفل يسار
  const glow2 = ctx.createRadialGradient(60, H - 60, 10, 60, H - 60, 320);
  glow2.addColorStop(0, rgba(COLORS.red, 0.12));
  glow2.addColorStop(1, rgba(COLORS.red, 0));
  ctx.fillStyle = glow2;
  ctx.fillRect(0, H - 400, 420, 400);

  // ---------- الهيدر ----------
  drawDiagonalTicks(ctx, PAD, PAD + 4, 5, 16, 26, rgba(COLORS.red, 0.55));
  const logoSize = 76;
  if (logoImage) ctx.drawImage(logoImage, PAD, PAD + 34, logoSize, logoSize);
  else drawDefaultMark(ctx, PAD, PAD + 34, logoSize);

  // اسم السيرفر (يدعم العربي والإنجليزي)
  const brandIsArabic = /[\u0600-\u06FF]/.test(BRAND_NAME);
  ctx.textAlign = 'left';
  ctx.direction = brandIsArabic ? 'rtl' : 'ltr';
  ctx.font = brandIsArabic ? '700 30px NKufi' : '600 30px PoppinsBold';
  ctx.fillStyle = COLORS.white;
  ctx.fillText(truncateText(ctx, BRAND_NAME, 520), PAD + 90, PAD + 82);

  // العنوان الرئيسي (عربي RTL)
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.white;
  ctx.font = '700 54px NKufi';
  ctx.fillText(title, W - PAD, PAD + 150);

  ctx.font = '400 26px NKufi';
  ctx.fillStyle = COLORS.gray;
  ctx.fillText(periodLabel, W - PAD, PAD + 196);

  if (partial) {
    ctx.font = '400 22px NKufi';
    ctx.fillStyle = COLORS.red;
    ctx.fillText('⚠ بيانات جزئية (روم الصوت كان مزدحم) ⚠', W - PAD, PAD + 232);
  }

  // خط فاصل متدرج
  const lineGrad = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
  lineGrad.addColorStop(0, rgba(COLORS.red, 0));
  lineGrad.addColorStop(0.5, COLORS.red);
  lineGrad.addColorStop(1, rgba(COLORS.red, 0));
  ctx.fillStyle = lineGrad;
  ctx.fillRect(PAD, HEADER_H, W - PAD * 2, 3);

  // ---------- الصفوف ----------
  let y = HEADER_H + 26;

  if (rows.length === 0) {
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.font = '500 28px NKufi';
    ctx.fillStyle = COLORS.gray;
    ctx.fillText('ما فيه نشاط مسجل بهذي الفترة', W / 2, y + ROW_H / 2 + 10);
  } else {
    rows.forEach((r, i) => {
      const rowY = y + i * (ROW_H + ROW_GAP);
      ctx.fillStyle = i % 2 === 0 ? COLORS.card : COLORS.cardAlt;
      roundRect(ctx, PAD, rowY, W - PAD * 2, ROW_H, 18);
      ctx.fill();
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 1;
      roundRect(ctx, PAD, rowY, W - PAD * 2, ROW_H, 18);
      ctx.stroke();

      // شريط لون يمين الكرت
      const rc = rankColor(i);
      ctx.fillStyle = rc;
      roundRect(ctx, W - PAD - 10, rowY, 10, ROW_H, 5);
      ctx.fill();

      // شارة الترتيب
      const badgeCX = W - PAD - 58;
      const badgeCY = rowY + ROW_H / 2;
      ctx.beginPath();
      ctx.arc(badgeCX, badgeCY, 28, 0, Math.PI * 2);
      ctx.fillStyle = rc;
      ctx.fill();
      ctx.font = '700 24px Poppins';
      ctx.fillStyle = '#1a1a1a';
      ctx.textAlign = 'center';
      ctx.direction = 'ltr';
      ctx.fillText(String(i + 1), badgeCX, badgeCY + 8);

      // اسم الإداري - منطقة بعرض ثابت، نقصّ الاسم بـ "…" لو طويل عشان ما يزاحم الإحصائيات
      const NAME_ZONE_W = 400;
      const nameRightX = badgeCX - 42;
      const nameLeftX = nameRightX - NAME_ZONE_W;
      ctx.direction = 'rtl';
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.white;
      ctx.font = '700 30px NKufi';
      ctx.fillText(truncateText(ctx, r.name, NAME_ZONE_W), nameRightX, rowY + ROW_H / 2 + 11);

      // الإحصائيات (يسار الصف) - منطقة بعرض ثابت دايماً بغض النظر عن طول الاسم
      const stats = [
        { icon: 'ticket', label: 'تذاكر', value: String(r.tickets) },
        { icon: 'clock', label: 'مدة الدعم', value: r.durationLabel },
        { icon: 'refresh', label: 'سحب تلقائي', value: String(r.autoPulls) },
        { icon: 'pencil', label: 'سحب يدوي', value: String(r.manualPulls) },
      ];
      const statsAreaX = PAD + 20;
      const statsAreaW = nameLeftX - 14 - statsAreaX;
      const chipW = Math.min(230, statsAreaW / 4 - 14);
      stats.forEach((s, si) => {
        const chipX = statsAreaX + si * (chipW + 14);
        const chipCY = rowY + ROW_H / 2;
        // أيقونة
        const iconX = chipX + 22;
        ctx.fillStyle = COLORS.red;
        if (s.icon === 'ticket') drawIconTicket(ctx, iconX, chipCY, 26, COLORS.red);
        if (s.icon === 'clock') drawIconClock(ctx, iconX, chipCY, 26, COLORS.red);
        if (s.icon === 'refresh') drawIconRefresh(ctx, iconX, chipCY, 26, COLORS.red);
        if (s.icon === 'pencil') drawIconPencil(ctx, iconX, chipCY, 26, COLORS.red);

        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.font = '700 22px Poppins';
        ctx.fillStyle = COLORS.white;
        ctx.fillText(s.value, chipX + chipW - 14, chipCY - 2);
        ctx.font = '400 15px NKufi';
        ctx.fillStyle = COLORS.grayDark;
        ctx.fillText(s.label, chipX + chipW - 14, chipCY + 22);
      });
    });
  }

  // ---------- الفوتر ----------
  const footerY = H - FOOTER_H;
  ctx.fillStyle = lineGrad;
  ctx.fillRect(PAD, footerY, W - PAD * 2, 2);

  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.font = '600 20px NKufi';
  ctx.fillStyle = COLORS.gray;
  ctx.fillText(`${BRAND_NAME} • نظام التقارير`, W - PAD, footerY + 48);

  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.font = '400 18px Poppins';
  ctx.fillStyle = COLORS.grayDark;
  ctx.fillText(generatedAtText, PAD, footerY + 48);

  return canvas.toBuffer('image/png');
}

module.exports = { renderFullReportImage };
