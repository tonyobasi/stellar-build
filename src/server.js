import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createDatabase, createRepository } from './db.js';
import { createLogger } from './logger.js';
import { DepositWatcher } from './services/depositWatcher.js';
import { StellarService } from './services/stellar.js';
import { WalletService } from './services/wallets.js';
import { WebhookDispatcher } from './services/webhooks.js';

const config = loadConfig();
const logger = createLogger(config);

async function main() {
  const db = await createDatabase(config);
  const repository = createRepository(db);
  const stellarService = new StellarService(config, logger);
  const walletService = new WalletService({ config, repository, stellarService, logger });
  const depositWatcher = new DepositWatcher({ config, repository, stellarService, logger });
  const webhookDispatcher = new WebhookDispatcher({ config, repository, logger });

  const app = createApp({
    config,
    logger,
    repository,
    walletService,
    stellarService,
    depositWatcher,
    webhookDispatcher
  });

  const httpServer = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        network: config.stellarNetwork,
        horizonUrl: config.horizonUrl,
        mysql: {
          host: config.mysql.host,
          port: config.mysql.port,
          database: config.mysql.database
        },
        webhookConfigured: Boolean(config.appWebhookUrl)
      },
      'stellar USDC wallet service started'
    );

    if (!config.disableWorkers) {
      depositWatcher.start();
      webhookDispatcher.start();
    }
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'shutting down stellar USDC wallet service');
    depositWatcher.stop();
    webhookDispatcher.stop();

    httpServer.close(async () => {
      await db.end();
      process.exit(0);
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(signal).catch((error) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
    });
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'failed to start stellar USDC wallet service');
  process.exit(1);
});
