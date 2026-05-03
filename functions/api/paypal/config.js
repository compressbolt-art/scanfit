import { json } from '../../_shared.js';

export function onRequestGet({ env }) {
  if (!env.PAYPAL_CLIENT_ID) {
    return json({ error: 'PAYPAL_CLIENT_ID is not set' }, 503);
  }
  return json({ clientId: env.PAYPAL_CLIENT_ID, env: env.PAYPAL_ENV || 'sandbox' });
}
