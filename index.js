require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');

// --- НАСТРОЙКИ ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

const bot = new Telegraf(BOT_TOKEN);

// Хранилище временных данных (пока юзер заполняет анкету)
const userStages = {};

// --- ФУНКЦИИ ---

async function sendToGoogle(data) {
   try {
      await fetch(GOOGLE_SCRIPT_URL, {
         method: 'POST',
         body: JSON.stringify(data),
         headers: { 'Content-Type': 'application/json' }
      });
   } catch (e) { console.error('Ошибка Google:', e.message); }
}

async function initDatabase() {
   const db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
   // Обновляем таблицу, добавляя поля для анкеты
   await db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_id INTEGER,
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

async function startApp() {
   const db = await initDatabase();
   console.log('🚀 Бот с анкетой запущен!');

   bot.start(async (ctx) => {
      const payload = ctx.payload || 'direct';
      // Очищаем состояние при рестарте
      delete userStages[ctx.from.id];

      await ctx.reply(
         `Привет, ${ctx.from.first_name}! 👋\nНажми кнопку ниже, чтобы начать получение гайда.`,
         Markup.keyboard([['🚀 Получить гайд']]).oneTime().resize()
      );

      // Запоминаем источник в памяти
      userStages[ctx.from.id] = { source: payload };
   });

   bot.hears('🚀 Получить гайд', async (ctx) => {
      userStages[ctx.from.id].step = 'WAIT_NAME';
      // Скрываем клавиатуру (удаляем её)
      await ctx.reply('Отлично! Для начала, напишите, пожалуйста, ваше имя:', Markup.removeKeyboard());
   });

   // Обработка текстовых сообщений (ввод данных анкеты)
   bot.on('text', async (ctx) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];

      if (!stage || !stage.step) return;

      if (stage.step === 'WAIT_NAME') {
         stage.name = ctx.message.text;
         stage.step = 'WAIT_PHONE';
         return ctx.reply('Принято! Теперь напишите ваш номер телефона:');
      }

      if (stage.step === 'WAIT_PHONE') {
         stage.phone = ctx.message.text;
         stage.step = 'WAIT_EMAIL';
         return ctx.reply('И последнее: введите вашу электронную почту (email):');
      }

      if (stage.step === 'WAIT_EMAIL') {
         stage.email = ctx.message.text;
         const date = new Date().toLocaleString('ru-RU');

         try {
            // 1. Сохраняем всё в SQLite
            const result = await db.run(
               'INSERT INTO leads (tg_id, username, name, phone, email, source) VALUES (?, ?, ?, ?, ?, ?)',
               [userId, ctx.from.username || 'no', stage.name, stage.phone, stage.email, stage.source]
            );

            // 2. Отправляем всё в Google (обнови в Apps Script заголовки!)
            await sendToGoogle({
               id: result.lastID,
               tg_id: userId,
               username: ctx.from.username || 'no',
               name: stage.name,
               phone: stage.phone,
               email: stage.email,
               source: stage.source,
               date: date
            });

            await ctx.reply('Данные получены! А вот и обещанный гайд 👇');

            if (fs.existsSync('./files/guide.pdf')) {
               await ctx.replyWithDocument({ source: './files/guide.pdf', filename: 'Гайд.pdf' });
            }

            // Очищаем состояние после завершения
            delete userStages[userId];

         } catch (e) {
            console.error(e);
            ctx.reply('Произошла ошибка при сохранении данных.');
         }
      }
   });

   bot.launch();
}

startApp();