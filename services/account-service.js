import crypto from 'crypto'

export function createAccountService({ db }) {
function createAccountSessionToken() {
  return crypto.randomBytes(32).toString('hex')
}

function hashAccountSessionToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex')
}

async function getAccountFromRequest(req) {
  const authorization =
    req.headers.authorization || ''

  if (!authorization.startsWith('Bearer ')) {
    return null
  }

  const token =
    authorization.slice(7).trim()

  if (!token) {
    return null
  }

  const tokenHash =
    hashAccountSessionToken(token)

  const result = await db.query(
    `
      SELECT
        u.id,
        u.google_id,
        u.email,
        u.name,
        u.picture
      FROM account_sessions s
      JOIN account_users u
        ON u.id = s.user_id
      WHERE
        s.token_hash = $1
        AND s.expires_at > NOW()
      LIMIT 1
    `,
    [tokenHash]
  )

  return result.rows[0] || null
}


app.use(
  createPlatformConnectionRouter({
    db,
    getAccountFromRequest,
    isValidInternalRequest
  })
)

// ------------------------------------------------------------
// EMAIL / PASSWORD AUTH
// Cadastro + verificação por código enviado pelo Resend
// ------------------------------------------------------------

const EMAIL_CODE_TTL_MINUTES = 10
const EMAIL_RESEND_COOLDOWN_SECONDS = 60
const EMAIL_MAX_ATTEMPTS = 5

function normalizeAccountEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function isValidAccountEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hashEmailVerificationCode(code) {
  return crypto
    .createHash('sha256')
    .update(String(code))
    .digest('hex')
}

function hashAccountPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16)

    crypto.scrypt(
      String(password),
      salt,
      64,
      { N: 16384, r: 8, p: 1 },
      (error, derivedKey) => {
        if (error) return reject(error)

        resolve(
          `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`
        )
      }
    )
  })
}

function verifyAccountPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const parts = String(storedHash || '').split('$')

    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return resolve(false)
    }

    let salt
    let expected

    try {
      salt = Buffer.from(parts[1], 'hex')
      expected = Buffer.from(parts[2], 'hex')
    } catch {
      return resolve(false)
    }

    if (!salt.length || !expected.length) {
      return resolve(false)
    }

    crypto.scrypt(
      String(password),
      salt,
      expected.length,
      { N: 16384, r: 8, p: 1 },
      (error, derivedKey) => {
        if (error) return reject(error)

        if (derivedKey.length !== expected.length) {
          return resolve(false)
        }

        resolve(
          crypto.timingSafeEqual(derivedKey, expected)
        )
      }
    )
  })
}

async function createAccountSession(userId) {
  const sessionToken = createAccountSessionToken()
  const tokenHash = hashAccountSessionToken(sessionToken)

  await db.query(
    `
      INSERT INTO account_sessions (
        user_id,
        token_hash,
        expires_at
      )
      VALUES (
        $1,
        $2,
        NOW() + INTERVAL '30 days'
      )
    `,
    [userId, tokenHash]
  )

  return sessionToken
}

async function sendAccountVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY
  const from =
    process.env.RESEND_FROM_EMAIL ||
    '1CE <no-reply@1ce.lol>'

  if (!apiKey) {
    throw new Error('RESEND_API_KEY não configurada.')
  }

  const response = await fetch(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Your 1CE verification code',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px;color:#111">
            <h1 style="font-size:24px;margin:0 0 18px">Verify your email</h1>
            <p style="font-size:16px;line-height:1.5">Use this code to finish creating your 1CE account:</p>
            <div style="font-size:36px;font-weight:700;letter-spacing:8px;margin:28px 0">${code}</div>
            <p style="font-size:14px;color:#666">This code expires in ${EMAIL_CODE_TTL_MINUTES} minutes.</p>
            <p style="font-size:14px;color:#666">If you did not request this code, you can ignore this email.</p>
          </div>
        `
      })
    }
  )

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    console.error('Resend error:', data)
    throw new Error(
      data?.message || `Resend respondeu HTTP ${response.status}`
    )
  }

  return data
}

async function sendPasswordResetEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL || '1CE <no-reply@1ce.lol>'

  if (!apiKey) throw new Error('RESEND_API_KEY não configurada.')

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Reset your 1CE password',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px;color:#111">
          <h1 style="font-size:24px;margin:0 0 18px">Reset your password</h1>
          <p style="font-size:16px;line-height:1.5">Use this code to reset your 1CE password:</p>
          <div style="font-size:36px;font-weight:700;letter-spacing:8px;margin:28px 0">${code}</div>
          <p style="font-size:14px;color:#666">This code expires in ${EMAIL_CODE_TTL_MINUTES} minutes.</p>
          <p style="font-size:14px;color:#666">If you did not request a password reset, you can ignore this email.</p>
        </div>
      `
    })
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error('Resend password reset error:', data)
    throw new Error(data?.message || `Resend respondeu HTTP ${response.status}`)
  }
  return data
}

async function issuePasswordResetCode(userId, email) {
  const code =
    String(
      crypto.randomInt(0, 1000000)
    ).padStart(6, '0')

  const codeHash =
    hashEmailVerificationCode(code)

  const client = await db.connect()
  let insertedId

  try {
    await client.query('BEGIN')

    await client.query(
      `
        SELECT id
        FROM account_users
        WHERE id = $1
        FOR UPDATE
      `,
      [userId]
    )

    const recent =
      await client.query(
        `
          SELECT created_at
          FROM account_password_resets
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [userId]
      )

    if (recent.rows.length) {
      const elapsed =
        Date.now() -
        new Date(
          recent.rows[0].created_at
        ).getTime()

      if (
        elapsed <
        EMAIL_RESEND_COOLDOWN_SECONDS * 1000
      ) {
        const error =
          new Error(
            'Please wait before requesting another code.'
          )

        error.statusCode = 429
        throw error
      }
    }

    await client.query(
      `
        UPDATE account_password_resets
        SET used_at = NOW()
        WHERE user_id = $1
          AND used_at IS NULL
      `,
      [userId]
    )

    const inserted =
      await client.query(
        `
          INSERT INTO account_password_resets (
            user_id,
            code_hash,
            expires_at
          )
          VALUES (
            $1,
            $2,
            NOW() + ($3 * INTERVAL '1 minute')
          )
          RETURNING id
        `,
        [
          userId,
          codeHash,
          EMAIL_CODE_TTL_MINUTES
        ]
      )

    insertedId =
      inserted.rows[0].id

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  try {
    await sendPasswordResetEmail(
      email,
      code
    )
  } catch (error) {
    await db.query(
      `
        DELETE FROM account_password_resets
        WHERE id = $1
      `,
      [insertedId]
    ).catch(() => {})

    throw error
  }
}

async function issueEmailVerificationCode(userId, email) {
  const code =
    String(
      crypto.randomInt(0, 1000000)
    ).padStart(6, '0')

  const codeHash =
    hashEmailVerificationCode(code)

  const client = await db.connect()
  let insertedId

  try {
    await client.query('BEGIN')

    await client.query(
      `
        SELECT id
        FROM account_users
        WHERE id = $1
        FOR UPDATE
      `,
      [userId]
    )

    const recent =
      await client.query(
        `
          SELECT created_at
          FROM account_email_verifications
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [userId]
      )

    if (recent.rows.length) {
      const elapsed =
        Date.now() -
        new Date(
          recent.rows[0].created_at
        ).getTime()

      if (
        elapsed <
        EMAIL_RESEND_COOLDOWN_SECONDS * 1000
      ) {
        const error =
          new Error(
            'Please wait before requesting another code.'
          )

        error.statusCode = 429
        throw error
      }
    }

    await client.query(
      `
        UPDATE account_email_verifications
        SET used_at = NOW()
        WHERE user_id = $1
          AND used_at IS NULL
      `,
      [userId]
    )

    const inserted =
      await client.query(
        `
          INSERT INTO account_email_verifications (
            user_id,
            code_hash,
            expires_at
          )
          VALUES (
            $1,
            $2,
            NOW() + ($3 * INTERVAL '1 minute')
          )
          RETURNING id
        `,
        [
          userId,
          codeHash,
          EMAIL_CODE_TTL_MINUTES
        ]
      )

    insertedId =
      inserted.rows[0].id

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  try {
    await sendAccountVerificationEmail(
      email,
      code
    )
  } catch (error) {
    await db.query(
      `
        DELETE FROM account_email_verifications
        WHERE id = $1
      `,
      [insertedId]
    ).catch(() => {})

    throw error
  }
}

const LOGIN_WINDOW_MINUTES = 15
const LOGIN_MAX_IP_ATTEMPTS = 30
const LOGIN_MAX_PAIR_ATTEMPTS = 8

function hashLoginRateValue(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getLoginRateState(email, req) {
  const emailHash =
    hashLoginRateValue(email)

  const ipHash =
    hashLoginRateValue(req.ip || req.socket?.remoteAddress || 'unknown')

  const result = await db.query(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE ip_hash = $2
        )::int AS ip_attempts,

        COUNT(*) FILTER (
          WHERE email_hash = $1
            AND ip_hash = $2
        )::int AS pair_attempts,

        COUNT(*) FILTER (
          WHERE email_hash = $1
        )::int AS email_attempts,

        MIN(created_at) FILTER (
          WHERE ip_hash = $2
        ) AS oldest_ip_attempt,

        MIN(created_at) FILTER (
          WHERE email_hash = $1
            AND ip_hash = $2
        ) AS oldest_pair_attempt
      FROM account_login_attempts
      WHERE created_at >
        NOW() - ($3 * INTERVAL '1 minute')
    `,
    [
      emailHash,
      ipHash,
      LOGIN_WINDOW_MINUTES
    ]
  )

  return {
    emailHash,
    ipHash,
    ...result.rows[0]
  }
}

function loginRetryAfterSeconds(oldestAttempt) {
  if (!oldestAttempt) return 60

  const elapsedSeconds =
    Math.floor(
      (Date.now() - new Date(oldestAttempt).getTime()) /
      1000
    )

  return Math.max(
    1,
    LOGIN_WINDOW_MINUTES * 60 - elapsedSeconds
  )
}

async function recordFailedLoginAttempt(emailHash, ipHash) {
  await db.query(
    `
      INSERT INTO account_login_attempts (
        email_hash,
        ip_hash
      )
      VALUES ($1, $2)
    `,
    [
      emailHash,
      ipHash
    ]
  )

  // Opportunistic cleanup keeps the table bounded without a separate job.
  if (Math.random() < 0.02) {
    db.query(
      `
        DELETE FROM account_login_attempts
        WHERE created_at < NOW() - INTERVAL '24 hours'
      `
    ).catch(() => {})
  }
}

function progressiveLoginDelay(attempts) {
  if (attempts < 2) return 0

  return Math.min(
    4000,
    250 * (2 ** Math.min(attempts - 2, 4))
  )
}

  return {
    createAccountSessionToken,
    hashAccountSessionToken,
    getAccountFromRequest,
    normalizeAccountEmail,
    isValidAccountEmail,
    hashEmailVerificationCode,
    hashAccountPassword,
    verifyAccountPassword,
    createAccountSession,
    issueEmailVerificationCode,
    issuePasswordResetCode,
    emailMaxAttempts: EMAIL_MAX_ATTEMPTS,
    getLoginRateState,
    loginMaxIpAttempts: LOGIN_MAX_IP_ATTEMPTS,
    loginMaxPairAttempts: LOGIN_MAX_PAIR_ATTEMPTS,
    loginRetryAfterSeconds,
    progressiveLoginDelay,
    sleep,
    recordFailedLoginAttempt
  }
}
