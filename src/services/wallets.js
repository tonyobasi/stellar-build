import crypto from 'node:crypto';
import { ApiError } from '../errors.js';
import { nowDate } from '../db.js';
import { decryptString, encryptString } from './crypto.js';

export class WalletService {
  constructor({ config, repository, stellarService, logger }) {
    this.config = config;
    this.repository = repository;
    this.stellarService = stellarService;
    this.logger = logger;
  }

  async getOrCreateWallet({ externalUserId, metadata = null }) {
    const existing = await this.repository.getWalletByExternalUserId(
      externalUserId,
      this.config.stellarNetwork
    );

    if (existing) {
      return this.ensureWalletReady(existing);
    }

    const keypair = this.stellarService.generateKeypair();
    const createdAt = nowDate();
    const wallet = {
      id: crypto.randomUUID(),
      externalUserId,
      publicKey: keypair.publicKey(),
      encryptedSecret: encryptString(keypair.secret(), this.config.walletEncryptionKey),
      network: this.config.stellarNetwork,
      assetCode: this.config.usdcAssetCode,
      assetIssuer: this.config.usdcIssuer,
      status: 'provisioning',
      metadataJson: metadata ? JSON.stringify(metadata) : null,
      lastPagingToken: null,
      error: null,
      createdAt,
      updatedAt: createdAt
    };

    let row;
    try {
      row = await this.repository.insertWallet(wallet);
    } catch (error) {
      const raced = await this.repository.getWalletByExternalUserId(
        externalUserId,
        this.config.stellarNetwork
      );
      if (raced) {
        return this.ensureWalletReady(raced);
      }

      throw error;
    }

    return this.ensureWalletReady(row);
  }

  async ensureWalletReady(wallet) {
    if (!wallet) {
      throw new ApiError(404, 'Wallet not found');
    }

    if (wallet.network !== this.config.stellarNetwork) {
      throw new ApiError(409, 'Wallet belongs to a different Stellar network');
    }

    if (wallet.status === 'ready') {
      return wallet;
    }

    await this.repository.updateWalletStatus(wallet.id, 'provisioning');

    try {
      const secret = decryptString(wallet.encrypted_secret, this.config.walletEncryptionKey);
      const lastPagingToken = await this.stellarService.provisionWallet(wallet.public_key, secret);
      return await this.repository.markWalletReady(wallet.id, lastPagingToken);
    } catch (error) {
      await this.repository.updateWalletStatus(wallet.id, 'failed', error.message);
      this.logger.error({ err: error, walletId: wallet.id }, 'wallet provisioning failed');
      throw new ApiError(502, 'Failed to provision Stellar wallet', {
        walletId: wallet.id,
        reason: error.message
      });
    }
  }

  async getWalletById(id) {
    const wallet = await this.repository.getWalletById(id);
    if (!wallet) {
      throw new ApiError(404, 'Wallet not found');
    }

    return wallet;
  }

  async getWalletByExternalUserId(externalUserId) {
    const wallet = await this.repository.getWalletByExternalUserId(
      externalUserId,
      this.config.stellarNetwork
    );

    if (!wallet) {
      throw new ApiError(404, 'Wallet not found');
    }

    return wallet;
  }
}

export function serializeWallet(wallet) {
  return {
    id: wallet.id,
    externalUserId: wallet.external_user_id,
    publicKey: wallet.public_key,
    network: wallet.network,
    asset: {
      code: wallet.asset_code,
      issuer: wallet.asset_issuer
    },
    status: wallet.status,
    metadata: parseJsonColumn(wallet.metadata_json),
    lastPagingToken: wallet.last_paging_token,
    error: wallet.error,
    createdAt: wallet.created_at,
    updatedAt: wallet.updated_at
  };
}

function parseJsonColumn(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return JSON.parse(value);
  }

  return value;
}
