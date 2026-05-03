import { getPayPalAccessToken, getPayPalBase, json } from '../../_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    const payload = await request.json().catch(() => ({}));
    const orderID = payload.orderID;
    if (!orderID) return json({ error: 'orderID is required' }, 400);
    const token = await getPayPalAccessToken(env);
    const response = await fetch(`${getPayPalBase(env)}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    return json(data, response.ok ? 200 : response.status);
  } catch (error) {
    return json({ error: error.message || 'PayPal capture failed' }, 500);
  }
}
