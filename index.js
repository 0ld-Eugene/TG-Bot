import 'dotenv/config';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Telegraf, Markup } from 'telegraf';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import ExcelJS from 'exceljs';
import fs from 'fs';
import axios from 'axios';
import winston from 'winston';

// --- НАСТРОЙКА ЛОГГЕРА ---
const logger = winston.createLogger({
   level: 'info',
   format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
   ),
   transports: [
      new winston.transports.File({ filename: 'bot_activity.log' }),
      new winston.transports.Console()
   ]
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const YANDEX_TOKEN = process.env.YANDEX_SECRET_ACCESS_KEY;
const PROXY_URL = process.env.PROXY_URL;

let proxyAgent = null;
if (PROXY_URL) {
   proxyAgent = new HttpsProxyAgent(PROXY_URL);
   logger.info(`✅ Прокси настроен`);
}

const ADMIN_IDS = process.env.ADMIN_ID
   ? process.env.ADMIN_ID.split(',').map(id => Number(id.trim()))
   : [];

const FILE_PATH = './leads_report.xlsx';
const MEDITATION_FILE = './files/Практика повышения сексуальности.mp3';

const bot = new Telegraf(BOT_TOKEN, {
   telegram: proxyAgent ? { agent: proxyAgent, timeout: 60000 } : {}
});

const userStages = {};

// bot.telegram.setMyCommands([
//    { command: 'start', description: 'Запустить бота' },
//    { command: 'admin', description: 'Панель управления (только для админов)' }
// ]);

async function generateExcel(db) {
   try {
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
   } catch (e) {
      logger.error(`Ошибка генерации Excel: ${e.message}`);
      throw e;
   }
}

async function uploadToYandexDisk(db) {
   try {
      await generateExcel(db);

      // Отключаем прокси для Яндекс.Диска
      const axiosConfig = {
         headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` },
         proxy: false,  // ← ключевая строчка
         httpsAgent: null,
         httpAgent: null
      };

      const { data: { href } } = await axios.get(
         `https://cloud-api.yandex.net/v1/disk/resources/upload?path=app:/leads.xlsx&overwrite=true`,
         axiosConfig
      );

      const fileStream = fs.createReadStream(FILE_PATH);
      await axios.put(href, fileStream, axiosConfig);
      logger.info('✅ Яндекс.Диск успешно обновлен');
   } catch (e) {
      logger.error(`❌ Ошибка Яндекс.Диска: ${e.message}`);
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
   logger.info('🚀 Бот запущен');

   bot.command('admin', async (ctx) => {
      const userId = ctx.from.id;
      if (!ADMIN_IDS.includes(userId)) {
         return ctx.reply('У вас нет прав для этой команды.');
      }
      userStages[userId] = { step: 'IDLE', isAdminMode: true };
      return ctx.reply(`Режим администратора активирован. 😎`,
         Markup.inlineKeyboard([
            [Markup.button.callback('📊 ВЫГРУЗИТЬ БАЗУ', 'ADMIN_EXPORT')],
            [Markup.button.callback('📣 СОЗДАТЬ РАССЫЛКУ', 'ADMIN_BROADCAST_START')],
            [Markup.button.callback('🌐 РЕЖИМ ЮЗЕРА', 'USER_MODE')]
         ])
      );
   });

   bot.start(async (ctx) => {
      const userId = ctx.from.id;
      if (!userStages[userId]) {
         userStages[userId] = { step: 'IDLE', isAdminMode: true };
      }

      if (ADMIN_IDS.includes(userId) && userStages[userId].isAdminMode) {
         return ctx.reply(`Приветствую госпожа! 😎 Чем могу служить?`,
            Markup.inlineKeyboard([
               [Markup.button.callback('📊 ВЫГРУЗИТЬ БАЗУ', 'ADMIN_EXPORT')],
               [Markup.button.callback('📣 СОЗДАТЬ РАССЫЛКУ', 'ADMIN_BROADCAST_START')],
               [Markup.button.callback('🌐 РЕЖИМ ЮЗЕРА', 'USER_MODE')]
            ])
         );
      }

      const existingUser = await db.get('SELECT * FROM leads WHERE tg_id = ?', [userId]);
      if (existingUser && existingUser.email) {
         await ctx.reply(`Рад снова видеть тебя, ${existingUser.name}! 😊 Лови медитацию еще раз:`);
         if (fs.existsSync(MEDITATION_FILE)) {
            return ctx.replyWithAudio({ source: MEDITATION_FILE });
         }
         return;
      }

      await db.run(
         'INSERT INTO leads (tg_id, username, source) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET source = excluded.source',
         [userId, ctx.from.username, ctx.payload || 'direct']
      );

      userStages[userId].step = 'IDLE';
      await ctx.replyWithHTML(
         `👋 <b>Привет! 🤍</b>\n\nЯ рад, что ты решила улучшить чувственность и прийти к новому состоянию.\n\nНажми кнопку ниже, чтобы забрать свой <b>Подарок</b>.`,
         Markup.inlineKeyboard([[Markup.button.callback('🎁 ПОЛУЧИТЬ ПОДАРОК', 'START_QUIZ')]])
      );
   });

   bot.action('ADMIN_EXPORT', async (ctx) => {
      if (!ADMIN_IDS.includes(ctx.from.id)) return;
      if (!userStages[ctx.from.id]) userStages[ctx.from.id] = { step: 'IDLE', isAdminMode: true };

      await ctx.answerCbQuery('Генерирую Excel...');
      try {
         const file = await generateExcel(db);
         await ctx.replyWithDocument({ source: file, filename: 'leads_report.xlsx' });
      } catch (e) {
         await ctx.reply('Ошибка: ' + e.message);
      }
   });

   bot.action('USER_MODE', async (ctx) => {
      if (!ADMIN_IDS.includes(ctx.from.id)) return;
      if (!userStages[ctx.from.id]) userStages[ctx.from.id] = { step: 'IDLE', isAdminMode: true };
      userStages[ctx.from.id].isAdminMode = false;
      await ctx.answerCbQuery();
      await ctx.reply('Окей, теперь ты как обычный юзер. Нажми /start чтобы пройти опрос.');
   });

   bot.action('ADMIN_BROADCAST_START', async (ctx) => {
      if (!ADMIN_IDS.includes(ctx.from.id)) return;
      if (!userStages[ctx.from.id]) userStages[ctx.from.id] = { step: 'IDLE', isAdminMode: true };
      userStages[ctx.from.id].step = 'BC_WAIT_MSG';
      await ctx.answerCbQuery();
      await ctx.reply('Пришлите сообщение для рассылки (текст + фото, текст + видео, кружок или голосовое):');
   });

   bot.on(['text', 'photo', 'video', 'voice', 'video_note'], async (ctx, next) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];
      if (!stage) return next();

      if (stage.step === 'BC_WAIT_MSG') {
         stage.broadcastMsg = ctx.message;
         stage.step = 'BC_WAIT_URL';
         return ctx.reply('Нужна кнопка-ссылка? Пришлите URL или напишите /skip');
      }

      if (stage.step === 'BC_WAIT_URL') {
         if (ctx.message?.text && ctx.message.text !== '/skip') {
            const url = ctx.message.text;
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
               return ctx.reply('❌ Ошибка: Ссылка должна начинаться с http:// или https://');
            }
            stage.broadcastUrl = url;
         }
         stage.step = 'BC_CONFIRM';
         try {
            await ctx.reply('📢 ПРЕВЬЮ ПОСТА:');
            const extra = stage.broadcastUrl
               ? Markup.inlineKeyboard([[Markup.button.url('Узнать больше', stage.broadcastUrl)]])
               : {};
            await ctx.telegram.copyMessage(userId, userId, stage.broadcastMsg.message_id, extra);
            return ctx.reply('Все верно? Запускаем?', Markup.inlineKeyboard([
               [Markup.button.callback('🚀 ДА, ЗАПУСКАЙ!', 'BC_SEND')],
               [Markup.button.callback('❌ ОТМЕНА', 'BC_CANCEL')]
            ]));
         } catch (e) {
            stage.step = 'BC_WAIT_URL';
            return ctx.reply('⚠ Ошибка в ссылке. Попробуйте еще раз или напишите /skip:');
         }
      }

      if (stage.step !== 'IDLE' && !ctx.message.text) {
         return ctx.reply(`Хмм, я понимаю только текст. Пожалуйста, напиши ответ словами.`);
      }
      return next();
   });

   bot.action('BC_SEND', async (ctx) => {
      if (!ADMIN_IDS.includes(ctx.from.id)) return;
      const stage = userStages[ctx.from.id];
      if (!stage || !stage.broadcastMsg) return ctx.reply('Ошибка: данные рассылки потеряны.');
      const users = await db.all('SELECT tg_id FROM leads');
      await ctx.editMessageText(`🚀 Рассылка пошла (${users.length} чел.)...`);
      let success = 0; let failed = 0;
      for (const user of users) {
         try {
            const extra = stage.broadcastUrl ? Markup.inlineKeyboard([[Markup.button.url('Узнать больше', stage.broadcastUrl)]]) : {};
            await ctx.telegram.copyMessage(user.tg_id, ctx.from.id, stage.broadcastMsg.message_id, extra);
            success++;
            await new Promise(res => setTimeout(res, 35));
         } catch (e) { failed++; }
      }
      stage.step = 'IDLE';
      stage.broadcastUrl = null;
      await ctx.reply(`✅ Рассылка завершена!\n\nДоставлено: ${success}\nОшибок: ${failed}`);
   });

   bot.action('BC_CANCEL', async (ctx) => {
      if (userStages[ctx.from.id]) userStages[ctx.from.id].step = 'IDLE';
      await ctx.answerCbQuery();
      await ctx.reply('Действие отменено.');
   });

   bot.action('START_QUIZ', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
         `🤝 <b>Небольшая формальность</b>\n\nЧтобы я мог отправить тебе файл, мне нужно твоё согласие на обработку данных.\n\nНикакого спама, буду писать только с полезностями 🤍`,
         {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
               [Markup.button.callback('✅ Даю согласие!', 'AGREE_DATA')],
               [Markup.button.callback('❌ Не в этот раз', 'BC_CANCEL')]
            ])
         }
      );
   });

   bot.action('AGREE_DATA', async (ctx) => {
      const userId = ctx.from.id;
      const now = new Date().toLocaleString('ru-RU');
      await db.run('UPDATE leads SET agreed_at = ? WHERE tg_id = ?', [now, userId]);
      if (!userStages[userId]) userStages[userId] = { step: 'IDLE' };
      userStages[userId].step = 'WAIT_NAME';
      await ctx.answerCbQuery();
      await ctx.editMessageText('Давай знакомиться. Как я могу к тебе обращаться?');
   });

   bot.on('text', async (ctx, next) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];
      if (!stage || stage.step === 'IDLE' || ctx.message.text.startsWith('/')) return next();
      const input = ctx.message.text;

      if (stage.step === 'WAIT_NAME') {
         stage.name = input;
         await db.run('UPDATE leads SET name = ? WHERE tg_id = ?', [input, userId]);
         stage.step = 'WAIT_PHONE';
         return ctx.reply(`Очень приятно!\n\n${stage.name} напиши, пожалуйста, свой номер телефона:`);
      }

      if (stage.step === 'WAIT_PHONE') {
         const cleanPhone = input.replace(/\D/g, '');
         if (cleanPhone.length < 10 || cleanPhone.length > 15) {
            return ctx.reply(`Ошибка в номере. Проверь цифры.`);
         }
         await db.run('UPDATE leads SET phone = ? WHERE tg_id = ?', [input, userId]);
         stage.step = 'WAIT_EMAIL';
         return ctx.reply(`И последнее — твой email 💌`);
      }

      if (stage.step === 'WAIT_EMAIL') {
         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
         if (!emailRegex.test(input)) {
            return ctx.reply(`Ошибка в почте. Попробуй еще раз:`);
         }
         await db.run('UPDATE leads SET email = ? WHERE tg_id = ?', [input, userId]);
         await ctx.reply(`Спасибо тебе 🤍! А теперь лови подарок 🎁`);

         await uploadToYandexDisk(db);
         if (fs.existsSync(MEDITATION_FILE)) {
            await ctx.replyWithAudio({ source: MEDITATION_FILE }, { title: 'Твоя Медитация', performer: '🤍' });
         }
         stage.step = 'IDLE';
      }
   });

   bot.launch().then(() => {
      logger.info('✅ Бот успешно запущен');
   }).catch((err) => {
      logger.error(`❌ Ошибка запуска: ${err.message}`);
   });
}

startApp().catch(err => logger.error('Критическая ошибка запуска: ' + err.message));
