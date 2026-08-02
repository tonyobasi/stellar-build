import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isIncomingUsdcOperation, operationToDeposit } from '../src/services/stellar.js';

const config = {
  stellarNetwork: 'testnet',
  usdcAssetCode: 'USDC',
  usdcIssuer: 'GISSUER'
};

const wallet = {
  id: 'wallet_1',
  external_user_id: 'user_1',
  public_key: 'GDESTINATION'
};

test('isIncomingUsdcOperation accepts incoming USDC payments to the wallet', () => {
  const operation = {
    type: 'payment',
    from: 'GSENDER',
    to: 'GDESTINATION',
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GISSUER',
    amount: '10.5000000'
  };

  assert.equal(isIncomingUsdcOperation(operation, wallet, config), true);
});

test('isIncomingUsdcOperation rejects wrong asset or destination', () => {
  assert.equal(
    isIncomingUsdcOperation(
      {
        type: 'payment',
        from: 'GSENDER',
        to: 'GDESTINATION',
        asset_type: 'credit_alphanum4',
        asset_code: 'EURC',
        asset_issuer: 'GISSUER',
        amount: '10.5000000'
      },
      wallet,
      config
    ),
    false
  );

  assert.equal(
    isIncomingUsdcOperation(
      {
        type: 'payment',
        from: 'GSENDER',
        to: 'GOTHER',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
        amount: '10.5000000'
      },
      wallet,
      config
    ),
    false
  );
});

test('operationToDeposit maps Horizon operation fields into a deposit row', () => {
  const deposit = operationToDeposit(
    {
      type: 'payment',
      id: '123',
      paging_token: '123',
      transaction_hash: 'hash',
      from: 'GSENDER',
      to: 'GDESTINATION',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GISSUER',
      amount: '10.5000000',
      created_at: '2026-08-01T00:00:00Z'
    },
    wallet,
    config
  );

  assert.equal(deposit.walletId, 'wallet_1');
  assert.equal(deposit.network, 'testnet');
  assert.equal(deposit.externalUserId, 'user_1');
  assert.equal(deposit.amount, '10.5000000');
  assert.equal(deposit.operationId, '123');
});
