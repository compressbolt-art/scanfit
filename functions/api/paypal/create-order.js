import { calculatePayPalPrice, getPayPalAccessToken, getPayPalBase, json } from '../../_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    const payload = await request.json().catch(() => ({}));
    const price = calculatePayPalPrice(payload);
    const token = await getPayPalAccessToken(env);
    const response = await fetch(`${getPayPalBase(env)}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `scanfit-${Date.now()}-${crypto.randomUUID()}`
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: price.currency, value: price.total },
          description: `ScanFit ${payload.plan === 'annual' ? 'Annual' : 'Monthly'} plan`
        }]
      })
    });
    const data = await response.json();
    return json(data, response.ok ? 200 : response.status);
  } catch (error) {
    return json({ error: error.message || 'PayPal order failed' }, 500);
  }
}
