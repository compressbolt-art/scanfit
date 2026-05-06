const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const tls = require('tls');
const net = require('net');
const { generatePodiReply, buildPodiRealtimeInstructions } = require('./podi-chat-core');

const root = __dirname;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(path.join(root, '.env'));

const port = Number(process.env.PORT || 5173);
const model = process.env.OPENAI_MODEL || 'gpt-5.5';
const podiModel = process.env.OPENAI_PODI_MODEL || process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-1.5';
const imageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';
const paypalEnv = process.env.PAYPAL_ENV || 'sandbox';
const paypalBase = paypalEnv === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const formspreeEndpoint = process.env.FORMSPREE_ENDPOINT || 'https://formspree.io/f/mzdodrre';
const authSessionsPath = path.join(root, 'data', 'auth-sessions.json');

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 15_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (error) { reject(error); }
    });
  });
}

function extractJson(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonLine(filePath, value) {
  ensureDirectory(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function normalizeEmail(value) {
  return String(value || '').trim();
}

function resolveSmtpConfig() {
  const user = process.env.SMTP_USER || '';
  const provider = String(process.env.SMTP_PROVIDER || '').toLowerCase();
  const inferredProvider = provider || (user.includes('@gmail.com') ? 'gmail' : user.includes('@outlook.com') || user.includes('@hotmail.com') || user.includes('@live.com') ? 'outlook' : '');
  const host = process.env.SMTP_HOST
    || (inferredProvider === 'gmail' ? 'smtp.gmail.com' : inferredProvider === 'outlook' ? 'smtp.office365.com' : '');
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true'
    || Number(process.env.SMTP_PORT || (host === 'smtp.gmail.com' ? 465 : 587)) === 465;
  const port = Number(process.env.SMTP_PORT || (secure ? 465 : 587));
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || process.env.CONTACT_TO_EMAIL || '';
  const to = process.env.CONTACT_TO_EMAIL || '';
  const pass = process.env.SMTP_PASS || '';
  const missing = [];
  if (!host) missing.push('SMTP_HOST');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');
  if (!to) missing.push('CONTACT_TO_EMAIL');
  if (!from) missing.push('SMTP_FROM');
  return { host, port, secure, user, pass, from, to, provider: inferredProvider || null, missing };
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  return header.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadAuthStore() {
  return readJsonFile(authSessionsPath, { pending: [], sessions: [] });
}

function saveAuthStore(store) {
  ensureDirectory(authSessionsPath);
  fs.writeFileSync(authSessionsPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function pruneAuthStore(store) {
  const now = Date.now();
  store.pending = Array.isArray(store.pending) ? store.pending.filter(item => item && item.expiresAt > now) : [];
  store.sessions = Array.isArray(store.sessions) ? store.sessions.filter(item => item && item.expiresAt > now) : [];
  return store;
}

function createSmtpSession(socket) {
  const pending = [];
  const queue = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (pending.length) pending.shift()(line);
      else queue.push(line);
    }
  });
  socket.on('error', error => {
    while (pending.length) pending.shift()(error);
  });
  return {
    readLine() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => pending.push(value => (value instanceof Error ? reject(value) : resolve(value))));
    },
    async readResponse() {
      const lines = [];
      let code = null;
      while (true) {
        const line = await this.readLine();
        lines.push(line);
        const match = String(line || '').match(/^(\d{3})([- ])(.*)$/);
        if (match) {
          code = Number(match[1]);
          if (match[2] === ' ') break;
        } else if (lines.length === 1) {
          break;
        }
      }
      return { code, lines };
    },
    send(line) {
      socket.write(`${line}\r\n`);
    }
  };
}

async function sendEmailViaSmtp({ to, subject, text, from }) {
  const smtpConfig = resolveSmtpConfig();
  if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass || !to) {
    return { delivered: false, reason: `SMTP not configured: ${smtpConfig.missing.join(', ') || 'unknown'}` };
  }

  const socket = smtpConfig.secure
    ? tls.connect({ host: smtpConfig.host, port: smtpConfig.port, servername: smtpConfig.host, rejectUnauthorized: false })
    : net.createConnection({ host: smtpConfig.host, port: smtpConfig.port });

  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const smtp = createSmtpSession(socket);
  const banner = await smtp.readResponse();
  if (banner.code !== 220) throw new Error(`SMTP banner rejected: ${banner.lines.join(' | ')}`);

  smtp.send(`EHLO ${os.hostname() || 'scanfit.local'}`);
  const ehlo = await smtp.readResponse();
  if (ehlo.code !== 250) throw new Error(`SMTP EHLO failed: ${ehlo.lines.join(' | ')}`);

  smtp.send('AUTH LOGIN');
  const userPrompt = await smtp.readResponse();
  if (userPrompt.code !== 334) throw new Error(`SMTP AUTH username rejected: ${userPrompt.lines.join(' | ')}`);
  smtp.send(Buffer.from(smtpConfig.user, 'utf8').toString('base64'));
  const passPrompt = await smtp.readResponse();
  if (passPrompt.code !== 334) throw new Error(`SMTP AUTH password rejected: ${passPrompt.lines.join(' | ')}`);
  smtp.send(Buffer.from(smtpConfig.pass, 'utf8').toString('base64'));
  const authDone = await smtp.readResponse();
  if (authDone.code !== 235) throw new Error(`SMTP auth failed: ${authDone.lines.join(' | ')}`);

  smtp.send(`MAIL FROM:<${from || smtpConfig.from}>`);
  const mailFrom = await smtp.readResponse();
  if (mailFrom.code !== 250) throw new Error(`SMTP MAIL FROM failed: ${mailFrom.lines.join(' | ')}`);

  smtp.send(`RCPT TO:<${to}>`);
  const rcptTo = await smtp.readResponse();
  if (rcptTo.code !== 250 && rcptTo.code !== 251) throw new Error(`SMTP RCPT TO failed: ${rcptTo.lines.join(' | ')}`);

  smtp.send('DATA');
  const dataReady = await smtp.readResponse();
  if (dataReady.code !== 354) throw new Error(`SMTP DATA failed: ${dataReady.lines.join(' | ')}`);

  const lines = [
    `From: ScanFit <${from || smtpConfig.from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text.replace(/\n\./g, '\n..'),
    '.'
  ];
  lines.forEach(line => smtp.send(line));

  const sendDone = await smtp.readResponse();
  if (sendDone.code !== 250) throw new Error(`SMTP send failed: ${sendDone.lines.join(' | ')}`);
  smtp.send('QUIT');
  socket.end();

  return { delivered: true, to };
}

async function sendSupportInquiryEmail({ name, email, message, language, page }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || process.env.CONTACT_TO_EMAIL || '';
  const to = process.env.CONTACT_TO_EMAIL || '';
  const subject = `[ScanFit] Support inquiry from ${name}`;
  const body = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Language: ${language}`,
    `Page: ${page || 'unknown'}`,
    '',
    message
  ].join('\n');
  return sendEmailViaSmtp({ to, subject, text: body, from });
}

async function sendLoginVerificationEmail({ email, token, language }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || process.env.CONTACT_TO_EMAIL || '';
  const verifyUrl = new URL('/auth/verify', 'http://localhost:5173');
  verifyUrl.searchParams.set('token', token);
  verifyUrl.searchParams.set('email', email);
  verifyUrl.searchParams.set('lang', language);
  const isEnglish = language === 'en-US';
  const subject = isEnglish ? '[ScanFit] Verify your email' : '[ScanFit] 이메일 인증';
  const text = isEnglish
    ? [
        'Confirm your ScanFit login by opening the link below:',
        verifyUrl.toString(),
        '',
        'This link expires in 15 minutes.'
      ].join('\n')
    : [
        'ScanFit 로그인을 완료하려면 아래 링크를 여세요:',
        verifyUrl.toString(),
        '',
        '이 링크는 15분 후 만료됩니다.'
      ].join('\n');
  return sendEmailViaSmtp({ to: email, subject, text, from });
}

function getAuthSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies.scanfit_auth || '';
  if (!token) return null;
  const store = pruneAuthStore(loadAuthStore());
  return store.sessions.find(item => item.token === token && item.verifiedAt) || null;
}

async function requestLoginEmail(req, res) {
  const payload = await readJson(req);
  const email = normalizeEmail(payload.email);
  const language = payload.language === 'en-US' ? 'en-US' : 'ko-KR';
  const page = String(payload.page || '/');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return send(res, 400, JSON.stringify({ error: 'A valid email is required' }));
  }

  const token = crypto.randomBytes(24).toString('hex');
  const store = pruneAuthStore(loadAuthStore());
  store.pending = Array.isArray(store.pending) ? store.pending : [];
  store.pending.push({
    token,
    email,
    language,
    page,
    createdAt: Date.now(),
    expiresAt: Date.now() + (15 * 60 * 1000)
  });
  saveAuthStore(store);

  const delivery = await sendLoginVerificationEmail({ email, token, language });
  return send(res, delivery.delivered ? 200 : 503, JSON.stringify({
    ok: delivery.delivered,
    delivered: delivery.delivered,
    reason: delivery.reason || null,
    tokenExpiresInMinutes: 15
  }));
}

function verifyLoginToken(req, res, url) {
  const token = url.searchParams.get('token') || '';
  const email = normalizeEmail(url.searchParams.get('email'));
  const lang = url.searchParams.get('lang') === 'en-US' ? 'en-US' : 'ko-KR';
  const store = pruneAuthStore(loadAuthStore());
  const pendingIndex = (store.pending || []).findIndex(item => item.token === token && item.email === email);

  if (pendingIndex === -1) {
    const message = lang === 'en-US'
      ? 'This login link is invalid or expired.'
      : '이 로그인 링크는 유효하지 않거나 만료되었습니다.';
    return send(res, 400, `<!doctype html><html lang="${lang === 'en-US' ? 'en' : 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ScanFit</title></head><body style="font-family:sans-serif;padding:32px"><h1>ScanFit</h1><p>${message}</p></body></html>`, 'text/html; charset=utf-8');
  }

  const pending = store.pending[pendingIndex];
  store.pending.splice(pendingIndex, 1);
  store.sessions = Array.isArray(store.sessions) ? store.sessions.filter(item => item.email !== email) : [];
  store.sessions.push({
    token,
    email,
    language: pending.language || lang,
    verifiedAt: Date.now(),
    expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000)
  });
  saveAuthStore(store);

  const cookie = `scanfit_auth=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`;
  const text = lang === 'en-US'
    ? 'Your email has been verified. Return to ScanFit and continue.'
    : '이메일 인증이 완료되었습니다. ScanFit으로 돌아가서 계속 이용하세요.';
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': cookie
  });
  res.end(`<!doctype html><html lang="${lang === 'en-US' ? 'en' : 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ScanFit</title></head><body style="font-family:sans-serif;padding:32px"><h1>ScanFit</h1><p>${text}</p><script>try{localStorage.setItem('scanfit_auth_email', ${JSON.stringify(email)});localStorage.setItem('scanfit_auth_verified','true');}catch(e){}setTimeout(function(){location.href='/'},1200);</script></body></html>`);
}

function authStatus(req, res) {
  const session = getAuthSessionFromRequest(req);
  send(res, 200, JSON.stringify({
    authenticated: Boolean(session),
    email: session?.email || null,
    verifiedAt: session?.verifiedAt || null,
    expiresAt: session?.expiresAt || null
  }));
}

function logoutAuth(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.scanfit_auth || '';
  if (token) {
    const store = pruneAuthStore(loadAuthStore());
    store.sessions = Array.isArray(store.sessions) ? store.sessions.filter(item => item.token !== token) : [];
    saveAuthStore(store);
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': 'scanfit_auth=; Path=/; Max-Age=0; SameSite=Lax'
  });
  res.end(JSON.stringify({ ok: true }));
}

async function analyzeFood(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return send(res, 503, JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
  }

  const { image, profile = {}, analysisMode = 'high' } = await readJson(req);
  if (!image || !image.startsWith('data:image/')) {
    return send(res, 400, JSON.stringify({ error: 'image data URL is required' }));
  }

  const lang = profile.language === 'en-US' ? 'English' : 'Korean';
  const prompt = `You are ScanFit's highest-accuracy pet nutrition analyst.
Analyze this pet food label image for a ${profile.petType || 'pet'}, breed ${profile.breed || 'unknown'}, weight ${profile.weight || 'unknown'}kg.
Priority order:
1) Read visible label text exactly.
2) Extract guaranteed analysis and kcal/kg if visible.
3) Separate visible evidence from inference.
4) Never guess a number unless it is clearly inferable from the image and the report must say it is inferred.
5) Keep the result conservative and practical.
Write all human-readable fields in ${lang}.
Return only valid JSON with:
{
  "caloriesPerKg": number,
  "proteinPct": number,
  "fatPct": number,
  "carbPct": number,
  "confidence": number from 0 to 1,
  "petCount": number,
  "petCountConfidence": number from 0 to 1,
  "petCountNote": "brief note on whether one or multiple pets were visible and whether the count is inferred",
  "summary": "concise report summary grounded in visible label text and explicit inference notes",
  "cautions": ["caution 1", "caution 2"],
  "evidence": [
    {"label":"visible label text or inferred field", "value":"observed/inferred value", "reason":"why it matters and whether it was visible or inferred"}
  ],
  "feedingFormula": {
    "rer":"30 x body weight kg + 70",
    "multiplier": number,
    "dailyKcal": number,
    "gramsFormula":"dailyKcal / caloriesPerKg x 1000"
  },
  "rawLabelLines": ["exact visible text line 1", "exact visible text line 2"],
  "guaranteedAnalysis": {
    "protein":"visible value or inferred",
    "fat":"visible value or inferred",
    "fiber":"visible value or inferred",
    "moisture":"visible value or inferred",
    "calories":"visible value or inferred"
  }
}
Rules:
- rawLabelLines must contain exact visible text when readable. If text is unreadable, write "Unreadable / inferred" and explain in evidence.
- Do not paraphrase visible label text in rawLabelLines.
- Distinguish visible values from inferred values in evidence.reason.
- Mark inferred items explicitly with the word "inferred" or the equivalent in ${lang}.
- If a value is not visible, infer conservatively and say so in summary.
- If the label is low quality or cropped, lower confidence instead of inventing values.
- Prefer fewer high-confidence facts over many uncertain facts.
- If multiple pets are visible, count them conservatively, set petCount and petCountConfidence, and explain whether the count is exact or inferred.
- Do not provide medical diagnosis.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
      body: JSON.stringify({
        model,
        temperature: 0,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: image }
        ]
      }]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    return send(res, response.status, JSON.stringify({ error: 'OpenAI request failed', detail: raw }));
  }

  const data = JSON.parse(raw);
  const text = data.output_text || data.output?.flatMap(item => item.content || []).map(item => item.text || '').join('\n') || '';
  const result = extractJson(text);
  send(res, 200, JSON.stringify(result));
}

async function generateReportImage(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return send(res, 503, JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
  }

  const { type, payload = {} } = await readJson(req);
  const english = payload.language === 'en-US';
  const prompt = type === 'exercise'
    ? `Create a premium ScanFit exercise prescription report image.
Style: production-ready UI slide, crisp text, dark 3D activity load map, joint-load infographic, weekly exercise plan cards, blue and emerald clinical palette.
Include the labels "${english ? 'AI Exercise Plan' : '운동처방'}", "${english ? 'Joint load' : '관절 부담'} ${payload.jointLoad || ''}", "${english ? 'Weekly burn target' : '주간 소모 목표'} ${payload.weeklyBurn || ''}", and "${english ? '7-day exercise plan' : '7일 운동처방표'}".
No fake medical diagnosis. 16:9 dashboard composition.`
    : `Create a premium ScanFit food analysis report image.
Style: production-ready UI slide, crisp text, dark 3D nutrition core, clean infographic cards, green and blue clinical palette.
Include the labels "${english ? 'AI Food Analysis' : '사료분석'}", "${english ? 'Recommended portion' : '권장 급여량'} ${payload.grams || ''}", "${english ? 'Protein' : '단백질'} ${payload.proteinPct || ''}%", "${english ? 'Fat' : '지방'} ${payload.fatPct || ''}%", and "${english ? '7-day meal plan' : '7일 식단표'}".
No logos other than ScanFit text. No fake medical diagnosis. 16:9 dashboard composition.`;

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: imageModel,
      prompt,
      size: '1536x864',
      quality: 'high',
      n: 1
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    return send(res, response.status, JSON.stringify({ error: 'Image generation failed', detail: raw, model: imageModel }));
  }

  const data = JSON.parse(raw);
  const first = data.data?.[0] || {};
  const image = first.b64_json ? `data:image/png;base64,${first.b64_json}` : first.url;
  if (!image) return send(res, 500, JSON.stringify({ error: 'No image returned', model: imageModel }));
  send(res, 200, JSON.stringify({ image, model: imageModel }));
}

function buildPodiChatPayload({ message = '', language = 'ko-KR', category = 'food', history = [] }) {
  const cleanMessage = String(message || '').trim();
  const en = language === 'en-US';
  const categoryKey = String(category || 'food');
  const categoryLabel = en
    ? ({ food: 'food analysis', exercise: 'exercise prescription', billing: 'billing', accuracy: 'analysis errors', refund: 'refunds', paymentHelp: 'payment errors' }[categoryKey] || 'food analysis')
    : ({ food: '사료분석', exercise: '운동처방', billing: '결제', accuracy: '분석 오류', refund: '환불', paymentHelp: '결제 오류' }[categoryKey] || '사료분석');
  const fallbackReply = en
    ? `Podi is online. Ask me about ${categoryLabel}, and I will answer in English.`
    : `뽀디 상담을 사용할 수 있습니다. ${categoryLabel} 질문을 해주세요.`;
  const system = en
    ? `You are Podi, ScanFit's 24-hour AI pet care assistant.
Answer in English.
Be concise and practical.
Do not provide medical diagnosis.
If the user asks about food analysis, feeding, exercise prescription, or billing, answer in a product-support tone.
If the user asks about unsupported topics, politely redirect them back to ScanFit features.
If the user asks about multiple pets, remind them to upload each pet separately for accuracy.`
    : `당신은 ScanFit의 24시간 AI 반려동물 상담사 뽀디입니다.
한국어로 답하세요.
간결하고 실용적으로 답하세요.
의료 진단은 제공하지 마세요.
사료분석, 급여, 운동처방, 결제 질문에는 제품 지원 상담 톤으로 답하세요.
지원하지 않는 주제는 ScanFit 기능으로 자연스럽게 다시 안내하세요.
한 장에 여러 반려동물이 보이면 정확도를 위해 각각 따로 업로드하라고 안내하세요.`;
  const troubleshooting = en
    ? `Special guidance:
- If the analysis table looks wrong, explain likely causes first: blurry image, cropped label, wrong pet type, wrong breed, low confidence, or multi-pet photo.
- Tell the user to reshoot the full label, choose the correct pet type, and if the breed is missing, type it manually instead of forcing a bad match.
- If the issue is a refund, explain that the app itself does not auto-refund; the correct path is to check the charge status, keep the order ID, and contact ScanFit support or PayPal resolution depending on how the payment was made.
- If payment fails, explain the concrete checks: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, sandbox vs live mismatch, USD requirement for PayPal, browser blocking, and network errors.
- Never claim a refund was processed unless the system actually has a refund API and the user has completed the required support step.`
    : `추가 안내:
- 분석표가 틀려 보이면 먼저 가능한 원인을 설명하세요: 흐림, 잘림, 잘못된 반려동물 종류, 잘못된 품종 선택, 낮은 신뢰도, 여러 반려동물이 함께 나온 사진.
- 사용자가 다시 촬영할 때는 라벨 전체가 보이게 찍고, 반려동물 종류를 정확히 선택하고, 품종이 없으면 억지로 고르지 말고 직접 입력하라고 안내하세요.
- 환불은 앱이 자동 처리하지 않는다고 분명히 말하고, 결제 상태 확인과 주문번호 보관, ScanFit 지원 또는 PayPal 분쟁/환불 절차로 안내하세요.
- 결제가 실패하면 구체적으로 확인할 항목을 말하세요: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, sandbox/live 불일치, PayPal의 USD 요구, 브라우저 차단, 네트워크 오류.
- 실제 환불 API가 없으면 환불이 완료됐다고 말하지 마세요.`;

  const safeHistory = Array.isArray(history) ? history.slice(-8).map(item => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.content || '').trim()
  })).filter(item => item.content) : [];

  return { cleanMessage, en, fallbackReply, system, safeHistory, categoryKey };
}

function buildLocalPodiReply({ en, categoryKey, cleanMessage }) {
  const msg = cleanMessage.toLowerCase();
  if (categoryKey === 'accuracy') {
    return en
      ? 'If the analysis table looks wrong, the usual causes are blur, cropping, the wrong pet type, the wrong breed, low confidence, or a multi-pet photo. Reshoot the full label, pick the correct pet type, and type the breed manually if it is missing.'
      : '분석표가 틀려 보이면 보통 흐림, 잘림, 잘못된 반려동물 종류, 잘못된 품종, 낮은 신뢰도, 여러 반려동물 사진이 원인입니다. 라벨 전체를 다시 찍고, 반려동물 종류를 정확히 선택하고, 품종이 없으면 직접 입력하세요.';
  }
  if (categoryKey === 'refund') {
    return en
      ? 'Refunds are not auto-processed in the app. Check the charge status, keep the order ID, and contact ScanFit support or PayPal resolution depending on how you paid.'
      : '환불은 앱에서 자동 처리되지 않습니다. 결제 상태를 확인하고 주문번호를 보관한 뒤, 결제 방식에 따라 ScanFit 지원 또는 PayPal 분쟁/환불 절차로 진행해야 합니다.';
  }
  if (categoryKey === 'paymentHelp') {
    return en
      ? 'If payment fails, check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, sandbox/live mismatch, USD currency for PayPal, browser script blocking, and network access. Demo checkout should still work.'
      : '결제가 실패하면 PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, sandbox/live 불일치, PayPal의 USD 통화 요구, 브라우저 스크립트 차단, 네트워크 연결을 확인하세요. 데모 결제는 계속 동작해야 합니다.';
  }
  if (categoryKey === 'exercise') {
    return en
      ? 'Exercise prescription is based on pet type, age, neuter status, joint condition, activity level, and the latest food analysis. If the result looks odd, verify those inputs first.'
      : '운동처방은 반려동물 종류, 나이, 중성화, 관절 상태, 활동량, 최신 사료분석을 기준으로 생성됩니다. 결과가 이상하면 먼저 입력값을 확인하세요.';
  }
  if (categoryKey === 'billing') {
    return en
      ? 'Pricing is per pet, and the first free attempt is limited by step. If the checkout does not open, it is usually because the free use was already consumed or PayPal config is missing.'
      : '요금은 마리당 부과되고, 각 스텝은 1회 무료로 제한됩니다. 결제창이 안 열리면 무료 횟수 소진이나 PayPal 설정 누락이 원인인 경우가 많습니다.';
  }
  if (categoryKey === 'food') {
    return en
      ? 'Food analysis reads the visible label, then builds the feeding amount and weekly meal plan. If breed is missing, type it manually instead of forcing a wrong match.'
      : '사료분석은 보이는 라벨을 읽고 급여량과 1주 식단표를 만듭니다. 품종이 없으면 억지로 고르지 말고 직접 입력하세요.';
  }
  return en
    ? `You asked about: ${cleanMessage}. Please give me one clear question about food analysis, exercise prescription, billing, refunds, or payment issues.`
    : `질문하신 내용은: ${cleanMessage}. 사료분석, 운동처방, 결제, 환불, 결제 오류 중 하나로 한 번 더 정확히 말씀해 주세요.`;
}

async function podiChat(req, res) {
  const payload = await readJson(req);
  const { cleanMessage, en, categoryKey } = buildPodiChatPayload(payload);
  if (!cleanMessage) {
    return send(res, 400, JSON.stringify({ error: 'message is required' }));
  }
  const reply = await generatePodiReply({
    message: cleanMessage,
    language: payload.language || 'ko-KR',
    category: categoryKey,
    history: Array.isArray(payload.history) ? payload.history : [],
    model: podiModel
  });
  send(res, 200, JSON.stringify({ reply: reply.reply, language: payload.language || 'ko-KR', source: reply.source, category: reply.category }));
}

async function podiChatStream(req, res) {
  const payload = await readJson(req);
  const { cleanMessage, en, categoryKey } = buildPodiChatPayload(payload);
  if (!cleanMessage) {
    return send(res, 400, JSON.stringify({ error: 'message is required' }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });

  const reply = await generatePodiReply({
    message: cleanMessage,
    language: payload.language || 'ko-KR',
    category: categoryKey,
    history: Array.isArray(payload.history) ? payload.history : [],
    model: podiModel
  });

  const text = reply.reply || (en ? 'I am online, but I could not generate a response right now.' : '지금은 답변을 생성하지 못했습니다.');
  for (const chunk of String(text).split(/(\s+)/)) {
    if (!res.writableEnded) res.write(chunk);
    await new Promise(resolve => setTimeout(resolve, 8));
  }
  if (!res.writableEnded) res.end();
}

async function podiContact(req, res) {
  const payload = await readJson(req);
  const name = String(payload.name || '').trim();
  const email = normalizeEmail(payload.email);
  const message = String(payload.message || '').trim();
  const language = payload.language === 'en-US' ? 'en-US' : 'ko-KR';
  const page = String(payload.page || '').trim();

  if (!name || !email || !message) {
    return send(res, 400, JSON.stringify({ error: 'name, email, and message are required' }));
  }

  const record = {
    id: `podi-${Date.now()}`,
    createdAt: new Date().toISOString(),
    name,
    email,
    message,
    language,
    page,
    userAgent: String(req.headers['user-agent'] || ''),
    delivered: false
  };

  appendJsonLine(path.join(root, 'data', 'podi-support-inquiries.jsonl'), record);

  try {
    const delivery = await sendSupportInquiryEmail({ name, email, message, language, page });
    record.delivered = !!delivery.delivered;
    record.deliveryInfo = delivery.delivered ? { to: delivery.to } : { reason: delivery.reason || 'SMTP not configured' };
    appendJsonLine(path.join(root, 'data', 'podi-support-deliveries.jsonl'), record);
    return send(res, 200, JSON.stringify({ ok: true, delivered: !!delivery.delivered, to: delivery.to || null, saved: true, reason: delivery.reason || null }));
  } catch (error) {
    record.deliveryError = error.message;
    appendJsonLine(path.join(root, 'data', 'podi-support-errors.jsonl'), record);
    return send(res, 500, JSON.stringify({ error: error.message, saved: true, delivered: false }));
  }
}

async function podiRealtimeToken(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return send(res, 503, JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
  }
  const payload = await readJson(req);
  const language = payload.language === 'en-US' ? 'en-US' : 'ko-KR';
  const category = String(payload.category || 'food');
  const instructions = buildPodiRealtimeInstructions({ language, category });

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model: podiModel,
        instructions
      }
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    return send(res, response.status, JSON.stringify({ error: 'OpenAI client secret request failed', detail: raw }));
  }

  const data = JSON.parse(raw);
  send(res, 200, JSON.stringify({
    value: data.value,
    expires_at: data.expires_at,
    session: data.session,
    model: podiModel
  }));
}

async function emailDiagnostics(req, res) {
  const smtp = resolveSmtpConfig();
  send(res, 200, JSON.stringify({
    provider: smtp.provider,
    host: smtp.host || null,
    port: smtp.port,
    secure: smtp.secure,
    from: smtp.from || null,
    to: smtp.to || null,
    missing: smtp.missing
  }));
}

function mcpResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function mcpError(id, code, message, data = undefined) {
  const error = { code, message };
  if (typeof data !== 'undefined') error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

async function podiMcp(req, res) {
  const body = await readJson(req);
  const method = body.method;
  const id = body.id ?? null;
  const params = body.params || {};

  if (method === 'initialize') {
    return send(res, 200, mcpResult(id, {
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'ScanFit Podi MCP', version: '1.0.0' },
      capabilities: { tools: {}, resources: {} }
    }));
  }

  if (method === 'tools/list') {
    return send(res, 200, mcpResult(id, {
      tools: [
        {
          name: 'podi.chat',
          description: 'Ask Podi about food analysis, exercise prescriptions, billing, refunds, or payment issues.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'User question' },
              language: { type: 'string', enum: ['ko-KR', 'en-US'], description: 'Response language' },
              category: { type: 'string', enum: ['food', 'exercise', 'billing', 'accuracy', 'refund', 'paymentHelp'], description: 'Topic category' },
              history: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    role: { type: 'string' },
                    content: { type: 'string' }
                  },
                  required: ['role', 'content']
                }
              }
            },
            required: ['message']
          }
        }
      ]
    }));
  }

  if (method === 'tools/call') {
    const name = String(params.name || '');
    if (name !== 'podi.chat') {
      return send(res, 200, mcpError(id, -32601, 'Unknown tool'));
    }
    const args = params.arguments || {};
    const reply = await generatePodiReply({
      message: args.message || '',
      language: args.language || 'ko-KR',
      category: args.category || 'food',
      history: Array.isArray(args.history) ? args.history : [],
      model: podiModel
    });
    return send(res, 200, mcpResult(id, {
      content: [{ type: 'text', text: reply.reply }],
      isError: false,
      meta: { source: reply.source, category: reply.category }
    }));
  }

  if (method === 'resources/list') {
    return send(res, 200, mcpResult(id, {
      resources: [
        {
          uri: 'scanfit://podi/help',
          name: 'Podi Help',
          description: 'How to use ScanFit Podi for food analysis, exercise, billing, refunds, and payment help.',
          mimeType: 'text/plain'
        },
        {
          uri: 'scanfit://podi/categories',
          name: 'Podi Categories',
          description: 'Available Podi chat categories for ScanFit.',
          mimeType: 'application/json'
        },
        {
          uri: 'scanfit://scanfit/overview',
          name: 'ScanFit Overview',
          description: 'High-level product overview and key flows.',
          mimeType: 'text/plain'
        }
      ]
    }));
  }

  if (method === 'resources/read') {
    const uri = String(params.uri || '');
    if (uri === 'scanfit://podi/help') {
      return send(res, 200, mcpResult(id, {
        contents: [{
          uri,
          mimeType: 'text/plain',
          text: [
            'Podi categories:',
            '- food: food analysis, feeding amount, weekly meal plan',
            '- exercise: exercise prescription, activity load, warnings',
            '- billing: pricing per pet, free attempt limits, checkout behavior',
            '- accuracy: analysis errors, image quality, breed selection mistakes',
            '- refund: refund process, order ID, support routing',
            '- paymentHelp: PayPal setup, sandbox/live mismatch, USD requirements'
          ].join('\n')
        }]
      }));
    }
    if (uri === 'scanfit://podi/categories') {
      return send(res, 200, mcpResult(id, {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            categories: ['food', 'exercise', 'billing', 'accuracy', 'refund', 'paymentHelp']
          }, null, 2)
        }]
      }));
    }
    if (uri === 'scanfit://scanfit/overview') {
      return send(res, 200, mcpResult(id, {
        contents: [{
          uri,
          mimeType: 'text/plain',
          text: [
            'ScanFit is a pet food analysis and exercise prescription product for dogs and cats.',
            'Step 1 analyzes label images and builds feeding guidance and a 7-day meal plan.',
            'Step 2 turns the meal plan into exercise prescription with pet-type-specific logic.',
            'Podi is the real-time support assistant for analysis, billing, refunds, and payment help.'
          ].join('\n')
        }]
      }));
    }
    return send(res, 200, mcpError(id, -32602, 'Unknown resource'));
  }

  return send(res, 200, mcpError(id, -32601, 'Method not found'));
}

function getPaypalCredentials() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
  return { clientId, secret };
}

async function getPaypalAccessToken() {
  const { clientId, secret } = getPaypalCredentials();
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const response = await fetch(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'PayPal auth failed');
  return data.access_token;
}

function computePrice({ plan = 'monthly', petCount = 1, currency = 'KRW' }) {
  const count = Math.max(1, Number(petCount || 1));
  const isAnnual = plan === 'annual';
  const paypalCurrency = 'USD';
  const base = isAnnual ? 210 : 21;
  const addon = count * 1;
  return { base, addon, total: base + addon, petCount: count, currency: paypalCurrency, displayCurrency: currency };
}

async function paypalConfig(req, res) {
  if (!process.env.PAYPAL_CLIENT_ID) {
    return send(res, 503, JSON.stringify({ error: 'PAYPAL_CLIENT_ID is not set' }));
  }
  send(res, 200, JSON.stringify({ clientId: process.env.PAYPAL_CLIENT_ID, env: paypalEnv }));
}

async function createPaypalOrder(req, res) {
  const body = await readJson(req);
  const price = computePrice(body);
  const token = await getPaypalAccessToken();
  const response = await fetch(`${paypalBase}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `scanfit-${Date.now()}-${Math.random().toString(16).slice(2)}`
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        description: `ScanFit ${body.plan || 'monthly'} plan - ${price.petCount} pet(s)`,
        amount: { currency_code: price.currency, value: price.total.toFixed(price.currency === 'USD' ? 2 : 0) },
        custom_id: JSON.stringify({ plan: body.plan || 'monthly', petCount: price.petCount })
      }]
    })
  });
  const data = await response.json();
  if (!response.ok) return send(res, response.status, JSON.stringify(data));
  send(res, 200, JSON.stringify({ id: data.id, price }));
}

async function capturePaypalOrder(req, res) {
  const { orderID } = await readJson(req);
  if (!orderID) return send(res, 400, JSON.stringify({ error: 'orderID is required' }));
  const token = await getPaypalAccessToken();
  const response = await fetch(`${paypalBase}/v2/checkout/orders/${orderID}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!response.ok) return send(res, response.status, JSON.stringify(data));
  send(res, 200, JSON.stringify({ status: data.status, order: data }));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.url === '/api/analyze-food' && req.method === 'POST') return analyzeFood(req, res);
    if (req.url === '/api/generate-report-image' && req.method === 'POST') return generateReportImage(req, res);
    if (req.url === '/api/podi-chat' && req.method === 'POST') return podiChat(req, res);
    if (req.url === '/api/podi-chat-stream' && req.method === 'POST') return podiChatStream(req, res);
      if (req.url === '/api/podi-contact' && req.method === 'POST') return podiContact(req, res);
      if (req.url === '/api/podi-realtime-token' && req.method === 'POST') return podiRealtimeToken(req, res);
      if (req.url === '/api/email/diagnostics' && req.method === 'GET') return emailDiagnostics(req, res);
      if (req.url === '/api/auth/request-login' || req.url === '/api/auth/status' || req.url === '/api/auth/logout' || req.url.startsWith('/auth/verify')) return send(res, 404, 'Not found');
      if (req.url === '/mcp' && req.method === 'POST') return podiMcp(req, res);
    if (req.url === '/api/paypal/config' && req.method === 'GET') return paypalConfig(req, res);
    if (req.url === '/api/paypal/create-order' && req.method === 'POST') return createPaypalOrder(req, res);
    if (req.url === '/api/paypal/capture-order' && req.method === 'POST') return capturePaypalOrder(req, res);

    const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.normalize(path.join(root, urlPath));
    if (!filePath.startsWith(root)) return send(res, 403, 'Forbidden', 'text/plain');

    fs.readFile(filePath, (error, content) => {
      if (error) return send(res, 404, 'Not found', 'text/plain');
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
      let body = content;
      if (ext === '.html') {
        body = Buffer.from(String(content).replace(/__SCANFIT_FORMSPREE_ENDPOINT__/g, formspreeEndpoint), 'utf8');
      }
      send(res, 200, body, types[ext] || 'application/octet-stream');
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }));
  }
});

server.listen(port, () => {
  console.log(`ScanFit running at http://localhost:${port}`);
  console.log(`Food AI endpoint uses model ${model}. Set OPENAI_API_KEY before running for real analysis.`);
  console.log(`Podi chat uses model ${podiModel}.`);
  console.log(`Podi realtime token endpoint is available at /api/podi-realtime-token.`);
  console.log(`Report image endpoint uses image model ${imageModel}.`);
});


