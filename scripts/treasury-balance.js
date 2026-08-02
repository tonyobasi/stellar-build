import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const server = new Horizon.Server(config.horizonUrl);
const treasuryPublicKey = Keypair.fromSecret(config.treasurySecret).publicKey();

const account = await server.loadAccount(treasuryPublicKey);

console.log(`Treasury: ${treasuryPublicKey}`);
console.log(`Network: ${config.stellarNetwork}`);
console.log(`Horizon: ${config.horizonUrl}`);
console.log('');

for (const balance of account.balances) {
  if (balance.asset_type === 'native') {
    console.log(`XLM: ${balance.balance}`);
    continue;
  }

  const label = `${balance.asset_code}:${balance.asset_issuer}`;
  console.log(`${label}: ${balance.balance}`);
}
