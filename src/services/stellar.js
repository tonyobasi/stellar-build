import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder
} from '@stellar/stellar-sdk';
import crypto from 'node:crypto';

export class StellarService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.server = new Horizon.Server(config.horizonUrl);
    this.usdcAsset = new Asset(config.usdcAssetCode, config.usdcIssuer);
    this.treasuryKeypair = Keypair.fromSecret(config.treasurySecret);
  }

  generateKeypair() {
    return Keypair.random();
  }

  async provisionWallet(publicKey, secret) {
    const walletKeypair = Keypair.fromSecret(secret);
    if (walletKeypair.publicKey() !== publicKey) {
      throw new Error('Wallet secret does not match public key');
    }

    let account = await this.loadAccountOrNull(publicKey);

    if (!account) {
      await this.createAccount(publicKey);
      account = await this.loadAccountOrNull(publicKey);
    }

    if (!account) {
      throw new Error(`Wallet account ${publicKey} was not found after createAccount`);
    }

    if (!this.accountHasUsdcTrustline(account)) {
      await this.createUsdcTrustline(account, walletKeypair);
    }

    return this.getLatestPaymentCursor(publicKey);
  }

  async createAccount(publicKey) {
    const treasuryAccount = await this.server.loadAccount(this.treasuryKeypair.publicKey());
    const transaction = new TransactionBuilder(treasuryAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase
    })
      .addOperation(
        Operation.createAccount({
          destination: publicKey,
          startingBalance: this.config.walletStartingXlm
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(this.treasuryKeypair);
    const result = await this.server.submitTransaction(transaction);
    this.logger.info({ hash: result.hash, publicKey }, 'created Stellar wallet account');
  }

  async createUsdcTrustline(walletAccount, walletKeypair) {
    const transaction = new TransactionBuilder(walletAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase
    })
      .addOperation(
        Operation.changeTrust({
          asset: this.usdcAsset
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(walletKeypair);
    const result = await this.server.submitTransaction(transaction);
    this.logger.info({ hash: result.hash, publicKey: walletKeypair.publicKey() }, 'created USDC trustline');
  }

  accountHasUsdcTrustline(account) {
    return account.balances.some(
      (balance) =>
        balance.asset_type !== 'native' &&
        balance.asset_code === this.config.usdcAssetCode &&
        balance.asset_issuer === this.config.usdcIssuer
    );
  }

  async loadAccountOrNull(publicKey) {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (error) {
      if (error?.response?.status === 404) {
        return null;
      }

      throw this.normalizeHorizonError(error);
    }
  }

  async getLatestPaymentCursor(publicKey) {
    const page = await this.server.payments().forAccount(publicKey).order('desc').limit(1).call();
    return page.records[0]?.paging_token || null;
  }

  async getTreasuryBalance() {
    const account = await this.server.loadAccount(this.treasuryKeypair.publicKey());

    const balances = account.balances.map((balance) => {
      if (balance.asset_type === 'native') {
        return {
          assetType: balance.asset_type,
          assetCode: 'XLM',
          assetIssuer: null,
          balance: balance.balance,
          buyingLiabilities: balance.buying_liabilities,
          sellingLiabilities: balance.selling_liabilities
        };
      }

      return {
        assetType: balance.asset_type,
        assetCode: balance.asset_code,
        assetIssuer: balance.asset_issuer,
        balance: balance.balance,
        limit: balance.limit,
        buyingLiabilities: balance.buying_liabilities,
        sellingLiabilities: balance.selling_liabilities
      };
    });

    return {
      publicKey: this.treasuryKeypair.publicKey(),
      network: this.config.stellarNetwork,
      horizonUrl: this.config.horizonUrl,
      balances,
      asset: {
        code: this.config.usdcAssetCode,
        issuer: this.config.usdcIssuer
      }
    };
  }

  normalizeHorizonError(error) {
    const extras = error?.response?.data?.extras;
    if (extras?.result_codes) {
      const normalized = new Error(`Stellar transaction failed: ${JSON.stringify(extras.result_codes)}`);
      normalized.cause = error;
      normalized.resultCodes = extras.result_codes;
      return normalized;
    }

    return error;
  }
}

export function isIncomingUsdcOperation(operation, wallet, config) {
  if (!['payment', 'path_payment_strict_receive', 'path_payment_strict_send'].includes(operation.type)) {
    return false;
  }

  const destination = operation.to || operation.destination;
  if (destination !== wallet.public_key) {
    return false;
  }

  return (
    operation.asset_code === config.usdcAssetCode &&
    operation.asset_issuer === config.usdcIssuer &&
    operation.asset_type !== 'native' &&
    typeof operation.amount === 'string'
  );
}

export function operationToDeposit(operation, wallet, config) {
  return {
    id: cryptoRandomId(),
    walletId: wallet.id,
    network: config.stellarNetwork,
    externalUserId: wallet.external_user_id,
    amount: operation.amount,
    assetCode: config.usdcAssetCode,
    assetIssuer: config.usdcIssuer,
    fromAddress: operation.from || null,
    toAddress: operation.to || operation.destination,
    transactionHash: operation.transaction_hash,
    operationId: operation.id,
    pagingToken: operation.paging_token,
    ledger: operation.ledger_attr || operation.ledger || null,
    operationCreatedAt: operation.created_at || null,
    detectedAt: new Date().toISOString(),
    rawJson: JSON.stringify(operation)
  };
}

function cryptoRandomId() {
  return crypto.randomUUID();
}
