# Ghost Bazaar Frontend

Vite + React frontend for the Ghost Bazaar landing page, wallet bar, public dashboard, and admin UI.

## Production

- Site: `https://ghost-bazaar.vercel.app`
- Vercel project root: `frontend/`
- Build command: `pnpm build`

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `VITE_MOONPAY_API_KEY` | Yes for live wallet auth | MoonPay public / publishable key used by the wallet bar |
| `VITE_API_URL` | No for landing page | Backend base URL for dashboard and admin routes |

Notes:

- `VITE_MOONPAY_API_KEY` is intentionally browser-visible because MoonPay uses a public / publishable key for the frontend flow.
- If `VITE_API_URL` is omitted, the landing page still works and backend-dependent nav links are hidden.
- If MoonPay login fails, the app falls back to opening `https://www.moonpay.com`.

## Local Development

From the monorepo root:

```bash
pnpm install
pnpm --filter frontend dev
```

By default, local Vite proxying assumes the backend is running on `http://localhost:3000`.

## Build

```bash
pnpm --filter frontend build
```

## MoonPay Onboarding Pages

The frontend includes static legal pages for MoonPay onboarding:

- `/privacy-policy.html`
- `/terms-of-service.html`

These are minimal demo-safe pages for hackathon submission and testing.
