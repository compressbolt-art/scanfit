# ScanFit Cloudflare Access MCP Auth

This repo currently supports local email verification for login, but the Cloudflare Access deployment path is the recommended production setup for MCP-gated access.

## Goal

- Put the ScanFit web app behind Cloudflare Access.
- Use Cloudflare-managed OAuth or a third-party IdP such as Auth0, WorkOS, or Stytch.
- Keep the MCP server behind the same identity boundary.
- Allow verified users to use free or paid ScanFit flows after authentication.

## Recommended deployment shape

1. Cloudflare Access protects the ScanFit web app.
2. The browser authenticates through the IdP.
3. The app reads the authenticated identity and unlocks the UI.
4. MCP tools/resources are exposed through a Cloudflare MCP portal or a protected MCP endpoint.
5. Email verification remains available as a fallback for local/dev environments.

## Local environment variables

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ACCESS_APP_ID`
- `CLOUDFLARE_ACCESS_TEAM`
- `CLOUDFLARE_OAUTH_CLIENT_ID`
- `CLOUDFLARE_OAUTH_CLIENT_SECRET`

## Notes

- The current repo does not provision Cloudflare resources automatically.
- The local runtime still uses `POST /api/auth/request-login` plus `/auth/verify` for email login.
- `scanfit://auth/cloudflare` is exposed through the MCP server as a reference resource.

