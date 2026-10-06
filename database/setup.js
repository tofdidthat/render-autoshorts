export function createDatabaseSetup({
  db,
  setupDesktopDatabase,
  setupPublicationDatabase,
  sleep = delayMs =>
    new Promise(resolve =>
      setTimeout(resolve, delayMs)
    )
}) {
  let ready = false

  function isReady() {
    return ready
  }

  async function setupDatabase() {
    ready = false
  
    try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_users (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE,
      email TEXT NOT NULL,
      password_hash TEXT,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      name TEXT,
      picture TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  
  // Prepara contas existentes para suportar Google OU Email/Senha.
  // Usuários que já entraram pelo Google têm o e-mail considerado verificado.
  await db.query(`
    ALTER TABLE account_users
    ALTER COLUMN google_id DROP NOT NULL
  `)
  
  await db.query(`
    ALTER TABLE account_users
    ADD COLUMN IF NOT EXISTS password_hash TEXT
  `)
  
  await db.query(`
    ALTER TABLE account_users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE
  `)
  
  await db.query(`
    UPDATE account_users
    SET email_verified = TRUE
    WHERE google_id IS NOT NULL
      AND email_verified = FALSE
  `)
  
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      account_users_email_lower_unique_idx
    ON account_users (LOWER(email))
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_email_verifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL
        REFERENCES account_users(id)
        ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_email_verifications_user_id_idx
    ON account_email_verifications(user_id)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL
        REFERENCES account_users(id)
        ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      reset_token_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      reset_token_expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_password_resets_user_id_idx
    ON account_password_resets(user_id)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_sessions (
      id SERIAL PRIMARY KEY,
  
      user_id INTEGER NOT NULL
        REFERENCES account_users(id)
        ON DELETE CASCADE,
  
      token_hash TEXT UNIQUE NOT NULL,
  
      created_at TIMESTAMPTZ
        DEFAULT NOW(),
  
      expires_at TIMESTAMPTZ
        NOT NULL
    )
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_login_attempts (
      id BIGSERIAL PRIMARY KEY,
      email_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS account_login_attempts_email_time_idx
    ON account_login_attempts(email_hash, created_at DESC)
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS account_login_attempts_ip_time_idx
    ON account_login_attempts(ip_hash, created_at DESC)
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS account_login_attempts_pair_time_idx
    ON account_login_attempts(email_hash, ip_hash, created_at DESC)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_google_login_attempts (
      state_hash TEXT PRIMARY KEY,
      verifier_challenge TEXT NOT NULL,
      user_id INTEGER
        REFERENCES account_users(id)
        ON DELETE CASCADE,
      exchange_hash TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      callback_used_at TIMESTAMPTZ,
      exchange_expires_at TIMESTAMPTZ,
      exchanged_at TIMESTAMPTZ
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS account_google_login_attempts_expiry_idx
    ON account_google_login_attempts(expires_at)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_oauth_transactions (
      transaction_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL
        REFERENCES account_users(id)
        ON DELETE CASCADE,
      provider TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS account_oauth_transactions_user_idx
    ON account_oauth_transactions(user_id)
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS account_oauth_transactions_expiry_idx
    ON account_oauth_transactions(expires_at)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS youtube_connections (
      id SERIAL PRIMARY KEY,
  
      user_id INTEGER NOT NULL UNIQUE
        REFERENCES account_users(id)
        ON DELETE CASCADE,
  
      access_token TEXT NOT NULL,
      refresh_token TEXT,
  
      scope TEXT,
      token_type TEXT DEFAULT 'Bearer',
  
      expires_at BIGINT,
  
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS
      youtube_connections_user_id_idx
    ON youtube_connections(user_id)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS tiktok_connections (
      id SERIAL PRIMARY KEY,
  
      user_id INTEGER NOT NULL UNIQUE
        REFERENCES account_users(id)
        ON DELETE CASCADE,
  
      open_id TEXT,
  
      access_token TEXT NOT NULL,
      refresh_token TEXT,
  
      scope TEXT,
      token_type TEXT DEFAULT 'Bearer',
  
      expires_at BIGINT,
      refresh_expires_at BIGINT,
  
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS
      tiktok_connections_user_id_idx
    ON tiktok_connections(user_id)
  `)
  
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS instagram_connections (
      id SERIAL PRIMARY KEY,
  
      user_id INTEGER NOT NULL UNIQUE
        REFERENCES account_users(id)
        ON DELETE CASCADE,
  
      instagram_user_id TEXT,
      page_id TEXT,
      page_name TEXT,
      username TEXT,
  
      access_token TEXT NOT NULL,
      token_type TEXT DEFAULT 'Bearer',
  
      expires_at BIGINT,
  
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  
  await db.query(`
    ALTER TABLE instagram_connections
    ADD COLUMN IF NOT EXISTS refresh_started_at TIMESTAMPTZ
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS
      instagram_connections_user_id_idx
    ON instagram_connections(user_id)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS meta_data_deletion_requests (
      confirmation_code TEXT PRIMARY KEY,
      meta_user_id TEXT NOT NULL,
      user_id INTEGER
        REFERENCES account_users(id)
        ON DELETE SET NULL,
      status TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS meta_data_deletion_requests_user_idx
    ON meta_data_deletion_requests(user_id)
  `)
      
  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_sessions_user_id_idx
    ON account_sessions(user_id)
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_sessions_expires_at_idx
    ON account_sessions(expires_at)
  `)
  
      
  await db.query(`
    CREATE TABLE IF NOT EXISTS stripe_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE
        REFERENCES account_users(id)
        ON DELETE CASCADE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'inactive',
      price_id TEXT,
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_idx
    ON stripe_subscriptions(stripe_customer_id)
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  
      await db.query(`
        CREATE TABLE IF NOT EXISTS telegram_connections (
          id SERIAL PRIMARY KEY,
          client_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          chat_title TEXT,
          thread_id TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(client_id, chat_id, thread_id)
        )
      `)
  
      await db.query(`
        CREATE TABLE IF NOT EXISTS telegram_connect_codes (
          code TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ
        )
      `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS discord_connections (
      id SERIAL PRIMARY KEY,
      client_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      guild_name TEXT,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(client_id, guild_id, channel_id)
    )
  `)
  
  await db.query(`
    CREATE TABLE IF NOT EXISTS discord_connect_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `)
      
    await setupDesktopDatabase(db)
    await setupPublicationDatabase(db)
    ready = true
    console.log('Telegram + Discord + Desktop database ready.')
    } catch (error) {
      ready = false
  
      console.error(
        'Database setup failed:',
        error
      )
  
      throw error
    }
  }

  async function initializeDatabaseWithRetry() {
    let attempt = 0
  
    while (!ready) {
      attempt += 1
  
      try {
        await setupDatabase()
  
        console.log(
          `Database ready after ${attempt} attempt(s).`
        )
  
        return
      } catch (error) {
        const delayMs =
          Math.min(
            30000,
            2000 * (2 ** Math.min(attempt - 1, 4))
          )
  
        console.error(
          `Database initialization attempt ${attempt} failed. Retrying in ${delayMs}ms.`
        )
  
        await sleep(delayMs)
      }
    }
  }

  return {
    isReady,
    setupDatabase,
    initializeDatabaseWithRetry
  }
}
