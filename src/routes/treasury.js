import express from 'express';
import { asyncHandler } from '../errors.js';

export function createTreasuryRoutes({ stellarService }) {
  const router = express.Router();

  router.get(
    '/balance',
    asyncHandler(async (_req, res) => {
      const treasury = await stellarService.getTreasuryBalance();
      res.json({ treasury });
    })
  );

  return router;
}
