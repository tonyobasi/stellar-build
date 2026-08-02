import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../errors.js';

const listDepositsSchema = z.object({
  walletId: z.string().trim().min(1).optional(),
  externalUserId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100)
});

export function createDepositRoutes({ config, repository, depositWatcher, webhookDispatcher }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = listDepositsSchema.parse(req.query);
      const deposits = (await repository.listDeposits({ ...query, network: config.stellarNetwork })).map(
        serializeDeposit
      );

      res.json({ deposits });
    })
  );

  router.post(
    '/poll',
    asyncHandler(async (_req, res) => {
      const result = await depositWatcher.pollOnce();
      res.json(result);
    })
  );

  router.post(
    '/:id/retry-webhook',
    asyncHandler(async (req, res) => {
      const event = await webhookDispatcher.retryDepositWebhook(req.params.id);

      res.json({
        webhookEvent: serializeWebhookEvent(event)
      });
    })
  );

  return router;
}

export function serializeDeposit(deposit) {
  return {
    id: deposit.id,
    walletId: deposit.wallet_id,
    network: deposit.network,
    externalUserId: deposit.external_user_id,
    walletPublicKey: deposit.wallet_public_key,
    amount: deposit.amount,
    assetCode: deposit.asset_code,
    assetIssuer: deposit.asset_issuer,
    from: deposit.from_address,
    to: deposit.to_address,
    transactionHash: deposit.transaction_hash,
    operationId: deposit.operation_id,
    pagingToken: deposit.paging_token,
    ledger: deposit.ledger,
    operationCreatedAt: deposit.operation_created_at,
    detectedAt: deposit.detected_at
  };
}

function serializeWebhookEvent(event) {
  return {
    id: event.id,
    type: event.type,
    depositId: event.deposit_id,
    status: event.status,
    attempts: event.attempts,
    maxAttempts: event.max_attempts,
    nextAttemptAt: event.next_attempt_at,
    deliveredAt: event.delivered_at,
    lastError: event.last_error,
    createdAt: event.created_at,
    updatedAt: event.updated_at
  };
}
