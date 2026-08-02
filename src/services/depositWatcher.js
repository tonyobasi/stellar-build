import crypto from 'node:crypto';
import { nowDate } from '../db.js';
import { isIncomingUsdcOperation, operationToDeposit } from './stellar.js';

export class DepositWatcher {
  constructor({ config, repository, stellarService, logger }) {
    this.config = config;
    this.repository = repository;
    this.stellarService = stellarService;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.logger.error({ err: error }, 'deposit polling failed');
      });
    }, this.config.pollIntervalMs);

    this.pollOnce().catch((error) => {
      this.logger.error({ err: error }, 'initial deposit polling failed');
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce() {
    if (this.running) {
      return { skipped: true };
    }

    this.running = true;

    try {
      const locked = await this.repository.withNamedLock('deposit-watcher', 0, async () => {
        let walletsChecked = 0;
        let depositsCreated = 0;

        const wallets = await this.repository.listReadyWallets(1000);

        for (const wallet of wallets) {
          walletsChecked += 1;
          depositsCreated += await this.pollWallet(wallet);
        }

        return { skipped: false, walletsChecked, depositsCreated };
      });

      return locked.acquired ? locked.result : { skipped: true, reason: 'deposit watcher lock is held' };
    } finally {
      this.running = false;
    }
  }

  async pollWallet(wallet) {
    let cursor = wallet.last_paging_token;
    let depositsCreated = 0;
    let pages = 0;

    while (pages < 5) {
      pages += 1;

      let request = this.stellarService.server
        .payments()
        .forAccount(wallet.public_key)
        .order('asc')
        .limit(200);

      if (cursor) {
        request = request.cursor(cursor);
      }

      const page = await request.call();
      const records = page.records || [];

      if (records.length === 0) {
        break;
      }

      for (const operation of records) {
        cursor = operation.paging_token || cursor;

        if (!isIncomingUsdcOperation(operation, wallet, this.config)) {
          continue;
        }

        const deposit = operationToDeposit(operation, wallet, this.config);
        const inserted = await this.repository.insertDeposit(deposit);

        if (inserted) {
          depositsCreated += 1;
          await this.createWebhookEvent(deposit);
          this.logger.info(
            {
              walletId: wallet.id,
              externalUserId: wallet.external_user_id,
              amount: deposit.amount,
              transactionHash: deposit.transactionHash
            },
            'detected Stellar USDC deposit'
          );
        }
      }

      if (cursor) {
        await this.repository.updateWalletCursor(wallet.id, cursor);
      }

      if (records.length < 200) {
        break;
      }
    }

    return depositsCreated;
  }

  async createWebhookEvent(deposit) {
    const createdAt = nowDate();
    const payload = {
      id: crypto.randomUUID(),
      type: 'deposit.created',
      createdAt,
      data: {
        depositId: deposit.id,
        walletId: deposit.walletId,
        network: deposit.network,
        externalUserId: deposit.externalUserId,
        amount: deposit.amount,
        assetCode: deposit.assetCode,
        assetIssuer: deposit.assetIssuer,
        from: deposit.fromAddress,
        to: deposit.toAddress,
        transactionHash: deposit.transactionHash,
        operationId: deposit.operationId,
        pagingToken: deposit.pagingToken,
        ledger: deposit.ledger,
        operationCreatedAt: deposit.operationCreatedAt,
        detectedAt: deposit.detectedAt
      }
    };

    await this.repository.insertWebhookEvent({
      id: payload.id,
      type: payload.type,
      depositId: deposit.id,
      payloadJson: JSON.stringify(payload),
      status: this.config.appWebhookUrl ? 'pending' : 'disabled',
      attempts: 0,
      maxAttempts: this.config.webhookMaxAttempts,
      nextAttemptAt: this.config.appWebhookUrl ? createdAt : null,
      deliveredAt: null,
      lastError: this.config.appWebhookUrl ? null : 'APP_WEBHOOK_URL is not configured',
      createdAt,
      updatedAt: createdAt
    });
  }
}
