// يسجل الأوامر (Slash Commands) مرة وحدة عند أول تشغيل، أو كل ما تعدل الأوامر
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('تقرير-تذاكر')
    .setDescription('يطلع جدول نشاط فريق الدعم من سجل التذاكر')
    .addStringOption(opt =>
      opt.setName('الفترة')
        .setDescription('الفترة الزمنية (افتراضي: شهري)')
        .setRequired(false)
        .addChoices(
          { name: 'اسبوعي', value: 'اسبوعي' },
          { name: 'شهري', value: 'شهري' },
        )),

  new SlashCommandBuilder()
    .setName('تقرير-سحب-يدوي')
    .setDescription('يطلع جدول عدد مرات كتابة السحب لكل إداري بروم سجل السحب اليدوي')
    .addStringOption(opt =>
      opt.setName('الفترة')
        .setDescription('الفترة الزمنية (افتراضي: اسبوعي)')
        .setRequired(false)
        .addChoices(
          { name: 'اسبوعي', value: 'اسبوعي' },
          { name: 'شهري', value: 'شهري' },
        )),

  new SlashCommandBuilder()
    .setName('تقرير-حضور')
    .setDescription('يطلع تقرير مدمج: وقت الحضور بروم الدعم الصوتي + عدد مرات السحب')
    .addStringOption(opt =>
      opt.setName('الفترة')
        .setDescription('الفترة الزمنية (افتراضي: اسبوعي)')
        .setRequired(false)
        .addChoices(
          { name: 'اسبوعي', value: 'اسبوعي' },
          { name: 'شهري', value: 'شهري' },
        )),

  new SlashCommandBuilder()
    .setName('تقرير-شامل')
    .setDescription('يجمع التذاكر + وقت الحضور + السحب التلقائي + السحب اليدوي بجدول واحد')
    .addStringOption(opt =>
      opt.setName('الفترة')
        .setDescription('الفترة الزمنية (افتراضي: اسبوعي)')
        .setRequired(false)
        .addChoices(
          { name: 'اسبوعي', value: 'اسبوعي' },
          { name: 'شهري', value: 'شهري' },
        )),

  new SlashCommandBuilder()
    .setName('تقرير-تذاكر-ثانوية')
    .setDescription('يطلع جدول عدد التذاكر المقفولة بالقطاعات الثانوية (Ticket Tool: Store, Justice, Health...)')
    .addStringOption(opt =>
      opt.setName('الفترة')
        .setDescription('الفترة الزمنية (افتراضي: اسبوعي)')
        .setRequired(false)
        .addChoices(
          { name: 'اسبوعي', value: 'اسبوعي' },
          { name: 'شهري', value: 'شهري' },
        )),

  new SlashCommandBuilder()
    .setName('تشخيص-تذاكر')
    .setDescription('أمر مؤقت: يطبع شكل رسائل لوق Ticket Tool بالترمنال للتشخيص'),

  new SlashCommandBuilder()
    .setName('تقييم')
    .setDescription('يعبي خانة التعامل والتقييم لإداري داخل آخر تقرير')
    .addStringOption(opt =>
      opt.setName('اسم')
        .setDescription('اسم الإداري كما يظهر بالتقرير')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('تعامل')
        .setDescription('وصف قصير لكيف كان التعامل مع التذاكر')
        .setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('تقييم')
        .setDescription('تقييم من 1 إلى 5')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(5))
    .addIntegerOption(opt =>
      opt.setName('عدد')
        .setDescription('تعديل عدد التذاكر يدوياً (اختياري، لو العدد التلقائي غير دقيق)')
        .setRequired(false)
        .setMinValue(0)),
].map(c => c.toJSON());

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
