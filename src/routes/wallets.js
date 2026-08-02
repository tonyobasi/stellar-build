import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../errors.js';
import { serializeWallet } from '../services/wallets.js';

const createWalletSchema = z.object({
  externalUserId: z.string().trim().min(1).max(128),
  metadata: z.record(z.string(), z.unknown()).optional().default({})
});

export function createWalletRoutes({ walletService }) {
  const router = express.Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = createWalletSchema.parse(req.body);
      const wallet = await walletService.getOrCreateWallet(input);

      res.status(201).json({
        wallet: serializeWallet(wallet)
      });
    })
  );

  router.get(
    '/by-user/:externalUserId',
    asyncHandler(async (req, res) => {
      const wallet = await walletService.getWalletByExternalUserId(req.params.externalUserId);

      res.json({
        wallet: serializeWallet(wallet)
      });
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const wallet = await walletService.getWalletById(req.params.id);

      res.json({
        wallet: serializeWallet(wallet)
      });
    })
  );

  return router;
}
