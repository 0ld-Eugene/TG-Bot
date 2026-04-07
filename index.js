require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const ExcelJS = require('exceljs');
const fs = require('fs');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const YANDEX_TOKEN = process.env.YANDEX_SECRET_ACCESS_KEY;
const ADMIN_ID = process.env.ADMIN_ID;
const FILE_PATH = './leads_report.xlsx';

const bot = new Telegraf(BOT_TOKEN);
const userStages = {};

// --- Функция подготовки Excel (теперь возвращает workbook для гибкости) ---
async function generateExcel(db) {
   const rows = await db.all('SELECT * FROM leads ORDER BY id ASC');
   const workbook = new ExcelJS.Workbook();
   const sheet = workbook.addWorksheet('Лиды');
   sheet.columns = [
      { header: 'Username', key: 'username', width: 20 },
      { header: 'Имя', key: 'name', width: 25 },
      { header: 'Телефон', key: 'phone', width: 20 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Дата согласия', key: 'agreed_at', width: 20 },
      { header: 'Источник', key: 'source', width: 15 },
      { header: 'Дата создания', key: 'created_at', width: 20 }
   ];
   sheet.addRows(rows);
   const headerRow = sheet.getRow(1);
   headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
   });
   await workbook.xlsx.writeFile(FILE_PATH);
   return FILE_PATH;
}

// --- Функция выгрузки на Яндекс.Диск ---
async function uploadToYandexDisk(db) {
   try {
      await generateExcel(db);
      const { data: { href } } = await axios.get(
         `https://cloud-api.yandex.net/v1/disk/resources/upload?path=app:/leads.xlsx&overwrite=true`,
         { headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` } }
      );
      const fileStream = fs.createReadStream(FILE_PATH);
      await axios.put(href, fileStream);
      console.log('✅ Диск обновлен');
   } catch (e) {
      console.error('❌ Ошибка Диска:', e.message);
   }
}

async function initDatabase() {
   const db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
   await db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_id INTEGER UNIQUE,
            username TEXT,
            name TEXT,
            phone TEXT,
            email TEXT,
            agreed_at TEXT, 
            source TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
   return db;
}

async function startApp() {
   const db = await initDatabase();

   // --- ОБРАБОТКА /START ---
   bot.start(async (ctx) => {
      const userId = ctx.from.id;

      // 1. ПРОВЕРКА НА АДМИНА
      if (userId.toString() === ADMIN_ID) {
         return ctx.reply(`Здорова, босс! 😎 Чё какие дела?`,
            Markup.inlineKeyboard([
               [Markup.button.callback('📊 ВЫГРУЗИТЬ БАЗУ', 'ADMIN_EXPORT')],
               [Markup.button.callback('🌐 ПЕРЕЙТИ В РЕЖИМ ЮЗЕРА-АБЬЮЗЕРА', 'USER_MODE')]
            ])
         );
      }

      // 2. ОБЫЧНАЯ ЛОГИКА ЮЗЕРА
      const existingUser = await db.get('SELECT * FROM leads WHERE tg_id = ?', [userId]);
      if (existingUser && existingUser.email) {
         await ctx.reply(`Рад снова тебя видеть, ${existingUser.name || 'друг'}! 😊\nЛови свой гайд еще раз:`);
         if (fs.existsSync('./files/guide.pdf')) return ctx.replyWithDocument({ source: './files/guide.pdf' });
         return;
      }

      await db.run(
         'INSERT INTO leads (tg_id, username, source) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET source = excluded.source',
         [userId, ctx.from.username, ctx.payload || 'direct']
      );
      userStages[userId] = { step: 'IDLE', name: existingUser?.name || '' };
      await ctx.replyWithMarkdownV2(`👋 *Привет\\! Я бот\\-обормот*...`,
         Markup.inlineKeyboard([[Markup.button.callback('🚀 ПОЛУЧИТЬ ГАЙД', 'START_QUIZ')]]));
   });

   // --- АДМИНСКИЕ ДЕЙСТВИЯ ---
   bot.action('ADMIN_EXPORT', async (ctx) => {
      if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery('У тебя нет прав!');

      await ctx.answerCbQuery('Собираю данные...');
      await ctx.reply('Секунду, формирую отчет... ммм, свежатинка');

      try {
         const file = await generateExcel(db);
         await ctx.replyWithDocument({ source: file, filename: 'leads_report.xlsx' });
      } catch (e) {
         await ctx.reply('Ошибка при создании файла: ' + e.message);
      }
   });

   bot.action('USER_MODE', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('Окей, теперь ты как обычный смертный. Нажми /start чтобы начать опрос.');
   });

   // --- ОСТАЛЬНАЯ ЛОГИКА (START_QUIZ, AGREE_DATA и т.д. без изменений) ---
   bot.action('START_QUIZ', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(`🤝 *Небольшая формальность*...`, {
         parse_mode: 'MarkdownV2',
         ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Погнали!', 'AGREE_DATA')],
            [Markup.button.callback('❌ Не в этот раз', 'CANCEL_QUIZ')]
         ])
      });
   });

   bot.action('AGREE_DATA', async (ctx) => {
      const userId = ctx.from.id;
      const now = new Date().toLocaleString('ru-RU');
      await db.run('UPDATE leads SET agreed_at = ? WHERE tg_id = ?', [now, userId]);
      userStages[userId] = userStages[userId] || {};
      userStages[userId].step = 'WAIT_NAME';
      await ctx.answerCbQuery();
      await ctx.editMessageText('Отлично! Как мне к тебе обращаться?');
   });

   // Middleware защиты от мусора
   bot.on('message', async (ctx, next) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];
      if (!stage || stage.step === 'IDLE' || (ctx.message.text && ctx.message.text.startsWith('/'))) return next();
      if (!ctx.message.text) return ctx.reply(`Хмм, ${stage.name || 'друг'}, пришли, пожалуйста, текст.`);
      return next();
   });

   // Сбор данных
   bot.on('text', async (ctx, next) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];
      if (!stage || stage.step === 'IDLE' || ctx.message.text.startsWith('/')) return next();

      const input = ctx.message.text;

      if (stage.step === 'WAIT_NAME') {
         stage.name = input;
         await db.run('UPDATE leads SET name = ? WHERE tg_id = ?', [input, userId]);
         stage.step = 'WAIT_PHONE';
         return ctx.reply(`Приятно познакомиться, ${input}! Напиши телефон:`);
      }

      if (stage.step === 'WAIT_PHONE') {
         const cleanPhone = input.replace(/\D/g, '');
         if (cleanPhone.length < 10) return ctx.reply(`Ошибка в номере, ${stage.name}.`);
         await db.run('UPDATE leads SET phone = ? WHERE tg_id = ?', [input, userId]);
         stage.step = 'WAIT_EMAIL';
         return ctx.reply(`${stage.name}, теперь Email:`);
      }

      if (stage.step === 'WAIT_EMAIL') {
         if (!input.includes('@')) return ctx.reply(`Не похоже на Email.`);
         await db.run('UPDATE leads SET email = ? WHERE tg_id = ?', [input, userId]);
         await ctx.reply(`Готово, ${stage.name}!`);
         await uploadToYandexDisk(db);
         if (fs.existsSync('./files/guide.pdf')) await ctx.replyWithDocument({ source: './files/guide.pdf' });
         stage.step = 'IDLE';
      }
   });

   bot.launch();
}

startApp();