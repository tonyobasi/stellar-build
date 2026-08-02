# Stellar USDC Wallet Microservice

Express service for generated Stellar USDC deposit wallets:

- creates a Stellar account per app user
- funds the account from a treasury signer
- creates the USDC trustline
- watches Horizon for incoming Stellar USDC deposits
- sends signed webhook notifications to your main app

This is a custodial wallet pattern because the service generates and stores encrypted private keys. Use testnet first, then move secrets to KMS/HSM or a custody provider before handling meaningful balances.

## Quick Start

```bash
cp .env.example .env
npm install
```

Create the MySQL database and user:

```sql
CREATE DATABASE stellar_usdc_wallet_service CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'stellar_usdc'@'localhost' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT ALL PRIVILEGES ON stellar_usdc_wallet_service.* TO 'stellar_usdc'@'localhost';
FLUSH PRIVILEGES;
```

Set these in `.env`:

```env
PUBLIC_BASE_URL=https://stellar.saference.com
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=stellar_usdc
MYSQL_PASSWORD=replace-with-a-strong-password
MYSQL_DATABASE=stellar_usdc_wallet_service
```

Generate a treasury keypair:

```bash
node -e "import { Keypair } from '@stellar/stellar-sdk'; const k=Keypair.random(); console.log({ publicKey:k.publicKey(), secret:k.secret() })"
```

Put the secret in `.env` as `TREASURY_SECRET`, then fund the public key on testnet:

```bash
npm run fund:testnet -- <TREASURY_PUBLIC_KEY>
```

Add the treasury USDC trustline:

```bash
npm run treasury:trustline
```

Generate encryption and webhook secrets:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Start the service:

```bash
npm run dev
```

## Docker Deployment

The production Docker stack runs:

- `app`: the Node/Express Stellar USDC service
- `mysql`: MySQL 8.4 with persistent volume storage
- `caddy`: HTTPS reverse proxy for `stellar.saference.com`

Before starting the stack, make sure DNS for `stellar.saference.com` points to the VPS and ports `80` and `443` are open.

On the server:

```bash
git clone https://github.com/bashtoc/stellar-build.git
cd stellar-build
cp .env.docker.example .env
```

Fill `.env` with real secrets:

```bash
openssl rand -hex 32        # API_KEY
openssl rand -base64 32     # WALLET_ENCRYPTION_KEY
openssl rand -hex 32        # APP_WEBHOOK_SECRET, if APP_WEBHOOK_URL is set
openssl rand -base64 32     # MYSQL_PASSWORD
openssl rand -base64 32     # MYSQL_ROOT_PASSWORD
```

Then start:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Check the service:

```bash
curl https://stellar.saference.com/health
curl https://stellar.saference.com/v1/health -H "X-API-Key: <API_KEY>"
```

Update an existing deployment:

```bash
git pull
docker compose up -d --build
```

## API

All `/v1/*` endpoints require:

```http
X-API-Key: <API_KEY>
```

Create or return a wallet for an app user:

```bash
curl -X POST https://stellar.saference.com/v1/wallets \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <API_KEY>" \
  -d '{"externalUserId":"user_123"}'
```

Response:

```json
{
  "wallet": {
    "id": "wallet_uuid",
    "externalUserId": "user_123",
    "publicKey": "G...",
    "network": "testnet",
    "asset": {
      "code": "USDC",
      "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    },
    "status": "ready"
  }
}
```

List deposits:

```bash
curl https://stellar.saference.com/v1/deposits \
  -H "X-API-Key: <API_KEY>"
```

Get treasury balances:

```bash
curl https://stellar.saference.com/v1/treasury/balance \
  -H "X-API-Key: <API_KEY>"
```

Fetch a wallet:

```bash
curl https://stellar.saference.com/v1/wallets/<wallet_id> \
  -H "X-API-Key: <API_KEY>"
```

Fetch a wallet by your app's user id:

```bash
curl https://stellar.saference.com/v1/wallets/by-user/user_123 \
  -H "X-API-Key: <API_KEY>"
```

Manually run one deposit polling cycle:

```bash
curl -X POST https://stellar.saference.com/v1/deposits/poll \
  -H "X-API-Key: <API_KEY>"
```

Retry a deposit webhook:

```bash
curl -X POST https://stellar.saference.com/v1/deposits/<deposit_id>/retry-webhook \
  -H "X-API-Key: <API_KEY>"
```

List sent transactions:

```bash
curl https://stellar.saference.com/v1/transactions/sent \
  -H "X-API-Key: <API_KEY>"
```

Health check:

```bash
curl https://stellar.saference.com/health
```

## Webhook Payload

When a USDC deposit is detected, the service sends:

```json
{
  "id": "event_uuid",
  "type": "deposit.created",
  "createdAt": "2026-07-31T00:00:00.000Z",
  "data": {
    "depositId": "deposit_uuid",
    "walletId": "wallet_uuid",
    "externalUserId": "user_123",
    "amount": "25.0000000",
    "assetCode": "USDC",
    "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "from": "G...",
    "to": "G...",
    "transactionHash": "...",
    "operationId": "...",
    "pagingToken": "..."
  }
}
```

Headers:

```http
X-Stellar-Wallet-Event: deposit.created
X-Stellar-Wallet-Timestamp: <unix_ms>
X-Stellar-Wallet-Signature: sha256=<hmac_sha256(timestamp + "." + raw_body)>
```

Your app should verify the signature, then credit `externalUserId` idempotently using `depositId` or `operationId`.

Node verification example:

```js
import crypto from 'node:crypto';

function verifyWebhook({ secret, timestamp, rawBody, signature }) {
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

## Implementation Notes

- `POST /v1/wallets` is idempotent per `externalUserId` and Stellar network.
- Wallet private keys are encrypted with `WALLET_ENCRYPTION_KEY` before being stored.
- A generated wallet is marked `ready` only after the Stellar account exists and the USDC trustline is present.
- Deposit detection polls Horizon per ready wallet and records deposits by unique Stellar operation id.
- Webhook delivery is retried with exponential backoff until `WEBHOOK_MAX_ATTEMPTS`.
- If `APP_WEBHOOK_URL` is not configured, deposits are still recorded, but webhook events are marked `disabled`.
- MySQL migrations run automatically on service startup.
- MySQL named locks prevent duplicate deposit polling or webhook dispatch when multiple service instances are running.
- The database includes tables for wallets, received deposits, sent transactions, idempotency keys, webhook events, and webhook attempts.
- Received transactions are idempotent by Stellar `operation_id`; sent transactions are idempotent by `(network, idempotency_key)`.
- Public `/health` returns only minimal status. Detailed health is available at authenticated `GET /v1/health`.
- API auth headers are redacted from logs.
- `/v1/*` endpoints are rate-limited and can be restricted by `API_ALLOWED_IPS`.
- Production requires strong `API_KEY`, strong `MYSQL_PASSWORD`, HTTPS base/webhook URLs, and trusted Horizon URLs.

## Mainnet Settings

For production:

```env
NODE_ENV=production
PUBLIC_BASE_URL=https://stellar.saference.com
TRUST_PROXY=true
REQUIRE_HTTPS=true
ALLOWED_HOSTS=stellar.saference.com
STELLAR_NETWORK=public
USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
HORIZON_URL=https://horizon.stellar.org
TRUSTED_HORIZON_URLS=https://horizon.stellar.org
MYSQL_SSL=true
```

Keep the testnet default until wallet creation, deposit detection, treasury trustline setup, and webhook crediting are verified end to end.

## Testnet vs Mainnet

Testnet is for development only. Friendbot can fund testnet XLM for free, testnet USDC has no real value, and the network can be reset. Use it while building and QA testing.

Mainnet is production. It uses real XLM for fees/reserves and real USDC. Accounts, transactions, and mistakes are permanent. Use separate production secrets, a funded mainnet treasury account, and the public-network USDC issuer before switching `STELLAR_NETWORK=public`.
