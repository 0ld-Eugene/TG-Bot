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

// --- ФУНКЦИЯ: Создание Excel и заливка на Диск ---
async function uploadToYandexDisk(db) {
   try {
      // 1. Выгружаем всё из SQLite
      const rows = await db.all('SELECT * FROM leads ORDER BY id DESC');

      // 2. Создаем Excel файл
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Лиды');
      sheet.columns = [
         { header: 'ID', key: 'id' },
         { header: 'TG ID', key: 'tg_id' },
         { header: 'Username', key: 'username' },
         { header: 'Имя', key: 'name' },
         { header: 'Телефон', key: 'phone' },
         { header: 'Email', key: 'email' },
         { header: 'Источник', key: 'source' },
         { header: 'Дата', key: 'created_at' }
      ];
      sheet.addRows(rows);
      await workbook.xlsx.writeFile(FILE_PATH);

      // 3. Получаем ссылку для загрузки от Яндекса
      const { data: { href } } = await axios.get(
         `https://cloud-api.yandex.net/v1/disk/resources/upload?path=app:/leads.xlsx&overwrite=true`,
         { headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` } }
      );

      // 4. Загружаем сам файл
      const fileStream = fs.createReadStream(FILE_PATH);
      await axios.put(href, fileStream);

      console.log('✅ Файл успешно обновлен на Яндекс Диске (папка Приложения)!');
   } catch (e) {
      console.error('❌ Ошибка синхронизации с Диском:', e.message);
   }
}

// --- БАЗА ДАННЫХ ---
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

// --- ЛОГИКА БОТА ---
async function startApp() {
   const db = await initDatabase();
   console.log('🚀 Бот запущен в режиме синхронизации с Диском!');

   bot.start(async (ctx) => {
      const userId = ctx.from.id;
      const payload = ctx.payload || 'direct';
      await db.run(
         'INSERT INTO leads (tg_id, username, source) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET source = excluded.source',
         [userId, ctx.from.username, payload]
      );
      userStages[userId] = { step: 'IDLE' };
      await ctx.reply('Привет! Нажми кнопку, чтобы получить гайд.', Markup.keyboard([['🚀 Получить гайд']]).resize());
   });

   bot.hears('🚀 Получить гайд', (ctx) => {
      userStages[ctx.from.id] = { step: 'WAIT_NAME' };
      ctx.reply('Ваше имя:', Markup.removeKeyboard());
   });

   bot.on('text', async (ctx, next) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];
      if (!stage || stage.step === 'IDLE' || ctx.message.text.startsWith('/')) return next();

      if (stage.step === 'WAIT_NAME') {
         await db.run('UPDATE leads SET name = ? WHERE tg_id = ?', [ctx.message.text, userId]);
         userStages[userId].step = 'WAIT_PHONE';
         return ctx.reply('Телефон:');
      }

      if (stage.step === 'WAIT_PHONE') {
         await db.run('UPDATE leads SET phone = ? WHERE tg_id = ?', [ctx.message.text, userId]);
         userStages[userId].step = 'WAIT_EMAIL';
         return ctx.reply('Email:');
      }

      if (stage.step === 'WAIT_EMAIL') {
         await db.run('UPDATE leads SET email = ? WHERE tg_id = ?', [ctx.message.text, userId]);

         await ctx.reply('Готово! Твой гайд отправляется...');

         // Запускаем синхронизацию
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