import { json, normalizeEmail, sendVerificationEmail, signToken } from '../../_shared.js';

export async function onRequestPost({ request, env }) {
  const payload = await request.json().catch(() => ({}));
  const email = normalizeEmail(payload.email);
  const language = payload.language === 'en-US' ? 'en-US' : 'ko-KR';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'A valid email is required' }, 400);
  }

  if (!env.AUTH_SECRET) {
    return json({ ok: false, delivered: false, reason: 'Missing: AUTH_SECRET' }, 503);
  }

  const token = await signToken({
    type: 'login',
    email,
    language,
    exp: Date.now() + (15 * 60 * 1000)
  }, env.AUTH_SECRET);
  const verifyUrl = new URL('/auth/verify', request.url);
  verifyUrl.searchParams.set('token', token);
  verifyUrl.searchParams.set('lang', language);

  const delivery = await sendVerificationEmail({
    env,
    email,
    verifyUrl: verifyUrl.toString(),
    language
  });

  return json({
    ok: delivery.ok,
    delivered: delivery.ok,
    reason: delivery.reason || null,
    tokenExpiresInMinutes: 15
  }, delivery.ok ? 200 : 503);
}
