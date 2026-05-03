import { emailConfig, json } from '../../_shared.js';

export function onRequestGet({ env }) {
  const config = emailConfig(env);
  return json({
    provider: 'resend',
    from: config.from || null,
    missing: config.missing
  }, 200);
}
