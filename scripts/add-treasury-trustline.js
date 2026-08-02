import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder
} from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const server = new Horizon.Server(config.horizonUrl);
const treasuryKeypair = Keypair.fromSecret(config.treasurySecret);
const usdcAsset = new Asset(config.usdcAssetCode, config.usdcIssuer);

const treasuryPublicKey = treasuryKeypair.publicKey();
const account = await server.loadAccount(treasuryPublicKey);

const existingTrustline = account.balances.find(
  (balance) =>
    balance.asset_type !== 'native' &&
    balance.asset_code === config.usdcAssetCode &&
    balance.asset_issuer === config.usdcIssuer
);

if (existingTrustline) {
  console.log(`Treasury ${treasuryPublicKey} already has a ${config.usdcAssetCode} trustline.`);
  console.log(`Balance: ${existingTrustline.balance}`);
  process.exit(0);
}

const transaction = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: config.networkPassphrase
})
  .addOperation(
    Operation.changeTrust({
      asset: usdcAsset
    })
  )
  .setTimeout(30)
  .build();

transaction.sign(treasuryKeypair);

const result = await server.submitTransaction(transaction);
console.log(`Added ${config.usdcAssetCode} trustline to treasury ${treasuryPublicKey}.`);
console.log(`Network: ${config.stellarNetwork}`);
console.log(`Asset issuer: ${config.usdcIssuer}`);
console.log(`Transaction hash: ${result.hash}`);
