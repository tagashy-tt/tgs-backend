/**
 * GET /api/setup-webhook?secret=TU_SECRET
 * Registra el webhook de Telegram una sola vez
 */
const { setCors } = require('../lib/cors');

module.exports = async (req, res) => {
  setCors(res);

  const { secret } = req.query;
  if (secret !== process.env.SETUP_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const VERCEL_URL = process.env.VERCEL_URL || req.headers.host;
  const webhookUrl = `https://${VERCEL_URL}/api/telegram-webhook`;

  const result = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    }
  );

  const data = await result.json();
  return res.json({ webhook_url: webhookUrl, telegram_response: data });
};
