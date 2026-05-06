const readline = require('readline');
const { generatePodiReply } = require('./podi-chat-core');

const model = process.env.OPENAI_PODI_MODEL || process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-1.5';

const SERVER_INFO = {
  name: 'ScanFit Podi MCP',
  version: '1.0.0'
};

const RESOURCE_DEFS = [
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
  },
  {
    uri: 'scanfit://auth/help',
    name: 'ScanFit Auth Help',
    description: 'Login flow has been removed from ScanFit.',
    mimeType: 'text/plain'
  },
  {
    uri: 'scanfit://auth/cloudflare',
    name: 'ScanFit Cloudflare Auth',
    description: 'Cloudflare Access notes for ScanFit deployment.',
    mimeType: 'text/plain'
  }
];

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  const error = { code, message };
  if (typeof data !== 'undefined') error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function getResourceContents(uri) {
  if (uri === 'scanfit://podi/help') {
    return [{
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
    }];
  }

  if (uri === 'scanfit://podi/categories') {
    return [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        categories: ['food', 'exercise', 'billing', 'accuracy', 'refund', 'paymentHelp']
      }, null, 2)
    }];
  }

  if (uri === 'scanfit://scanfit/overview') {
    return [{
      uri,
      mimeType: 'text/plain',
      text: [
        'ScanFit is a pet food analysis and exercise prescription product for dogs and cats.',
        'Step 1 analyzes label images and builds feeding guidance and a 7-day meal plan.',
        'Step 2 turns the meal plan into exercise prescription with pet-type-specific logic.',
        'Podi is the real-time support assistant for analysis, billing, refunds, and payment help.'
      ].join('\n')
    }];
  }

  if (uri === 'scanfit://auth/help') {
    return [{
      uri,
      mimeType: 'text/plain',
      text: [
        'ScanFit no longer exposes a login flow in the site or API.',
        'The previous email-verification flow has been removed.',
        'Use the public app without authentication.'
      ].join('\n')
    }];
  }

  if (uri === 'scanfit://auth/cloudflare') {
    return [{
      uri,
      mimeType: 'text/plain',
      text: [
        'Cloudflare Access can sit in front of ScanFit as the identity and policy layer.',
        'Recommended setup:',
        '- Put the web app behind a Cloudflare Access application or MCP server portal.',
        '- Use managed OAuth or a third-party IdP such as Auth0, WorkOS, or Stytch.',
        '- Keep ScanFit app access aligned with your Access policy if you need protection.',
        '- Use the MCP server portal for chat/resource access and the Access app for browser access.'
      ].join('\n')
    }];
  }

  return null;
}

async function handleMcpMessage(message) {
  const method = message?.method;
  const id = message?.id ?? null;
  const params = message?.params || {};

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2025-03-26',
      serverInfo: SERVER_INFO,
      capabilities: { tools: {}, resources: {} }
    });
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: [
        {
          name: 'podi.chat',
          description: 'Ask Podi about food analysis, exercise prescriptions, billing, refunds, or payment issues.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'User question' },
              language: { type: 'string', enum: ['ko-KR', 'en-US'], description: 'Response language' },
              category: {
                type: 'string',
                enum: ['food', 'exercise', 'billing', 'accuracy', 'refund', 'paymentHelp'],
                description: 'Topic category'
              },
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
    });
  }

  if (method === 'tools/call') {
    const name = String(params.name || '');
    if (name !== 'podi.chat') {
      return jsonRpcError(id, -32601, 'Unknown tool');
    }

    const args = params.arguments || {};
    const reply = await generatePodiReply({
      message: args.message || '',
      language: args.language || 'ko-KR',
      category: args.category || 'food',
      history: Array.isArray(args.history) ? args.history : [],
      model
    });

    return jsonRpcResult(id, {
      content: [{ type: 'text', text: reply.reply }],
      isError: false,
      meta: { source: reply.source, category: reply.category }
    });
  }

  if (method === 'resources/list') {
    return jsonRpcResult(id, {
      resources: RESOURCE_DEFS
    });
  }

  if (method === 'resources/read') {
    const uri = String(params.uri || '');
    const contents = getResourceContents(uri);
    if (!contents) {
      return jsonRpcError(id, -32602, 'Unknown resource');
    }
    return jsonRpcResult(id, { contents });
  }

  if (method === 'ping') {
    return jsonRpcResult(id, { ok: true });
  }

  return jsonRpcError(id, -32601, 'Method not found');
}

async function handleEnvelope(envelope) {
  if (Array.isArray(envelope)) {
    const responses = [];
    for (const message of envelope) {
      const response = await handleMcpMessage(message);
      if (response && message?.id !== undefined && message?.id !== null) responses.push(response);
    }
    return responses.length ? responses : null;
  }

  return handleMcpMessage(envelope);
}

function writeResponse(response) {
  if (!response) return;
  process.stdout.write(JSON.stringify(response) + '\n');
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on('line', async line => {
  const trimmed = String(line || '').trim();
  if (!trimmed) return;

  try {
    const envelope = JSON.parse(trimmed);
    const response = await handleEnvelope(envelope);
    if (Array.isArray(response)) {
      for (const item of response) writeResponse(item);
    } else {
      writeResponse(response);
    }
  } catch (error) {
    process.stderr.write(`[mcp] ${error.message}\n`);
  }
});

rl.on('close', () => {
  process.exit(0);
});

process.stderr.write('ScanFit Podi MCP stdio server ready.\n');
