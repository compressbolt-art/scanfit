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

  const safeHistory = Array.isArray(history)
    ? history.slice(-8).map(item => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.content || '').trim()
      })).filter(item => item.content)
    : [];

  return { cleanMessage, en, categoryKey, fallbackReply, system, troubleshooting, safeHistory };
}

function buildLocalPodiReply({ en, categoryKey, cleanMessage }) {
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

function buildPodiRealtimeInstructions({ language = 'ko-KR', category = 'food' } = {}) {
  const en = language === 'en-US';
  const categoryKey = String(category || 'food');
  const categoryLabel = en
    ? ({ food: 'food analysis', exercise: 'exercise prescription', billing: 'billing', accuracy: 'analysis errors', refund: 'refunds', paymentHelp: 'payment errors' }[categoryKey] || 'food analysis')
    : ({ food: '사료분석', exercise: '운동처방', billing: '결제', accuracy: '분석 오류', refund: '환불', paymentHelp: '결제 오류' }[categoryKey] || '사료분석');

  return en
    ? `You are Podi, ScanFit's 24-hour real-time AI pet care assistant.
Answer in English.
Be concise, practical, and product-support oriented.
Do not provide medical diagnosis.
If the user asks about food analysis, feeding, exercise prescription, billing, refunds, or payment issues, answer directly.
If the user asks about unsupported topics, redirect back to ScanFit features.
If multiple pets are visible, remind the user to upload each pet separately for accuracy.
Use the current topic focus: ${categoryLabel}.`
    : `당신은 ScanFit의 24시간 실시간 AI 반려동물 상담사 뽀디입니다.
한국어로 답하세요.
간결하고 실용적으로, 제품 지원 상담 톤으로 답하세요.
의료 진단은 제공하지 마세요.
사료분석, 급여, 운동처방, 결제, 환불, 결제 오류에는 바로 답하세요.
지원하지 않는 주제는 ScanFit 기능으로 자연스럽게 다시 안내하세요.
한 장에 여러 반려동물이 보이면 정확도를 위해 각각 따로 업로드하라고 안내하세요.
현재 상담 주제는 ${categoryLabel}입니다.`;
}

async function generatePodiReply({
  message = '',
  language = 'ko-KR',
  category = 'food',
  history = [],
  model = 'gpt-5.5',
  apiKey = process.env.OPENAI_API_KEY,
  fetchImpl = fetch
}) {
  const payload = buildPodiChatPayload({ message, language, category, history });
  if (!payload.cleanMessage) {
    return { reply: payload.en ? 'A message is required.' : '메시지가 필요합니다.', source: 'invalid', category: payload.categoryKey };
  }

  if (!apiKey) {
    return {
      reply: buildLocalPodiReply(payload) || payload.fallbackReply,
      source: 'fallback',
      category: payload.categoryKey
    };
  }

  const input = [
    ...payload.safeHistory.map(item => ({
      role: item.role,
      content: [{ type: 'input_text', text: item.content }]
    })),
    {
      role: 'user',
      content: [{ type: 'input_text', text: `Category: ${payload.categoryKey}\nUser: ${payload.cleanMessage}` }]
    }
  ];

  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      instructions: `${payload.system}\n\n${payload.troubleshooting}`,
      input
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    return {
      reply: buildLocalPodiReply(payload) || payload.fallbackReply,
      source: 'fallback',
      category: payload.categoryKey,
      detail: raw,
      status: response.status
    };
  }

  const data = JSON.parse(raw);
  const text = data.output_text || data.output?.flatMap(item => item.content || []).map(item => item.text || '').join('\n') || '';
  return {
    reply: text || buildLocalPodiReply(payload) || payload.fallbackReply,
    source: 'openai',
    category: payload.categoryKey
  };
}

module.exports = {
  buildPodiChatPayload,
  buildLocalPodiReply,
  buildPodiRealtimeInstructions,
  generatePodiReply
};
