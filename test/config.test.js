import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.js';

test('loadConfig applies testnet defaults', () => {
  const treasury = Keypair.random();
  const config = loadConfig({
    TREASURY_SECRET: treasury.secret(),
    API_KEY: 'test-api-key',
    WALLET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64')
  });

  assert.equal(config.stellarNetwork, 'testnet');
  assert.equal(config.horizonUrl, 'https://horizon-testnet.stellar.org');
  assert.equal(config.usdcAssetCode, 'USDC');
  assert.equal(config.usdcIssuer, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  assert.equal(config.treasuryPublicKey, treasury.publicKey());
});

test('loadConfig requires a 32-byte base64 encryption key', () => {
  const treasury = Keypair.random();

  assert.throws(
    () =>
      loadConfig({
        TREASURY_SECRET: treasury.secret(),
        API_KEY: 'test-api-key',
        WALLET_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64')
      }),
    /WALLET_ENCRYPTION_KEY/
  );
});
