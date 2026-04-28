# TGS Backend

Backend para TGS Studio Extension - Auth & Payments

## Variables de entorno en Vercel

Ve a tu proyecto en Vercel → Settings → Environment Variables y agrega:

| Variable | Valor |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | `8311269512:AAGUCqqXrCj8sMAis-NZrM4HlGMvFE03Odc` |
| `ADMIN_TELEGRAM_ID` | Tu ID de Telegram (búscalo en @userinfobot) |
| `SETUP_SECRET` | Una contraseña que tú elijas (ej: `tgs2026`) |
| `KV_REST_API_URL` | (opcional) URL de Vercel KV |
| `KV_REST_API_TOKEN` | (opcional) Token de Vercel KV |

## Endpoints

- `GET /api/check-premium?uid=UID` - Verifica si usuario tiene premium
- `POST /api/create-payment` - Crea orden de pago
- `POST /api/confirm-payment` - Usuario confirma que pagó
- `POST /api/telegram-webhook` - Webhook del bot
- `GET /api/setup-webhook?secret=TU_SECRET` - Registra webhook (una vez)

## Flujo de pago

1. Usuario abre Topaz en la extensión
2. Click "Obtener Premium" → se llama `/api/create-payment`
3. Se abre PayPal con el monto exacto
4. Usuario paga y click "Ya pagué"
5. Se llama `/api/confirm-payment`
6. Tú recibes notificación en Telegram
7. Verificas en PayPal y mandas `/activate UID` al bot
8. Usuario recibe mensaje de activación
