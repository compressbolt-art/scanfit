import { json, parseCookies, verifyToken } from '../../_shared.js';

export async function onRequestGet({ request, env }) {
  const cookies = parseCookies(request);
  const session = await verifyToken(cookies.scanfit_auth || '', env.AUTH_SECRET, 'session');
  return json({
    authenticated: Boolean(session),
    email: session?.email || null,
    verifiedAt: session?.iat || null,
    expiresAt: session?.exp || null
  });
}
