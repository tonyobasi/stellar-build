import crypto from 'node:crypto';
import { nowDate } from '../db.js';
import { ApiError } from '../errors.js';
import { signWebhookPayload } from './crypto.js';

export class WebhookDispatcher {
  constructor({ config, repository, logger }) {
    this.config = config;
    this.repository = repository;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!this.config.appWebhookUrl || this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.sendPendingOnce().catch((error) => {
        this.logger.error({ err: error }, 'webhook delivery failed');
      });
    }, this.config.webhookIntervalMs);

    this.sendPendingOnce().catch((error) => {
      this.logger.error({ err: error }, 'initial webhook delivery failed');
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sendPendingOnce() {
    if (!this.config.appWebhookUrl) {
      return { skipped: true, reason: 'APP_WEBHOOK_URL is not configured' };
    }

    if (this.running) {
      return { skipped: true, reason: 'webhook dispatcher already running' };
    }

    this.running = true;

    try {
      const locked = await this.repository.withNamedLock('webhook-dispatcher', 0, async () => {
        let delivered = 0;
        let failed = 0;

        const events = await this.repository.listDueWebhookEvents(nowDate(), 50);

        for (const event of events) {
          const result = await this.deliverEvent(event);
          if (result.delivered) {
            delivered += 1;
          } else {
            failed += 1;
          }
        }

        return { skipped: false, delivered, failed };
      });

      return locked.acquired ? locked.result : { skipped: true, reason: 'webhook dispatcher lock is held' };
    } finally {
      this.running = false;
    }
  }

  async deliverEvent(event) {
    const attemptNumber = event.attempts + 1;
    const body = typeof event.payload_json === 'string' ? event.payload_json : JSON.stringify(event.payload_json);
    const timestamp = Date.now().toString();
    const signature = signWebhookPayload(this.config.appWebhookSecret, timestamp, body);

    try {
      const response = await fetch(this.config.appWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'stellar-usdc-wallet-service/0.1',
          'X-Stellar-Wallet-Event': event.type,
          'X-Stellar-Wallet-Timestamp': timestamp,
          'X-Stellar-Wallet-Signature': signature
        },
        body
      });

      const responseBody = await safeReadResponse(response);
      await this.repository.recordWebhookAttempt({
        id: crypto.randomUUID(),
        eventId: event.id,
        attemptNumber,
        statusCode: response.status,
        responseBody,
        error: response.ok ? null : `Webhook endpoint returned HTTP ${response.status}`,
        createdAt: nowDate()
      });

      if (response.ok) {
        await this.repository.markWebhookDelivered(event.id, attemptNumber);
        this.logger.info({ eventId: event.id, attemptNumber }, 'webhook delivered');
        return { delivered: true };
      }

      await this.markFailedDelivery(
        event,
        attemptNumber,
        `Webhook endpoint returned HTTP ${response.status}: ${responseBody.slice(0, 500)}`
      );
      return { delivered: false };
    } catch (error) {
      await this.repository.recordWebhookAttempt({
        id: crypto.randomUUID(),
        eventId: event.id,
        attemptNumber,
        statusCode: null,
        responseBody: null,
        error: error.message,
        createdAt: nowDate()
      });

      await this.markFailedDelivery(event, attemptNumber, error.message);
      return { delivered: false };
    }
  }

  async markFailedDelivery(event, attemptNumber, message) {
    const exhausted = attemptNumber >= event.max_attempts;
    await this.repository.markWebhookFailedAttempt(event.id, {
      attempts: attemptNumber,
      status: exhausted ? 'failed' : 'pending',
      nextAttemptAt: exhausted ? null : nextRetryAt(attemptNumber),
      lastError: message
    });

    this.logger.warn(
      {
        eventId: event.id,
        attemptNumber,
        exhausted,
        error: message
      },
      'webhook delivery attempt failed'
    );
  }

  async retryDepositWebhook(depositId) {
    const event = await this.repository.getWebhookEventByDepositId(depositId);
    if (!event) {
      throw new ApiError(404, 'Webhook event not found for deposit');
    }

    return await this.repository.resetWebhookEventForRetry(event.id);
  }
}

async function safeReadResponse(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function nextRetryAt(attemptNumber) {
  const baseDelayMs = 10_000;
  const maxDelayMs = 30 * 60 * 1000;
  const delay = Math.min(baseDelayMs * 2 ** Math.max(0, attemptNumber - 1), maxDelayMs);
  return new Date(Date.now() + delay);
}
