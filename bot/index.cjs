// bot/index.cjs — NEURON Vesting bot + indexer + API (v4)
const http = require('http');
const TOKEN = (process.env.BOT_TOKEN || '').trim();
if (!TOKEN) { console.error('BOT_TOKEN is not set'); process.exit(1); }

const API = 'https://api.telegram.org/bot' + TOKEN;
const FACTORY = process.env.FACTORY_ADDRESS || 'kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://oblachka81-cloud.github.io/neuron-vesting/';
const PORT = parseInt(process.env.PORT || '3000', 10);

const db = require('./db');
const indexer = require('./indexer');
const api = require('./api');
const auth = require('./auth');

const server = http.createServer(async (req, res) => {
  // CORS: allow the Pages showcase to call our API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === '/health') {
    const stats = await db.getStats();
    const whitelist = await db.listWhitelist();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, bot: 'NEURON Vesting', factory: FACTORY,
      whitelist_count: whitelist.length,
      admin_login_enabled: !!process.env.ADMIN_PASSPHRASE,
      ...stats,
    }));
    return;
  }
  if (api.addRoutes(req, res)) return;
  res.writeHead(302, { Location: MINI_APP_URL });
  res.end();
});
server.listen(PORT, '0.0.0.0', () => console.log(`HTTP server on port ${PORT} (all interfaces)`));

let offset = 0;
async function call(method, params) {
  const res = await fetch(API + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const json = await res.json();
  if (!json.ok) console.error('TG API error:', method, json.description);
  return json;
}

function menuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Открыть NEURON Vesting', web_app: { url: MINI_APP_URL } }],
      [{ text: 'Статус фабрики', callback_data: 'status' }],
      [{ text: 'Мои локи', callback_data: 'locks' }],
      [{ text: 'Whitelist жетонов', callback_data: 'whitelist' }],
      [{ text: 'Подать заявку', callback_data: 'apply' }],
    ],
  };
}

async function handle(update) {
  if (update.message) {
    const chat = update.message.chat.id;
    const text = update.message.text || '';
    if (text.startsWith('/start')) {
      await call('sendMessage', {
        chat_id: chat,
        text: 'NEURON Vesting — non-custodial локи токенов в TON.\n\nЗалокируй любой одобренный TEP-74 jetton с публичным on-chain доказательством.',
        reply_markup: menuKeyboard(),
      });
    } else {
      await call('sendMessage', { chat_id: chat, text: 'Отправь /start, чтобы открыть меню.' });
    }
  }
  if (update.callback_query) {
    const cq = update.callback_query;
    await call('answerCallbackQuery', { callback_query_id: cq.id });
    const chat = cq.message.chat.id;
    if (cq.data === 'status') {
      await call('sendMessage', { chat_id: chat, text: 'Фабрика:\n' + FACTORY });
    } else if (cq.data === 'locks') {
      await call('sendMessage', { chat_id: chat, text: '🔧 Вкладка "My Locks" появится в веб-аппе!' });
    } else if (cq.data === 'whitelist') {
      const list = await db.listWhitelist();
      const text = list.length === 0
        ? 'Список одобренных жетонов пока пуст.'
        : list.map((j) => `• ${j.symbol || '?'} — ${j.name || j.jetton_master}`).join('\n');
      await call('sendMessage', { chat_id: chat, text: 'Whitelist:\n' + text });
    } else if (cq.data === 'apply') {
      await call('sendMessage', {
        chat_id: chat,
        text: 'Заявка на whitelist жетона:\n\nОтправь одним сообщением:\n`/apply EQ…master <название> <тикер>`\n\nНапример:\n`/apply EQDOjRZ5... COGNIQ "COGNIQ Token"`',
        parse_mode: 'Markdown',
      });
    }
  }
}

async function botLoop() {
  for (;;) {
    try {
      const json = await call('getUpdates', { offset, timeout: 25 });
      for (const u of json.result || []) {
        offset = u.update_id + 1;
        await handle(u);
      }
    } catch (e) {
      console.error('polling error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

db.migrate().then(() => {
  console.log('Database ready');
  indexer.loop();
  console.log('Indexer started');
  call('deleteWebhook', {}).then(() => {
    console.log('Bot started (long polling)');
    botLoop();
  });
  // cleanup expired sessions every hour
  setInterval(() => db.purgeExpiredSessions().catch(() => {}), 3600 * 1000);
}).catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await db.close();
  process.exit(0);
});
