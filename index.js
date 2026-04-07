require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const ExcelJS = require('exceljs');
const fs = require('fs');
const axios = require('axios');
const winston = require('winston');

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
const ADMIN_ID = process.env.ADMIN_ID;
const FILE_PATH = './leads_report.xlsx';

const bot = new Telegraf(BOT_TOKEN);
const userStages = {};

// --- Функция генерации Excel ---
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

// --- Выгрузка на Диск ---
async function uploadToYandexDisk(db) {
   try {
      await generateExcel(db);
      const { data: { href } } = await axios.get(
         `https://cloud-api.yandex.net/v1/disk/resources/upload?path=app:/leads.xlsx&overwrite=true`,
         { headers: { 'Authorization': `OAuth ${YANDEX_TOKEN}` } }
      );
      const fileStream = fs.createReadStream(FILE_PATH);
      await axios.put(href, fileStream);
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

   // --- ОБРАБОТКА /START ---
   bot.start(async (ctx) => {
      const userId = ctx.from.id;

      // Инициализируем стейдж
      if (!userStages[userId]) {
         userStages[userId] = { step: 'IDLE', isAdminMode: true };
      }

      // ПРОВЕРКА НА АДМИНА
      if (userId.toString() === ADMIN_ID && userStages[userId].isAdminMode) {
         return ctx.reply(`Здорова, босс! 😎 Чё какие дела?`,
            Markup.inlineKeyboard([
               [Markup.button.callback('📊 ВЫГРУЗИТЬ БАЗУ', 'ADMIN_EXPORT')],
               [Markup.button.callback('📣 СОЗДАТЬ РАССЫЛКУ', 'ADMIN_BROADCAST_START')],
               [Markup.button.callback('🌐 РЕЖИМ ЮЗЕРА', 'USER_MODE')]
            ])
         );
      }

      // ОБЫЧНАЯ ЛОГИКА ЮЗЕРА
      const existingUser = await db.get('SELECT * FROM leads WHERE tg_id = ?', [userId]);
      if (existingUser && existingUser.email) {
         await ctx.reply(`Рад снова видеть тебя, ${existingUser.name}! 😊 Лови гайд еще раз:`);
         if (fs.existsSync('./files/guide.pdf')) {
            return ctx.replyWithDocument({ source: './files/guide.pdf' });
         }
         return;
      }

      // Сохраняем лида
      await db.run(
         'INSERT INTO leads (tg_id, username, source) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET source = excluded.source',
         [userId, ctx.from.username, ctx.payload || 'direct']
      );

      userStages[userId].step = 'IDLE';
      await ctx.replyWithHTML(
         `👋 <b>Привет! Я бот-обормот</b>\n\nРад видеть тебя здесь. Нажми кнопку ниже, чтобы забрать свой <b>Полезный Гайд</b>.`,
         Markup.inlineKeyboard([[Markup.button.callback('🚀 ПОЛУЧИТЬ ГАЙД', 'START_QUIZ')]])
      );
   });

   // --- АДМИНСКИЕ ДЕЙСТВИЯ ---
   bot.action('ADMIN_EXPORT', async (ctx) => {
      if (ctx.from.id.toString() !== ADMIN_ID) return;
      await ctx.answerCbQuery('Генерирую Excel...');
      try {
         const file = await generateExcel(db);
         await ctx.replyWithDocument({ source: file, filename: 'leads_report.xlsx' });
      } catch (e) {
         await ctx.reply('Ошибка: ' + e.message);
      }
   });

   bot.action('USER_MODE', async (ctx) => {
      if (ctx.from.id.toString() !== ADMIN_ID) return;
      userStages[ctx.from.id].isAdminMode = false;
      await ctx.answerCbQuery();
      await ctx.reply('Окей, теперь ты как обычный юзер. Нажми /start чтобы пройти опрос.');
   });

   // --- РАССЫЛКА ---
   bot.action('ADMIN_BROADCAST_START', async (ctx) => {
      if (ctx.from.id.toString() !== ADMIN_ID) return;
      userStages[ctx.from.id].step = 'BC_WAIT_MSG';
      await ctx.answerCbQuery();
      await ctx.reply('Пришлите сообщение для рассылки (текст, фото или видео с описанием):');
   });

   // Хендлер для контента рассылки и опроса
   bot.on(['text', 'photo', 'video'], async (ctx, next) => {
      const userId = ctx.from.id;
      const stage = userStages[userId];

      if (!stage) return next();

      // 1. Ожидание контента поста
      if (stage.step === 'BC_WAIT_MSG') {
         stage.broadcastMsg = ctx.message;
         stage.step = 'BC_WAIT_URL';
         return ctx.reply('Нужна кнопка-ссылка? Пришлите URL (например, https://google.com) или напишите /skip');
      }

      // 2. Ожидание ссылки
      if (stage.step === 'BC_WAIT_URL') {
         if (ctx.message?.text && ctx.message.text !== '/skip') {
            stage.broadcastUrl = ctx.message.text;
         }
         stage.step = 'BC_CONFIRM';

         await ctx.reply('📢 ПРЕВЬЮ ПОСТА:');
         const extra = stage.broadcastUrl ? Markup.inlineKeyboard([[Markup.button.url('Узнать больше', stage.broadcastUrl)]]) : {};
         await ctx.telegram.copyMessage(userId, userId, stage.broadcastMsg.message_id, extra);

         return ctx.reply('Все верно? Запускаем?', Markup.inlineKeyboard([
            [Markup.button.callback('🚀 ДА, ЗАПУСКАЙ!', 'BC_SEND')],
            [Markup.button.callback('❌ ОТМЕНА', 'BC_CANCEL')]
         ]));
      }

      // Защита от мусора во время опроса
      if (stage.step !== 'IDLE' && !ctx.message.text) {
         return ctx.reply(`Хмм, ${stage.name || 'друг'}, я понимаю только текст. Пожалуйста, напиши ответ словами.`);
      }

      return next();
   });

   bot.action('BC_SEND', async (ctx) => {
      if (ctx.from.id.toString() !== ADMIN_ID) return;
      const stage = userStages[ctx.from.id];
      const users = await db.all('SELECT tg_id FROM leads');

      await ctx.editMessageText(`🚀 Рассылка пошла (${users.length} чел.)...`);

      let success = 0;
      let failed = 0;

      for (const user of users) {
         try {
            const extra = stage.broadcastUrl ? Markup.inlineKeyboard([[Markup.button.url('Узнать больше', stage.broadcastUrl)]]) : {};
            await ctx.telegram.copyMessage(user.tg_id, ctx.from.id, stage.broadcastMsg.message_id, extra);
            success++;
            await new Promise(res => setTimeout(res, 35));
         } catch (e) {
            failed++;
         }
      }

      stage.step = 'IDLE';
      stage.broadcastUrl = null;
      await ctx.reply(`✅ Рассылка завершена!\n\nДоставлено: ${success}\nОшибок: ${failed}`);
   });

   bot.action('BC_CANCEL', async (ctx) => {
      userStages[ctx.from.id].step = 'IDLE';
      await ctx.answerCbQuery();
      await ctx.reply('Действие отменено.');
   });

   // --- ЛОГИКА ОПРОСА ЮЗЕРА ---
   bot.action('START_QUIZ', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
         `🤝 <b>Небольшая формальность</b>\n\nЧтобы я мог отправить тебе файл, мне нужно твоё добро на обработку данных. Обещаю, никакого спама, всё строго по делу.`,
         {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
               [Markup.button.callback('✅ Погнали!', 'AGREE_DATA')],
               [Markup.button.callback('❌ Не в этот раз', 'BC_CANCEL')]
            ])
         }
      );
   });

   bot.action('AGREE_DATA', async (ctx) => {
      const userId = ctx.from.id;
      const now = new Date().toLocaleString('ru-RU');
      await db.run('UPDATE leads SET agreed_at = ? WHERE tg_id = ?', [now, userId]);
      userStages[userId].step = 'WAIT_NAME';
      await ctx.answerCbQuery();
      await ctx.editMessageText('Отлично! Давай знакомиться. Как мне к тебе обращаться?');
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
         return ctx.reply(`Приятно познакомиться, ${input}! Напиши свой номер телефона:`);
      }

      if (stage.step === 'WAIT_PHONE') {
         const cleanPhone = input.replace(/\D/g, '');
         if (cleanPhone.length < 10 || cleanPhone.length > 15) {
            return ctx.reply(`Ой, ${stage.name}, кажется в номере ошибка. Проверь цифры.\nНапример: +7 999 000-00-00`);
         }
         await db.run('UPDATE leads SET phone = ? WHERE tg_id = ?', [input, userId]);
         stage.step = 'WAIT_EMAIL';
         return ctx.reply(`${stage.name}, и последнее — твой Email:`);
      }

      if (stage.step === 'WAIT_EMAIL') {
         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
         if (!emailRegex.test(input)) {
            return ctx.reply(`Хмм, ${stage.name}, проверь почту (нужна @ и точка).\nНапример: example@mail.ru`);
         }
         await db.run('UPDATE leads SET email = ? WHERE tg_id = ?', [input, userId]);
         await ctx.reply(`Спасибо, ${stage.name}! Твой гайд уже летит к тебе...`);

         await uploadToYandexDisk(db);
         if (fs.existsSync('./files/guide.pdf')) {
            await ctx.replyWithDocument({ source: './files/guide.pdf' });
         }
         logger.info(`🎯 Новый лид: ${stage.name} (${userId})`);
         stage.step = 'IDLE';
      }
   });

   bot.launch();
}

startApp().catch(err => logger.error('Критическая ошибка запуска: ' + err.message));