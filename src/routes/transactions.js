import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../errors.js';

const listSentTransactionsSchema = z.object({
  sourceWalletId: z.string().trim().min(1).optional(),
  status: z.enum(['pending', 'submitted', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100)
});

export function createTransactionRoutes({ repository }) {
  const router = express.Router();

  router.get(
    '/sent',
    asyncHandler(async (req, res) => {
      const query = listSentTransactionsSchema.parse(req.query);
      const transactions = (await repository.listSentTransactions(query)).map(serializeSentTransaction);

      res.json({ transactions });
    })
  );

  return router;
}

function serializeSentTransaction(transaction) {
  return {
    id: transaction.id,
    idempotencyKey: transaction.idempotency_key,
    network: transaction.network,
    sourceType: transaction.source_type,
    sourceWalletId: transaction.source_wallet_id,
    sourcePublicKey: transaction.source_public_key,
    destinationPublicKey: transaction.destination_public_key,
    amount: transaction.amount,
    assetCode: transaction.asset_code,
    assetIssuer: transaction.asset_issuer,
    memoType: transaction.memo_type,
    memoValue: transaction.memo_value,
    transactionHash: transaction.transaction_hash,
    operationId: transaction.operation_id,
    ledger: transaction.ledger,
    status: transaction.status,
    error: transaction.error,
    request: parseJsonColumn(transaction.request_json),
    raw: parseJsonColumn(transaction.raw_json),
    createdAt: transaction.created_at,
    updatedAt: transaction.updated_at,
    submittedAt: transaction.submitted_at
  };
}

function parseJsonColumn(value) {
  if (!value) {
    return null;
  }

  return typeof value === 'string' ? JSON.parse(value) : value;
}
