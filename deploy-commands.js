// يسجل الأوامر (Slash Commands) مرة وحدة عند أول تشغيل، أو كل ما تعدل الأوامر
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// خيار "الفترة" المشترك بين كل تقارير الفرعية
function addPeriodOption(sub, defaultLabel) {
  return sub.addStringOption((opt) =>
    opt
      .setName('الفترة')
      .setDescription(`الفترة الزمنية (افتراضي: ${defaultLabel})`)
      .setRequired(false)
      .addChoices(
        { name: 'اسبوعي', value: 'اسبوعي' },
        { name: 'شهري', value: 'شهري' },
      ));
}

const commands = [
  // ---------- أمر "تقرير" المجمّع: كل التقارير تحته كأوامر فرعية (/تقرير <نوع>) ----------
  new SlashCommandBuilder()
    .setName('تقرير')
    .setDescription('تقارير فريق الدعم')
    .addSubcommand((sub) =>
      addPeriodOption(
        sub
          .setName('تذاكر')
          .setDescription('يطلع جدول نشاط فريق الدعم من سجل التذاكر'),
        'شهري',
      ))
    .addSubcommand((sub) =>
      addPeriodOption(
        sub
          .setName('تذاكر-ثانوية')
          .setDescription('عدد التذاكر المقفولة بالقطاعات الثانوية (Ticket Tool: Store, Justice, Health...)'),
        'اسبوعي',
      ))
    .addSubcommand((sub) =>
      addPeriodOption(
        sub
          .setName('سحب-يدوي')
          .setDescription('عدد مرات كتابة السحب لكل إداري بروم سجل السحب اليدوي'),
        'اسبوعي',
      ))
    .addSubcommand((sub) =>
      addPeriodOption(
        sub
          .setName('حضور')
          .setDescription('وقت الحضور بروم الدعم الصوتي + عدد مرات السحب'),
        'اسبوعي',
      ))
    .addSubcommand((sub) =>
      addPeriodOption(
        sub
          .setName('شامل')
          .setDescription('تقرير شامل (صورة): التذاكر + الحضور والسحب التلقائي + السحب اليدوي'),
        'اسبوعي',
      )),

  // ---------- أوامر مستقلة (مو تقرير) ----------
  new SlashCommandBuilder()
    .setName('تشخيص-تذاكر')
    .setDescription('أمر مؤقت: يطبع شكل رسائل لوق Ticket Tool بالترمنال للتشخيص'),

  new SlashCommandBuilder()
    .setName('تقييم')
    .setDescription('يعبي خانة التعامل والتقييم لإداري داخل آخر تقرير')
    .addStringOption((opt) =>
      opt.setName('اسم')
        .setDescription('اسم الإداري كما يظهر بالتقرير')
        .setRequired(true))
    .addStringOption((opt) =>
      opt.setName('تعامل')
        .setDescription('وصف قصير لكيف كان التعامل مع التذاكر')
        .setRequired(true))
    .addIntegerOption((opt) =>
      opt.setName('تقييم')
        .setDescription('تقييم من 1 إلى 5')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(5))
    .addIntegerOption((opt) =>
      opt.setName('عدد')
        .setDescription('تعديل عدد التذاكر يدوياً (اختياري، لو العدد التلقائي غير دقيق)')
        .setRequired(false)
        .setMinValue(0)),
]
  // كل الأوامر للإدارة بس (صلاحية Manage Server). صاحب السيرفر يقدر يعطيها رتب ثانية
  // من: Server Settings > Integrations > اسم البوت
  .map((c) => c.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Commands registered successfully.');
  } catch (err) {
    console.error(err);
  }
})();
