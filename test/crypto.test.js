import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptString, encryptString, signWebhookPayload } from '../src/services/crypto.js';

test('encryptString and decryptString round trip a wallet secret', () => {
  const key = Buffer.alloc(32, 7);
  const secret = 'SAZ6EXAMPLESTELLARSECRETFORTESTONLY';
  const encrypted = encryptString(secret, key);

  assert.notEqual(encrypted, secret);
  assert.equal(decryptString(encrypted, key), secret);
});

test('signWebhookPayload is deterministic for the same timestamp and body', () => {
  const signature = signWebhookPayload('secret', '12345', '{"ok":true}');

  assert.equal(
    signature,
    'sha256=1aa65e7c414fe1617d49d4fdceb2d45caae6533e8e94c4c432f4aee72490383c'
  );
});
