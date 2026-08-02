import 'dotenv/config';
import { Networks, Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const PUBLIC_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const nonEmpty = z.string().trim().min(1);
const booleanString = z
  .string()
  .trim()
  .optional()
  .default('false')
  .transform((value) => ['1', 'true', 'yes'].includes(value.toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().trim().url().optional().default('https://stellar.saference.com'),
  TRUST_PROXY: booleanString,
  REQUIRE_HTTPS: booleanString,
  ALLOWED_HOSTS: z.string().trim().optional().default('stellar.saference.com,localhost,127.0.0.1'),
  API_ALLOWED_IPS: z.string().trim().optional().default(''),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  STELLAR_NETWORK: z.enum(['testnet', 'public']).default('testnet'),
  HORIZON_URL: z.string().trim().optional().default(''),
  TRUSTED_HORIZON_URLS: z
    .string()
    .trim()
    .optional()
    .default('https://horizon.stellar.org,https://horizon-testnet.stellar.org'),
  TREASURY_SECRET: nonEmpty,
  API_KEY: nonEmpty,
  WALLET_ENCRYPTION_KEY: nonEmpty,
  WALLET_STARTING_XLM: z.coerce.number().positive().default(3),
  USDC_ASSET_CODE: z.string().trim().min(1).max(12).default('USDC'),
  USDC_ISSUER: z.string().trim().optional().default(''),
  APP_WEBHOOK_URL: z.string().trim().url().optional().or(z.literal('')).default(''),
  APP_WEBHOOK_SECRET: z.string().trim().optional().default(''),
  MYSQL_HOST: z.string().trim().min(1).default('127.0.0.1'),
  MYSQL_PORT: z.coerce.number().int().positive().max(65535).default(3306),
  MYSQL_USER: z.string().trim().min(1).default('stellar_usdc'),
  MYSQL_PASSWORD: z.string().optional().default(''),
  MYSQL_DATABASE: z.string().trim().min(1).default('stellar_usdc_wallet_service'),
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  MYSQL_SSL: booleanString,
  POLL_INTERVAL_MS: z.coerce.number().int().min(3000).default(12000),
  WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(3000).default(10000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  DISABLE_WORKERS: booleanString
});

export function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${message}`);
  }

  const values = parsed.data;
  const publicBaseUrl = new URL(values.PUBLIC_BASE_URL);
  const allowedHosts = parseCsv(values.ALLOWED_HOSTS);
  const apiAllowedIps = parseCsv(values.API_ALLOWED_IPS);
  const trustedHorizonUrls = parseCsv(values.TRUSTED_HORIZON_URLS);

  try {
    Keypair.fromSecret(values.TREASURY_SECRET);
  } catch {
    throw new Error('Invalid configuration: TREASURY_SECRET is not a valid Stellar secret key');
  }

  const encryptionKey = Buffer.from(values.WALLET_ENCRYPTION_KEY, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('Invalid configuration: WALLET_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  if (values.APP_WEBHOOK_URL && !values.APP_WEBHOOK_SECRET) {
    throw new Error('Invalid configuration: APP_WEBHOOK_SECRET is required when APP_WEBHOOK_URL is set');
  }

  if (values.APP_WEBHOOK_SECRET && values.APP_WEBHOOK_SECRET.length < 32) {
    throw new Error('Invalid configuration: APP_WEBHOOK_SECRET must be at least 32 characters');
  }

  const defaultIssuer = values.STELLAR_NETWORK === 'public' ? PUBLIC_USDC_ISSUER : TESTNET_USDC_ISSUER;
  const assetIssuer = values.USDC_ISSUER || defaultIssuer;
  try {
    Keypair.fromPublicKey(assetIssuer);
  } catch {
    throw new Error('Invalid configuration: USDC_ISSUER is not a valid Stellar public key');
  }

  const networkPassphrase = values.STELLAR_NETWORK === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  const horizonUrl =
    values.HORIZON_URL ||
    (values.STELLAR_NETWORK === 'public'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org');

  if (!trustedHorizonUrls.includes(horizonUrl)) {
    throw new Error(
      `Invalid configuration: HORIZON_URL must be one of TRUSTED_HORIZON_URLS (${trustedHorizonUrls.join(', ')})`
    );
  }

  if (values.NODE_ENV === 'production') {
    if (values.API_KEY === 'change-me' || values.API_KEY.length < 32) {
      throw new Error('Invalid configuration: API_KEY must be a non-placeholder value of at least 32 characters');
    }

    if (!values.MYSQL_PASSWORD || values.MYSQL_PASSWORD.length < 16) {
      throw new Error('Invalid configuration: MYSQL_PASSWORD must be at least 16 characters in production');
    }

    if (publicBaseUrl.protocol !== 'https:') {
      throw new Error('Invalid configuration: PUBLIC_BASE_URL must use https in production');
    }

    if (publicBaseUrl.hostname !== 'stellar.saference.com') {
      throw new Error('Invalid configuration: PUBLIC_BASE_URL hostname must be stellar.saference.com');
    }

    if (values.APP_WEBHOOK_URL && new URL(values.APP_WEBHOOK_URL).protocol !== 'https:') {
      throw new Error('Invalid configuration: APP_WEBHOOK_URL must use https in production');
    }

    if (!values.MYSQL_SSL && !isTrustedInternalMysql(values.MYSQL_HOST)) {
      throw new Error('Invalid configuration: MYSQL_SSL=true is required for external MySQL in production');
    }
  }

  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ''),
    trustProxy: values.TRUST_PROXY || values.NODE_ENV === 'production',
    requireHttps: values.REQUIRE_HTTPS || values.NODE_ENV === 'production',
    allowedHosts,
    apiAllowedIps,
    rateLimit: {
      windowMs: values.RATE_LIMIT_WINDOW_MS,
      max: values.RATE_LIMIT_MAX
    },
    stellarNetwork: values.STELLAR_NETWORK,
    networkPassphrase,
    horizonUrl,
    trustedHorizonUrls,
    treasurySecret: values.TREASURY_SECRET,
    treasuryPublicKey: Keypair.fromSecret(values.TREASURY_SECRET).publicKey(),
    apiKey: values.API_KEY,
    walletEncryptionKey: encryptionKey,
    walletStartingXlm: values.WALLET_STARTING_XLM.toFixed(7),
    usdcAssetCode: values.USDC_ASSET_CODE,
    usdcIssuer: assetIssuer,
    appWebhookUrl: values.APP_WEBHOOK_URL || null,
    appWebhookSecret: values.APP_WEBHOOK_SECRET || null,
    mysql: {
      host: values.MYSQL_HOST,
      port: values.MYSQL_PORT,
      user: values.MYSQL_USER,
      password: values.MYSQL_PASSWORD,
      database: values.MYSQL_DATABASE,
      connectionLimit: values.MYSQL_CONNECTION_LIMIT,
      ssl: values.MYSQL_SSL
    },
    pollIntervalMs: values.POLL_INTERVAL_MS,
    webhookIntervalMs: values.WEBHOOK_INTERVAL_MS,
    webhookMaxAttempts: values.WEBHOOK_MAX_ATTEMPTS,
    disableWorkers: values.DISABLE_WORKERS
  };
}

function parseCsv(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTrustedInternalMysql(host) {
  return ['127.0.0.1', 'localhost', '::1', 'mysql'].includes(host);
}
