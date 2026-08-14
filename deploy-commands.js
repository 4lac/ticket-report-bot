// يسجل الأوامر (Slash Commands) مرة وحدة عند أول تشغيل، أو كل ما تعدل الأوامر
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('تقرير-اسبوعي')
    .setDescription('يطلع جدول نشاط فريق الدعم لآخر 7 أيام من سجل التذاكر'),

  new SlashCommandBuilder()
    .setName('تقرير-سحب')
    .setDescription('يطلع جدول عدد مرات السحب لكل إداري لآخر 7 أيام من روم سجل السحب'),

  new SlashCommandBuilder()
    .setName('تقرير-حضور')
    .setDescription('يطلع جدول مجموع وقت كل إداري داخل رومات الدعم الصوتية لآخر 7 أيام'),

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
