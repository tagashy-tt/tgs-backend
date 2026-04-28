/**
 * POST /api/create-payment
 * Body: { uid, name, phone }
 * Returns { payment_url, order_id }
 * 
 * Crea una orden pendiente y genera el link de PayPal.me
 */
const db = require('../lib/db');
const { setCors, handleOptions } = require('../lib/cors');

const PRICE = '5.99';
const CURRENCY = 'USD';
const PAYPAL_ME = 'https://www.paypal.me/tagashytt';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, name, phone } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  try {
    // Create pending order
    const orderId = `TGS-${uid}-${Date.now()}`;
    await db.set(`order:${orderId}`, {
      uid,
      name: name || 'Unknown',
      phone: phone || '',
      status: 'pending',
      amount: PRICE,
      created: Date.now()
    }, 86400); // expires in 24h

    // Save pending order reference for this user
    await db.set(`pending:${uid}`, orderId, 86400);

    // PayPal.me link with amount
    const paypalUrl = `${PAYPAL_ME}/${PRICE}${CURRENCY}`;

    // Notify you via Telegram
    if (BOT_TOKEN) {
      const msg = `💳 *Nuevo intento de pago*\n\n` +
        `👤 *Usuario:* ${name || 'Desconocido'}\n` +
        `📱 *Teléfono:* ${phone || 'No proporcionado'}\n` +
        `🆔 *UID:* ${uid}\n` +
        `🔖 *Orden:* \`${orderId}\`\n` +
        `💰 *Monto:* $${PRICE} USD\n\n` +
        `Para activar manualmente usa:\n` +
        `/activate ${uid}`;

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.ADMIN_TELEGRAM_ID,
          text: msg,
          parse_mode: 'Markdown'
        })
      });
    }

    return res.json({
      order_id: orderId,
      payment_url: paypalUrl,
      amount: PRICE,
      currency: CURRENCY
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
