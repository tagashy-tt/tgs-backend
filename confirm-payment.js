/**
 * POST /api/confirm-payment
 * Body: { uid, order_id, phone }
 * 
 * El usuario confirma que pagó. Se notifica al admin via Telegram
 * para verificación manual. El admin activa con /activate UID.
 */
const db = require('../lib/db');
const { setCors, handleOptions } = require('../lib/cors');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, order_id, phone } = req.body;
  if (!uid || !order_id) return res.status(400).json({ error: 'uid and order_id required' });

  try {
    const order = await db.get(`order:${order_id}`);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada o expirada' });
    if (order.uid !== uid) return res.status(403).json({ error: 'UID no coincide' });
    if (order.status === 'confirmed') return res.json({ status: 'waiting', message: 'Ya confirmaste, espera la activación' });

    // Mark as waiting confirmation
    order.status = 'waiting_confirmation';
    order.phone = phone || order.phone;
    order.confirmed_at = Date.now();
    await db.set(`order:${order_id}`, order, 86400 * 7);

    // Notify admin via Telegram
    if (BOT_TOKEN) {
      const msg = `✅ *Pago confirmado por usuario*\n\n` +
        `👤 *Usuario:* ${order.name}\n` +
        `📱 *Teléfono:* ${order.phone || 'No dado'}\n` +
        `🆔 *UID Telegram:* ${uid}\n` +
        `🔖 *Orden:* \`${order_id}\`\n` +
        `💰 *Monto:* $${order.amount} USD\n\n` +
        `⚡ *Verifica el pago en PayPal y activa:*\n` +
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
      status: 'waiting',
      message: 'Pago confirmado. Se activará en menos de 24 horas.'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
