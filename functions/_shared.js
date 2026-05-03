const encoder = new TextEncoder();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  return header.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function base64Url(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signToken(payload, secret) {
  if (!secret) throw new Error('AUTH_SECRET is required');
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyToken(token, secret, expectedType) {
  if (!secret || !token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const key = await importKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(signature), encoder.encode(body));
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  if (expectedType && payload.type !== expectedType) return null;
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

export function emailConfig(env) {
  const from = env.RESEND_FROM || env.EMAIL_FROM || '';
  const missing = [];
  if (!env.AUTH_SECRET) missing.push('AUTH_SECRET');
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!from) missing.push('RESEND_FROM');
  return { from, missing };
}

export async function sendVerificationEmail({ env, email, verifyUrl, language }) {
  const config = emailConfig(env);
  if (config.missing.length) {
    return { ok: false, reason: `Missing: ${config.missing.join(', ')}` };
  }

  const isEnglish = language === 'en-US';
  const subject = isEnglish ? '[ScanFit] Verify your email' : '[ScanFit] 이메일 인증';
  const text = isEnglish
    ? `Confirm your ScanFit login by opening this link:\n\n${verifyUrl}\n\nThis link expires in 15 minutes.`
    : `ScanFit 로그인을 완료하려면 아래 링크를 여세요:\n\n${verifyUrl}\n\n이 링크는 15분 후 만료됩니다.`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: config.from,
      to: email,
      subject,
      text
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    return { ok: false, reason: detail || 'Email provider rejected the request' };
  }
  return { ok: true };
}

export function getPayPalBase(env) {
  return env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export async function getPayPalAccessToken(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
  }
  const credentials = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const response = await fetch(`${getPayPalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || 'PayPal auth failed');
  return data.access_token;
}

export function calculatePayPalPrice(payload) {
  const isAnnual = payload.plan === 'annual';
  const petCount = Math.max(1, Number(payload.petCount || 1));
  const currency = payload.currency === 'USD' ? 'USD' : 'KRW';
  const base = currency === 'USD' ? (isAnnual ? 210 : 21) : (isAnnual ? 290000 : 29000);
  const addon = petCount * (currency === 'USD' ? 1 : 1000);
  const totalKrwOrUsd = base + addon;
  const totalUsd = currency === 'USD' ? totalKrwOrUsd : Math.max(1, Math.round(totalKrwOrUsd / 1350));
  return { total: totalUsd.toFixed(2), currency: 'USD', displayCurrency: currency };
}
