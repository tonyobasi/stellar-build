import express from 'express';
import pinoHttp from 'pino-http';
import { formatError } from './errors.js';
import { authenticateApiKey } from './middleware/auth.js';
import {
  createRateLimiter,
  enforceAllowedHosts,
  enforceHttps,
  enforceIpAllowlist
} from './middleware/security.js';
import { createDepositRoutes } from './routes/deposits.js';
import { createTreasuryRoutes } from './routes/treasury.js';
import { createTransactionRoutes } from './routes/transactions.js';
import { createWalletRoutes } from './routes/wallets.js';

export function createApp({
  config,
  logger,
  repository,
  walletService,
  stellarService,
  depositWatcher,
  webhookDispatcher
}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(enforceAllowedHosts(config));
  app.use(enforceHttps(config));
  app.use(
    pinoHttp({
      logger,
      autoLogging: config.nodeEnv !== 'test'
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      network: config.stellarNetwork,
      webhookConfigured: Boolean(config.appWebhookUrl),
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  app.use('/v1', createRateLimiter(config), enforceIpAllowlist(config), authenticateApiKey(config));
  app.get('/v1/health', (_req, res) => {
    res.json({
      ok: true,
      network: config.stellarNetwork,
      horizonUrl: config.horizonUrl,
      treasuryPublicKey: config.treasuryPublicKey,
      asset: {
        code: config.usdcAssetCode,
        issuer: config.usdcIssuer
      },
      webhookConfigured: Boolean(config.appWebhookUrl),
      uptimeSeconds: Math.round(process.uptime())
    });
  });
  app.use('/v1/wallets', createWalletRoutes({ walletService }));
  app.use('/v1/deposits', createDepositRoutes({ config, repository, depositWatcher, webhookDispatcher }));
  app.use('/v1/transactions', createTransactionRoutes({ repository }));
  app.use('/v1/treasury', createTreasuryRoutes({ stellarService }));

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        message: 'Not found'
      }
    });
  });

  app.use((error, req, res, _next) => {
    const statusCode = error.statusCode || (error.name === 'ZodError' ? 400 : 500);

    req.log?.error(
      {
        err: statusCode >= 500 ? error : undefined,
        statusCode
      },
      error.message
    );

    res.status(statusCode).json({
      error: formatError(error)
    });
  });

  return app;
}
