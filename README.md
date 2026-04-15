# VoterQR Proxy

Small Express server that proxies EZTexting API calls from the VoterQR browser app.

## Endpoints

- `GET /` — health check
- `POST /send-mms` — upload QR image + send MMS to one voter
- `POST /send-sms` — send SMS with QR link to one voter

## Deploy to Railway

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Select this repo → Railway auto-detects Node.js and deploys
4. Copy the generated URL into the VoterQR app Settings tab

## Environment

No environment variables needed — credentials are passed per-request from the app.
