import { Keypair } from '@stellar/stellar-sdk';

const publicKey = process.argv[2];

if (!publicKey) {
  console.error('Usage: npm run fund:testnet -- <TREASURY_PUBLIC_KEY>');
  process.exit(1);
}

try {
  Keypair.fromPublicKey(publicKey);
} catch {
  console.error('Invalid Stellar public key.');
  process.exit(1);
}

const response = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);

if (!response.ok) {
  const body = await response.text();
  console.error(`Friendbot failed: ${response.status} ${body}`);
  process.exit(1);
}

const body = await response.json();
console.log(`Funded ${publicKey} on Stellar testnet.`);
console.log(`Transaction hash: ${body.hash}`);
