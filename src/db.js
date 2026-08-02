import mysql from 'mysql2/promise';

const LOCK_PREFIX = 'stellar_usdc_wallet_service:';

function sqlLimit(value, fallback, max = 1000) {
  const numericValue = Number(value);
  const normalized = Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;

  return Math.min(Math.max(normalized, 1), max);
}

export async function createDatabase(config) {
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: config.mysql.connectionLimit,
    queueLimit: 0,
    namedPlaceholders: true,
    decimalNumbers: false,
    timezone: 'Z',
    ssl: config.mysql.ssl ? { rejectUnauthorized: true } : undefined
  });

  await migrate(pool);

  return pool;
}

async function migrate(pool) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id CHAR(36) PRIMARY KEY,
        external_user_id VARCHAR(128) NOT NULL,
        public_key CHAR(56) NOT NULL,
        encrypted_secret TEXT NOT NULL,
        network VARCHAR(16) NOT NULL,
        asset_code VARCHAR(12) NOT NULL,
        asset_issuer CHAR(56) NOT NULL,
        status ENUM('provisioning', 'ready', 'failed', 'disabled') NOT NULL,
        metadata_json JSON NULL,
        last_paging_token VARCHAR(128) NULL,
        error TEXT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_wallet_external_network (external_user_id, network),
        UNIQUE KEY uq_wallet_public_key (public_key),
        KEY idx_wallets_status (status),
        KEY idx_wallets_external_user_id (external_user_id),
        KEY idx_wallets_network_status (network, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id CHAR(36) PRIMARY KEY,
        wallet_id CHAR(36) NOT NULL,
        network VARCHAR(16) NOT NULL,
        external_user_id VARCHAR(128) NOT NULL,
        amount DECIMAL(30,7) NOT NULL,
        asset_code VARCHAR(12) NOT NULL,
        asset_issuer CHAR(56) NOT NULL,
        from_address CHAR(56) NULL,
        to_address CHAR(56) NOT NULL,
        transaction_hash CHAR(64) NOT NULL,
        operation_id VARCHAR(64) NOT NULL,
        paging_token VARCHAR(128) NOT NULL,
        ledger INT UNSIGNED NULL,
        operation_created_at DATETIME(3) NULL,
        detected_at DATETIME(3) NOT NULL,
        raw_json JSON NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_deposits_network_operation_id (network, operation_id),
        KEY idx_deposits_network (network),
        KEY idx_deposits_wallet_id (wallet_id),
        KEY idx_deposits_external_user_id (external_user_id),
        KEY idx_deposits_transaction_hash (transaction_hash),
        KEY idx_deposits_detected_at (detected_at),
        CONSTRAINT fk_deposits_wallets
          FOREIGN KEY (wallet_id) REFERENCES wallets(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await ensureColumn(
      connection,
      'deposits',
      'network',
      "ALTER TABLE deposits ADD COLUMN network VARCHAR(16) NOT NULL DEFAULT 'testnet' AFTER wallet_id"
    );
    await dropIndexIfExists(connection, 'deposits', 'uq_deposits_operation_id');
    await createIndexIfMissing(
      connection,
      'deposits',
      'uq_deposits_network_operation_id',
      'CREATE UNIQUE INDEX uq_deposits_network_operation_id ON deposits (network, operation_id)'
    );
    await createIndexIfMissing(
      connection,
      'deposits',
      'idx_deposits_network',
      'CREATE INDEX idx_deposits_network ON deposits (network)'
    );

    await connection.query(`
      CREATE TABLE IF NOT EXISTS sent_transactions (
        id CHAR(36) PRIMARY KEY,
        idempotency_key VARCHAR(191) NOT NULL,
        network VARCHAR(16) NOT NULL,
        source_type ENUM('treasury', 'wallet') NOT NULL,
        source_wallet_id CHAR(36) NULL,
        source_public_key CHAR(56) NOT NULL,
        destination_public_key CHAR(56) NOT NULL,
        amount DECIMAL(30,7) NOT NULL,
        asset_code VARCHAR(12) NOT NULL,
        asset_issuer CHAR(56) NOT NULL,
        memo_type ENUM('none', 'text', 'id', 'hash', 'return') NOT NULL DEFAULT 'none',
        memo_value VARCHAR(128) NULL,
        transaction_hash CHAR(64) NULL,
        operation_id VARCHAR(64) NULL,
        ledger INT UNSIGNED NULL,
        status ENUM('pending', 'submitted', 'failed') NOT NULL,
        error TEXT NULL,
        request_json JSON NULL,
        raw_json JSON NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        submitted_at DATETIME(3) NULL,
        UNIQUE KEY uq_sent_network_idempotency (network, idempotency_key),
        UNIQUE KEY uq_sent_transaction_hash (transaction_hash),
        KEY idx_sent_source_wallet_id (source_wallet_id),
        KEY idx_sent_source_public_key (source_public_key),
        KEY idx_sent_destination_public_key (destination_public_key),
        KEY idx_sent_status (status),
        KEY idx_sent_created_at (created_at),
        CONSTRAINT fk_sent_source_wallets
          FOREIGN KEY (source_wallet_id) REFERENCES wallets(id)
          ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id CHAR(36) PRIMARY KEY,
        namespace VARCHAR(64) NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL,
        request_hash CHAR(64) NOT NULL,
        resource_type VARCHAR(64) NULL,
        resource_id CHAR(36) NULL,
        status ENUM('processing', 'completed', 'failed') NOT NULL,
        response_json JSON NULL,
        locked_until DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_idempotency_namespace_key (namespace, idempotency_key),
        KEY idx_idempotency_resource (resource_type, resource_id),
        KEY idx_idempotency_status_locked_until (status, locked_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id CHAR(36) PRIMARY KEY,
        type VARCHAR(64) NOT NULL,
        deposit_id CHAR(36) NOT NULL,
        payload_json JSON NOT NULL,
        status ENUM('pending', 'delivered', 'failed', 'disabled') NOT NULL,
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        max_attempts INT UNSIGNED NOT NULL,
        next_attempt_at DATETIME(3) NULL,
        delivered_at DATETIME(3) NULL,
        last_error TEXT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_webhook_events_deposit_id (deposit_id),
        KEY idx_webhook_events_status_next_attempt (status, next_attempt_at),
        CONSTRAINT fk_webhook_events_deposits
          FOREIGN KEY (deposit_id) REFERENCES deposits(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS webhook_attempts (
        id CHAR(36) PRIMARY KEY,
        event_id CHAR(36) NOT NULL,
        attempt_number INT UNSIGNED NOT NULL,
        status_code INT NULL,
        response_body TEXT NULL,
        error TEXT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY idx_webhook_attempts_event_id (event_id),
        CONSTRAINT fk_webhook_attempts_events
          FOREIGN KEY (event_id) REFERENCES webhook_events(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(
      `
      INSERT IGNORE INTO schema_migrations (version, applied_at)
      VALUES ('001_mysql_core_schema', :appliedAt)
      `,
      { appliedAt: nowDate() }
    );
    await connection.query(
      `
      INSERT IGNORE INTO schema_migrations (version, applied_at)
      VALUES ('002_network_scoped_deposits', :appliedAt)
      `,
      { appliedAt: nowDate() }
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function ensureColumn(connection, tableName, columnName, alterSql) {
  const [rows] = await connection.query(
    `
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = :tableName
      AND COLUMN_NAME = :columnName
    `,
    { tableName, columnName }
  );

  if (Number(rows[0].count) === 0) {
    await connection.query(alterSql);
  }
}

async function dropIndexIfExists(connection, tableName, indexName) {
  const [rows] = await connection.query(
    `
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = :tableName
      AND INDEX_NAME = :indexName
    `,
    { tableName, indexName }
  );

  if (Number(rows[0].count) > 0) {
    await connection.query(`ALTER TABLE ${tableName} DROP INDEX ${indexName}`);
  }
}

async function createIndexIfMissing(connection, tableName, indexName, createSql) {
  const [rows] = await connection.query(
    `
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = :tableName
      AND INDEX_NAME = :indexName
    `,
    { tableName, indexName }
  );

  if (Number(rows[0].count) === 0) {
    await connection.query(createSql);
  }
}

export function createRepository(pool) {
  return new MySqlRepository(pool);
}

class MySqlRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async insertWallet(wallet) {
    await this.execute(
      `
      INSERT INTO wallets (
        id, external_user_id, public_key, encrypted_secret, network, asset_code, asset_issuer,
        status, metadata_json, last_paging_token, error, created_at, updated_at
      )
      VALUES (
        :id, :externalUserId, :publicKey, :encryptedSecret, :network, :assetCode, :assetIssuer,
        :status, :metadataJson, :lastPagingToken, :error, :createdAt, :updatedAt
      )
      `,
      wallet
    );

    return this.getWalletById(wallet.id);
  }

  async getWalletById(id) {
    return this.getOne('SELECT * FROM wallets WHERE id = :id', { id });
  }

  async getWalletByExternalUserId(externalUserId, network) {
    return this.getOne(
      'SELECT * FROM wallets WHERE external_user_id = :externalUserId AND network = :network',
      { externalUserId, network }
    );
  }

  async getWalletByPublicKey(publicKey, network) {
    return this.getOne(
      'SELECT * FROM wallets WHERE public_key = :publicKey AND network = :network',
      { publicKey, network }
    );
  }

  async listReadyWallets(limit = 1000) {
    const safeLimit = sqlLimit(limit, 1000, 1000);

    return this.getMany(
      `SELECT * FROM wallets WHERE status = :status ORDER BY created_at ASC LIMIT ${safeLimit}`,
      { status: 'ready' }
    );
  }

  async updateWalletStatus(id, status, error = null) {
    await this.execute(
      `
      UPDATE wallets
      SET status = :status, error = :error, updated_at = :updatedAt
      WHERE id = :id
      `,
      {
        id,
        status,
        error,
        updatedAt: nowDate()
      }
    );

    return this.getWalletById(id);
  }

  async markWalletReady(id, lastPagingToken = null) {
    await this.execute(
      `
      UPDATE wallets
      SET status = 'ready', error = NULL, last_paging_token = :lastPagingToken, updated_at = :updatedAt
      WHERE id = :id
      `,
      {
        id,
        lastPagingToken,
        updatedAt: nowDate()
      }
    );

    return this.getWalletById(id);
  }

  async updateWalletCursor(id, lastPagingToken) {
    await this.execute(
      `
      UPDATE wallets
      SET last_paging_token = :lastPagingToken, updated_at = :updatedAt
      WHERE id = :id
      `,
      {
        id,
        lastPagingToken,
        updatedAt: nowDate()
      }
    );
  }

  async insertDeposit(deposit) {
    const [result] = await this.pool.execute(
      `
      INSERT IGNORE INTO deposits (
        id, wallet_id, network, external_user_id, amount, asset_code, asset_issuer, from_address, to_address,
        transaction_hash, operation_id, paging_token, ledger, operation_created_at, detected_at, raw_json
      )
      VALUES (
        :id, :walletId, :network, :externalUserId, :amount, :assetCode, :assetIssuer, :fromAddress, :toAddress,
        :transactionHash, :operationId, :pagingToken, :ledger, :operationCreatedAt, :detectedAt, :rawJson
      )
      `,
      normalizeDeposit(deposit)
    );

    return result.affectedRows === 1;
  }

  async getDepositById(id) {
    return this.getOne('SELECT * FROM deposits WHERE id = :id', { id });
  }

  async listDeposits({ walletId, externalUserId, network, limit = 100 } = {}) {
    const safeLimit = sqlLimit(limit, 100, 500);

    if (walletId) {
      return this.getMany(
        `
        SELECT d.*, w.public_key AS wallet_public_key
        FROM deposits d
        JOIN wallets w ON w.id = d.wallet_id
        WHERE d.wallet_id = :walletId
          AND (:network IS NULL OR d.network = :network)
        ORDER BY d.detected_at DESC
        LIMIT ${safeLimit}
        `,
        { walletId, network: network || null }
      );
    }

    if (externalUserId) {
      return this.getMany(
        `
        SELECT d.*, w.public_key AS wallet_public_key
        FROM deposits d
        JOIN wallets w ON w.id = d.wallet_id
        WHERE d.external_user_id = :externalUserId
          AND (:network IS NULL OR d.network = :network)
        ORDER BY d.detected_at DESC
        LIMIT ${safeLimit}
        `,
        { externalUserId, network: network || null }
      );
    }

    return this.getMany(
      `
      SELECT d.*, w.public_key AS wallet_public_key
      FROM deposits d
      JOIN wallets w ON w.id = d.wallet_id
      WHERE (:network IS NULL OR d.network = :network)
      ORDER BY d.detected_at DESC
      LIMIT ${safeLimit}
      `,
      { network: network || null }
    );
  }

  async insertSentTransaction(transaction) {
    await this.execute(
      `
      INSERT INTO sent_transactions (
        id, idempotency_key, network, source_type, source_wallet_id, source_public_key,
        destination_public_key, amount, asset_code, asset_issuer, memo_type, memo_value,
        transaction_hash, operation_id, ledger, status, error, request_json, raw_json,
        created_at, updated_at, submitted_at
      )
      VALUES (
        :id, :idempotencyKey, :network, :sourceType, :sourceWalletId, :sourcePublicKey,
        :destinationPublicKey, :amount, :assetCode, :assetIssuer, :memoType, :memoValue,
        :transactionHash, :operationId, :ledger, :status, :error, :requestJson, :rawJson,
        :createdAt, :updatedAt, :submittedAt
      )
      `,
      normalizeSentTransaction(transaction)
    );

    return this.getSentTransactionById(transaction.id);
  }

  async getSentTransactionById(id) {
    return this.getOne('SELECT * FROM sent_transactions WHERE id = :id', { id });
  }

  async getSentTransactionByIdempotencyKey(network, idempotencyKey) {
    return this.getOne(
      `
      SELECT *
      FROM sent_transactions
      WHERE network = :network AND idempotency_key = :idempotencyKey
      `,
      { network, idempotencyKey }
    );
  }

  async listSentTransactions({ sourceWalletId, status, limit = 100 } = {}) {
    const safeLimit = sqlLimit(limit, 100, 500);

    if (sourceWalletId) {
      return this.getMany(
        `
        SELECT *
        FROM sent_transactions
        WHERE source_wallet_id = :sourceWalletId
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
        `,
        { sourceWalletId }
      );
    }

    if (status) {
      return this.getMany(
        `
        SELECT *
        FROM sent_transactions
        WHERE status = :status
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
        `,
        { status }
      );
    }

    return this.getMany(
      `
      SELECT *
      FROM sent_transactions
      ORDER BY created_at DESC
      LIMIT ${safeLimit}
      `,
      {}
    );
  }

  async markSentTransactionSubmitted(id, { transactionHash, operationId = null, ledger = null, rawJson = null }) {
    await this.execute(
      `
      UPDATE sent_transactions
      SET status = 'submitted', transaction_hash = :transactionHash, operation_id = :operationId,
          ledger = :ledger, raw_json = :rawJson, submitted_at = :submittedAt, updated_at = :updatedAt,
          error = NULL
      WHERE id = :id
      `,
      {
        id,
        transactionHash,
        operationId,
        ledger,
        rawJson: stringifyJson(rawJson),
        submittedAt: nowDate(),
        updatedAt: nowDate()
      }
    );

    return this.getSentTransactionById(id);
  }

  async markSentTransactionFailed(id, error) {
    await this.execute(
      `
      UPDATE sent_transactions
      SET status = 'failed', error = :error, updated_at = :updatedAt
      WHERE id = :id
      `,
      {
        id,
        error,
        updatedAt: nowDate()
      }
    );

    return this.getSentTransactionById(id);
  }

  async insertWebhookEvent(event) {
    const [result] = await this.pool.execute(
      `
      INSERT IGNORE INTO webhook_events (
        id, type, deposit_id, payload_json, status, attempts, max_attempts, next_attempt_at,
        delivered_at, last_error, created_at, updated_at
      )
      VALUES (
        :id, :type, :depositId, :payloadJson, :status, :attempts, :maxAttempts, :nextAttemptAt,
        :deliveredAt, :lastError, :createdAt, :updatedAt
      )
      `,
      normalizeWebhookEvent(event)
    );

    return result.affectedRows === 1;
  }

  async getWebhookEventByDepositId(depositId) {
    return this.getOne('SELECT * FROM webhook_events WHERE deposit_id = :depositId', { depositId });
  }

  async getWebhookEventById(id) {
    return this.getOne('SELECT * FROM webhook_events WHERE id = :id', { id });
  }

  async listDueWebhookEvents(now = nowDate(), limit = 50) {
    const safeLimit = sqlLimit(limit, 50, 500);

    return this.getMany(
      `
      SELECT *
      FROM webhook_events
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
      ORDER BY created_at ASC
      LIMIT ${safeLimit}
      `,
      { now }
    );
  }

  async recordWebhookAttempt(attempt) {
    await this.execute(
      `
      INSERT INTO webhook_attempts (
        id, event_id, attempt_number, status_code, response_body, error, created_at
      )
      VALUES (
        :id, :eventId, :attemptNumber, :statusCode, :responseBody, :error, :createdAt
      )
      `,
      attempt
    );
  }

  async markWebhookDelivered(id, attempts) {
    await this.execute(
      `
      UPDATE webhook_events
      SET status = 'delivered', attempts = :attempts, delivered_at = :deliveredAt,
          last_error = NULL, updated_at = :updatedAt
      WHERE id = :id
      `,
      {
        id,
        attempts,
        deliveredAt: nowDate(),
        updatedAt: nowDate()
      }
    );
  }

  async markWebhookFailedAttempt(id, { attempts, status, nextAttemptAt, lastError }) {
    await this.execute(
      `
      UPDATE webhook_events
      SET status = :status, attempts = :attempts, next_attempt_at = :nextAttemptAt,
          last_error = :lastError, updated_at = :updatedAt
      WHERE id = :id
      `,
      {
        id,
        attempts,
        status,
        nextAttemptAt,
        lastError,
        updatedAt: nowDate()
      }
    );
  }

  async resetWebhookEventForRetry(id) {
    await this.execute(
      `
      UPDATE webhook_events
      SET status = 'pending', next_attempt_at = :nextAttemptAt, last_error = NULL, updated_at = :updatedAt
      WHERE id = :id
      `,
      {
        id,
        nextAttemptAt: nowDate(),
        updatedAt: nowDate()
      }
    );

    return this.getWebhookEventById(id);
  }

  async createIdempotencyKey(record) {
    await this.execute(
      `
      INSERT INTO idempotency_keys (
        id, namespace, idempotency_key, request_hash, resource_type, resource_id,
        status, response_json, locked_until, created_at, updated_at
      )
      VALUES (
        :id, :namespace, :idempotencyKey, :requestHash, :resourceType, :resourceId,
        :status, :responseJson, :lockedUntil, :createdAt, :updatedAt
      )
      `,
      normalizeIdempotencyRecord(record)
    );

    return this.getIdempotencyKey(record.namespace, record.idempotencyKey);
  }

  async getIdempotencyKey(namespace, idempotencyKey) {
    return this.getOne(
      `
      SELECT *
      FROM idempotency_keys
      WHERE namespace = :namespace AND idempotency_key = :idempotencyKey
      `,
      { namespace, idempotencyKey }
    );
  }

  async completeIdempotencyKey(namespace, idempotencyKey, { resourceType, resourceId, responseJson }) {
    await this.execute(
      `
      UPDATE idempotency_keys
      SET status = 'completed', resource_type = :resourceType, resource_id = :resourceId,
          response_json = :responseJson, locked_until = NULL, updated_at = :updatedAt
      WHERE namespace = :namespace AND idempotency_key = :idempotencyKey
      `,
      {
        namespace,
        idempotencyKey,
        resourceType,
        resourceId,
        responseJson: stringifyJson(responseJson),
        updatedAt: nowDate()
      }
    );

    return this.getIdempotencyKey(namespace, idempotencyKey);
  }

  async failIdempotencyKey(namespace, idempotencyKey, responseJson = null) {
    await this.execute(
      `
      UPDATE idempotency_keys
      SET status = 'failed', response_json = :responseJson, locked_until = NULL, updated_at = :updatedAt
      WHERE namespace = :namespace AND idempotency_key = :idempotencyKey
      `,
      {
        namespace,
        idempotencyKey,
        responseJson: stringifyJson(responseJson),
        updatedAt: nowDate()
      }
    );

    return this.getIdempotencyKey(namespace, idempotencyKey);
  }

  async withNamedLock(name, timeoutSeconds, callback) {
    const lockName = `${LOCK_PREFIX}${name}`.slice(0, 64);
    const connection = await this.pool.getConnection();

    try {
      const [[lockResult]] = await connection.query('SELECT GET_LOCK(:lockName, :timeoutSeconds) AS acquired', {
        lockName,
        timeoutSeconds
      });

      if (lockResult.acquired !== 1) {
        return { acquired: false, result: null };
      }

      try {
        const result = await callback();
        return { acquired: true, result };
      } finally {
        await connection.query('SELECT RELEASE_LOCK(:lockName)', { lockName });
      }
    } finally {
      connection.release();
    }
  }

  async getOne(sql, params = {}) {
    const rows = await this.getMany(sql, params);
    return rows[0] || null;
  }

  async getMany(sql, params = {}) {
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async execute(sql, params = {}) {
    return this.pool.execute(sql, params);
  }
}

function normalizeDeposit(deposit) {
  return {
    ...deposit,
    rawJson: stringifyJson(deposit.rawJson),
    operationCreatedAt: normalizeDate(deposit.operationCreatedAt),
    detectedAt: normalizeDate(deposit.detectedAt)
  };
}

function normalizeSentTransaction(transaction) {
  return {
    ...transaction,
    requestJson: stringifyJson(transaction.requestJson),
    rawJson: stringifyJson(transaction.rawJson),
    createdAt: normalizeDate(transaction.createdAt),
    updatedAt: normalizeDate(transaction.updatedAt),
    submittedAt: normalizeDate(transaction.submittedAt)
  };
}

function normalizeWebhookEvent(event) {
  return {
    ...event,
    payloadJson: stringifyJson(event.payloadJson),
    nextAttemptAt: normalizeDate(event.nextAttemptAt),
    deliveredAt: normalizeDate(event.deliveredAt),
    createdAt: normalizeDate(event.createdAt),
    updatedAt: normalizeDate(event.updatedAt)
  };
}

function normalizeIdempotencyRecord(record) {
  return {
    ...record,
    responseJson: stringifyJson(record.responseJson),
    lockedUntil: normalizeDate(record.lockedUntil),
    createdAt: normalizeDate(record.createdAt),
    updatedAt: normalizeDate(record.updatedAt)
  };
}

function stringifyJson(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

export function nowDate() {
  return new Date();
}

export function nowIso() {
  return new Date().toISOString();
}
