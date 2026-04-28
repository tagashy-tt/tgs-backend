/**
 * POST /api/telegram-webhook
 * Handles Telegram bot commands
 * 
 * Commands:
 * /activate UID - Activate premium for 30 days
 * /deactivate UID - Remove premium
 * /status UID - Check user status
 * /list - List all premium users
 */
const db = require('../lib/db');
const { setCors, handleOptions } = require('../lib/cors');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

async function notifyUser(uid, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: uid, text, parse_mode: 'Markdown' })
    });
  } catch (e) {
    // User may have blocked the bot
  }
}

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== 'POST') return res.status(405).end();

  const update = req.body;
  const msg = update.message;
  if (!msg || !msg.text) return res.status(200).end();

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase();
  const arg = parts[1];

  // Only admin can use these commands
  if (chatId !== String(ADMIN_ID)) {
    // Non-admin gets start message
    if (cmd === '/start') {
      await sendMessage(chatId, `👋 Bienvenido a *TGS Studio Bot*\n\nPara activar Topaz Premium, abre la extensión y sigue las instrucciones de pago.`);
    }
    return res.status(200).end();
  }

  try {
    switch (cmd) {
      case '/activate': {
        if (!arg) return await sendMessage(chatId, '❌ Uso: /activate UID');
        const uid = arg.trim();
        const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 días
        await db.set(`sub:${uid}`, {
          uid,
          plan: 'monthly',
          expiry,
          activated_at: Date.now(),
          activated_by: chatId
        });
        await sendMessage(chatId, `✅ *Premium activado*\n\nUID: \`${uid}\`\nExpira: ${new Date(expiry).toLocaleDateString()}`);
        await notifyUser(uid, `🎉 *¡Tu Topaz Premium está activo!*\n\nYa puedes usar todas las funciones de TGS Topaz.\nExpira el: ${new Date(expiry).toLocaleDateString()}\n\nAbre la extensión y disfruta.`);
        break;
      }

      case '/deactivate': {
        if (!arg) return await sendMessage(chatId, '❌ Uso: /deactivate UID');
        await db.del(`sub:${arg.trim()}`);
        await sendMessage(chatId, `✅ Premium eliminado para UID: \`${arg}\``);
        break;
      }

      case '/status': {
        if (!arg) return await sendMessage(chatId, '❌ Uso: /status UID');
        const sub = await db.get(`sub:${arg.trim()}`);
        if (!sub) return await sendMessage(chatId, `❌ UID \`${arg}\` no tiene premium.`);
        const expired = sub.expiry < Date.now();
        await sendMessage(chatId,
          `📊 *Estado de UID:* \`${arg}\`\n` +
          `Estado: ${expired ? '❌ Expirado' : '✅ Activo'}\n` +
          `Expira: ${new Date(sub.expiry).toLocaleDateString()}`
        );
        break;
      }

      case '/help': {
        await sendMessage(chatId,
          `*Comandos disponibles:*\n\n` +
          `/activate UID - Activar premium 30 días\n` +
          `/deactivate UID - Eliminar premium\n` +
          `/status UID - Ver estado\n` +
          `/help - Esta ayuda`
        );
        break;
      }

      default:
        await sendMessage(chatId, `Comando no reconocido. Usa /help`);
    }
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${e.message}`);
  }

  return res.status(200).end();
};
