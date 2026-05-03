import { signToken, verifyToken } from '../_shared.js';

function html(message, email, lang, ok) {
  const safeEmail = JSON.stringify(email || '');
  const safeVerified = JSON.stringify(Boolean(ok));
  return `<!doctype html><html lang="${lang === 'en-US' ? 'en' : 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ScanFit</title></head><body style="font-family:sans-serif;padding:32px"><h1>ScanFit</h1><p>${message}</p><script>try{localStorage.setItem('scanfit_auth_email', ${safeEmail});localStorage.setItem('scanfit_auth_verified', ${safeVerified});}catch(e){}${ok ? "setTimeout(function(){location.href='/'},1200);" : ''}</script></body></html>`;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const lang = url.searchParams.get('lang') === 'en-US' ? 'en-US' : 'ko-KR';
  const payload = await verifyToken(token, env.AUTH_SECRET, 'login');

  if (!payload?.email) {
    const message = lang === 'en-US'
      ? 'This login link is invalid or expired.'
      : '이 로그인 링크는 유효하지 않거나 만료되었습니다.';
    return new Response(html(message, '', lang, false), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const now = Date.now();
  const session = await signToken({
    type: 'session',
    email: payload.email,
    language: payload.language || lang,
    iat: now,
    exp: now + (30 * 24 * 60 * 60 * 1000)
  }, env.AUTH_SECRET);

  const message = lang === 'en-US'
    ? 'Your email has been verified. Returning to ScanFit.'
    : '이메일 인증이 완료되었습니다. ScanFit으로 돌아갑니다.';

  return new Response(html(message, payload.email, lang, true), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `scanfit_auth=${encodeURIComponent(session)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; Secure; SameSite=Lax`
    }
  });
}
