require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const ExcelJS = require('exceljs');
const fs = require('fs');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const YANDEX_TOKEN = process.env.YANDEX_SECRET_ACCESS_KEY;
const FILE_PATH = './leads_report.xlsx';

const bot = new Telegraf(BOT_TOKEN);
const userStages = {};

// --- Функция выгрузки (наш фундамент с "мягкой" синхронизацией) ---
async function uploadToYandexDisk(db) {
   try {
      const rows = await db.all('SELECT * FROM leads ORDER BY id ASC');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Лиды');

      sheet.columns = [
         { header: '№', key: 'id', width: 5 },
         { header: 'Username', key: 'username', width: 20 },
         { header: 'Имя', key: 'name', width: 25 },
         { header: 'Телефон', key: 'phone', width: 20 },
         { header: 'Email', key: 'email', width: 25 },
         { header: 'Источник', key: 'source', width: 15 },
         { header: 'Дата', key: 'created_at', width: 20 }
      ];
      sheet.addRows(rows);

      // Стилизация Excel
      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell) => {
         cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
         cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      });

      await workbook.xlsx.writeFile(FILE_PATH);

      const { data: { href } } = await axios.get(
         `https://cloud-api.yandex.net/v1/disk/resources/upload?path=app:/leads.xlsx&overwrite=true`,
         { headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` } }
      );

      const fileStream = fs.createReadStream(FILE_PATH);
      await axios.put(href, fileStream);
      console.log('✅ Диск обновлен');
   } catch (e) {
      if (e.response && e.response.status === 423) {
         console.log('⚠️ Файл занят, данные в SQLite');
      } else {
         console.error('❌ Ошибка:', e.message);
      }
   }
}

// --- Инициализация БД ---
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
            source TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
   return db;
}

// --- Основная логика ---
async function startApp() {
   const db = await initDatabase();

   // 1. Команда СТАРТ
   bot.start(async (ctx) => {
      const userId = ctx.from.id;
      const payload = ctx.payload || 'direct';

      await db.run(
         'INSERT INTO leads (tg_id, username, source) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET source = excluded.source',
         [userId, ctx.from.username, payload]
      );

      userStages[userId] = { step: 'IDLE' };

      await ctx.replyWithMarkdownV2(
         `👋 *Привет\\! Я бот\\-обормот* \n\nРад видеть тебя здесь\\. Нажми на кнопку ниже, чтобы забрать свой *Полезный Гайд*\\.`,
         Markup.inlineKeyboard([
            [Markup.button.callback('🚀 ПОЛУЧИТЬ ГАЙД', 'START_QUIZ')]
         ])
      );
   });

   // 2. Обработка нажатия на кнопку "Получить гайд" (переход к согласию)
   bot.action('START_QUIZ', async (ctx) => {
      await ctx.answerCbQuery();
      // Меняем текст первого сообщения на текст согласия
      await ctx.editMessageText(
         `🤝 *Небольшая формальность*\n\nЧтобы я мог отправить тебе файл, мне нужно твоё добро на обработку данных\\. Обещаю, никакого спама, всё [строго по делу](https://example.com/privacy)\\.`,
         {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
               [Markup.button.callback('✅ Погнали!', 'AGREE_DATA')],
               [Markup.button.callback('❌ Не в этот раз', 'CANCEL_QUIZ')]
            ])
         }
      );
   });

   // 3. Согласие получено — переходим к вопросам
   bot.action('AGREE_DATA', async (ctx) => {
      const userId = ctx.from.id;
      userStages[userId] = { step: 'WAIT_NAME' };
      await ctx.answerCbQuery();
      // Редактируем сообщение, переходя к первому вопросу
      await ctx.editMessageText('Отлично! Давай знакомиться. Как мне к тебе обращаться? (Напиши своё имя)');
   });

   // 4. Отказ от согласия
   bot.action('CANCEL_QUIZ', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText('Понимаю. Если передумаешь и всё же захочешь гайд — просто нажми /start');
   });

   // 5. Сбор текстовых данных (Имя, Телефон, Email)
   bot.on('text', async (ctx, next) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];
      if (!stage || stage.step === 'IDLE' || ctx.message.text.startsWith('/')) return next();

      if (stage.step === 'WAIT_NAME') {
         await db.run('UPDATE leads SET name = ? WHERE tg_id = ?', [ctx.message.text, userId]);
         userStages[userId].step = 'WAIT_PHONE';
         return ctx.reply('Приятно познакомиться! Напиши свой номер телефона, чтобы мы могли оставаться на связи:');
      }

      if (stage.step === 'WAIT_PHONE') {
         await db.run('UPDATE leads SET phone = ? WHERE tg_id = ?', [ctx.message.text, userId]);
         userStages[userId].step = 'WAIT_EMAIL';
         return ctx.reply('И последнее — твой Email:');
      }

      if (stage.step === 'WAIT_EMAIL') {
         await db.run('UPDATE leads SET email = ? WHERE tg_id = ?', [ctx.message.text, userId]);
         await ctx.reply('Спасибо! Твой гайд уже летит к тебе...');

         await uploadToYandexDisk(db);

         if (fs.existsSync('./files/guide.pdf')) {
            await ctx.replyWithDocument({ source: './files/guide.pdf' });
         }
         userStages[userId].step = 'IDLE';
      }
   });

   bot.launch();
}

startApp();