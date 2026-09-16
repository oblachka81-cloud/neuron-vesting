// bot/index.cjs — NEURON Vesting bot + HTTP server (zero deps, long polling)
const http = require('http');
const TOKEN = (process.env.BOT_TOKEN || '').trim();
if (!TOKEN) { console.error('BOT_TOKEN is not set'); process.exit(1); }

const API = 'https://api.telegram.org/bot' + TOKEN;
const FACTORY = process.env.FACTORY_ADDRESS || 'kQAhTRlJwkdR2vYdXz-RowoEGum_ITUZZFj6gdKdSggfjnNh';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://github.com/oblachka81-cloud/neuron-vesting';
const PORT = parseInt(process.env.PORT || '3000', 10);

// ===== HTTP-сервер (для Bothost healthcheck и будущего мини-аппа) =====
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bot: 'NEURON Vesting', factory: FACTORY }));
    return;
  }
  res.writeHead(302, { Location: MINI_APP_URL });
  res.end();
});
server.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));

// ===== Telegram bot (long polling) =====
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
        text: 'NEURON Vesting — non-custodial локи токенов в TON.\n\nЗалокируй любой TEP-74 jetton с публичным on-chain доказательством. Testnet v1 работает.',
        reply_markup: menuKeyboard(),
      });
    } else {
      await call('sendMessage', { chat_id: chat, text: 'Отправь /start, чтобы открыть меню.' });
    }
  }
  if (update.callback_query) {
    const cq = update.callback_query;
    await call('answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.data === 'status') {
      await call('sendMessage', {
        chat_id: cq.message.chat.id,
        text: 'Фабрика (testnet):\n' + FACTORY + '\n\nExplorer:\nhttps://testnet.tonviewer.com/' + FACTORY,
      });
    }
  }
}

async function loop() {
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

call('deleteWebhook', {}).then(() => {
  console.log('NEURON Vesting bot is up (long polling + HTTP)');
  loop();
});
