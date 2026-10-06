import { Router } from 'express'
import crypto from 'node:crypto'

export function createAccountRouter({
  db,
  normalizeAccountEmail,
  isValidAccountEmail,
  hashAccountPassword,
  verifyAccountPassword,
  issueEmailVerificationCode,
  issuePasswordResetCode,
  hashEmailVerificationCode,
  emailMaxAttempts,
  createAccountSession,
  getLoginRateState,
  loginMaxIpAttempts,
  loginMaxPairAttempts,
  loginRetryAfterSeconds,
  progressiveLoginDelay,
  sleep,
  recordFailedLoginAttempt,
  getAccountFromRequest,
  stripePlanFromStatus,
  retrieveStripePrice,
  hashAccountSessionToken
}) {
  const router = Router()
  const EMAIL_MAX_ATTEMPTS = emailMaxAttempts
  const LOGIN_MAX_IP_ATTEMPTS = loginMaxIpAttempts
  const LOGIN_MAX_PAIR_ATTEMPTS = loginMaxPairAttempts

router.post('/account/email/register', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    const password = String(req.body?.password || '')
    const name = String(req.body?.name || '').trim().slice(0, 120)

    if (!isValidAccountEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' })
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: 'Password must contain between 8 and 128 characters.'
      })
    }

    const existing = await db.query(
      `
        SELECT id, password_hash, email_verified
        FROM account_users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    )

    let userId

    if (existing.rows.length) {
      const user = existing.rows[0]

      if (user.email_verified || user.password_hash) {
        return res.status(409).json({
          error: 'An account with this email already exists.'
        })
      }

      const passwordHash = await hashAccountPassword(password)

      const updated = await db.query(
        `
          UPDATE account_users
          SET password_hash = $1,
              name = COALESCE(NULLIF($2, ''), name),
              updated_at = NOW()
          WHERE id = $3
          RETURNING id
        `,
        [passwordHash, name, user.id]
      )

      userId = updated.rows[0].id
    } else {
      const passwordHash = await hashAccountPassword(password)

      const created = await db.query(
        `
          INSERT INTO account_users (
            email,
            password_hash,
            email_verified,
            name,
            updated_at
          )
          VALUES ($1, $2, FALSE, $3, NOW())
          RETURNING id
        `,
        [email, passwordHash, name]
      )

      userId = created.rows[0].id
    }

    await issueEmailVerificationCode(userId, email)

    return res.status(201).json({
      ok: true,
      verificationRequired: true,
      email
    })
  } catch (error) {
    console.error('Email register error:', error)

    return res
      .status(error?.statusCode || 500)
      .json({
        error:
          error?.statusCode === 429
            ? error.message
            : 'Unable to create account.'
      })
  }
})


router.post('/account/email/verify', async (req, res) => {
  const client = await db.connect()

  try {
    const email =
      normalizeAccountEmail(req.body?.email)

    const code =
      String(req.body?.code || '').trim()

    if (
      !isValidAccountEmail(email) ||
      !/^\d{6}$/.test(code)
    ) {
      return res.status(400).json({
        error: 'Invalid email or code.'
      })
    }

    await client.query('BEGIN')

    const userResult =
      await client.query(
        `
          SELECT id, email_verified
          FROM account_users
          WHERE LOWER(email) = $1
          LIMIT 1
          FOR UPDATE
        `,
        [email]
      )

    const user =
      userResult.rows[0]

    if (!user) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    if (user.email_verified) {
      await client.query('ROLLBACK')

      return res.status(409).json({
        error: 'Email is already verified.'
      })
    }

    const verificationResult =
      await client.query(
        `
          SELECT id, code_hash, attempts
          FROM account_email_verifications
          WHERE user_id = $1
            AND used_at IS NULL
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `,
        [user.id]
      )

    const verification =
      verificationResult.rows[0]

    if (!verification) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    if (
      verification.attempts >=
      EMAIL_MAX_ATTEMPTS
    ) {
      await client.query('ROLLBACK')

      return res.status(429).json({
        error:
          'Too many attempts. Request a new code.'
      })
    }

    const expected =
      Buffer.from(
        verification.code_hash,
        'hex'
      )

    const received =
      Buffer.from(
        hashEmailVerificationCode(code),
        'hex'
      )

    const valid =
      expected.length === received.length &&
      crypto.timingSafeEqual(
        expected,
        received
      )

    if (!valid) {
      const updated =
        await client.query(
          `
            UPDATE account_email_verifications
            SET attempts = attempts + 1
            WHERE id = $1
              AND used_at IS NULL
              AND attempts < $2
            RETURNING attempts
          `,
          [
            verification.id,
            EMAIL_MAX_ATTEMPTS
          ]
        )

      await client.query('COMMIT')

      if (
        updated.rows[0]?.attempts >=
        EMAIL_MAX_ATTEMPTS
      ) {
        return res.status(429).json({
          error:
            'Too many attempts. Request a new code.'
        })
      }

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    const consumed =
      await client.query(
        `
          UPDATE account_email_verifications
          SET used_at = NOW()
          WHERE id = $1
            AND used_at IS NULL
            AND expires_at > NOW()
          RETURNING id
        `,
        [verification.id]
      )

    if (!consumed.rowCount) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    await client.query(
      `
        UPDATE account_users
        SET email_verified = TRUE,
            updated_at = NOW()
        WHERE id = $1
      `,
      [user.id]
    )

    await client.query(
      `
        UPDATE account_email_verifications
        SET used_at = NOW()
        WHERE user_id = $1
          AND used_at IS NULL
      `,
      [user.id]
    )

    await client.query('COMMIT')

    const sessionToken =
      await createAccountSession(user.id)

    return res.json({
      ok: true,
      verified: true,
      session: sessionToken
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    console.error(
      'Email verification error:',
      error
    )

    return res.status(500).json({
      error: 'Unable to verify email.'
    })
  } finally {
    client.release()
  }
})


router.post('/account/email/resend', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)

    if (!isValidAccountEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' })
    }

    const result = await db.query(
      `
        SELECT id, email_verified, password_hash
        FROM account_users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    )

    if (!result.rows.length || result.rows[0].email_verified) {
      return res.json({ ok: true })
    }

    if (!result.rows[0].password_hash) {
      return res.json({ ok: true })
    }

    await issueEmailVerificationCode(result.rows[0].id, email)

    return res.json({ ok: true })
  } catch (error) {
    console.error('Email resend error:', error)

    return res
      .status(error?.statusCode || 500)
      .json({
        error:
          error?.statusCode === 429
            ? error.message
            : 'Unable to resend verification code.'
      })
  }
})


router.post('/account/password/forgot', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    if (!isValidAccountEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' })
    }

    const result = await db.query(
      `SELECT id FROM account_users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    )

    // Generic response prevents account enumeration.
    if (!result.rows.length) {
      return res.json({ ok: true })
    }

    await issuePasswordResetCode(result.rows[0].id, email)
    return res.json({ ok: true })
  } catch (error) {
    console.error('Password forgot error:', error)
    return res.status(error?.statusCode || 500).json({
      error: error?.statusCode === 429 ? error.message : 'Unable to request password reset.'
    })
  }
})


router.post('/account/password/verify', async (req, res) => {
  const client = await db.connect()

  try {
    const email =
      normalizeAccountEmail(req.body?.email)

    const code =
      String(req.body?.code || '').trim()

    if (
      !isValidAccountEmail(email) ||
      !/^\d{6}$/.test(code)
    ) {
      return res.status(400).json({
        error: 'Invalid email or code.'
      })
    }

    await client.query('BEGIN')

    const userResult =
      await client.query(
        `
          SELECT id
          FROM account_users
          WHERE LOWER(email) = $1
          LIMIT 1
          FOR UPDATE
        `,
        [email]
      )

    const user =
      userResult.rows[0]

    if (!user) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    const resetResult =
      await client.query(
        `
          SELECT id, code_hash, attempts
          FROM account_password_resets
          WHERE user_id = $1
            AND used_at IS NULL
            AND verified_at IS NULL
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `,
        [user.id]
      )

    const reset =
      resetResult.rows[0]

    if (!reset) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    if (
      reset.attempts >=
      EMAIL_MAX_ATTEMPTS
    ) {
      await client.query('ROLLBACK')

      return res.status(429).json({
        error:
          'Too many attempts. Request a new code.'
      })
    }

    const expected =
      Buffer.from(
        reset.code_hash,
        'hex'
      )

    const received =
      Buffer.from(
        hashEmailVerificationCode(code),
        'hex'
      )

    const valid =
      expected.length === received.length &&
      crypto.timingSafeEqual(
        expected,
        received
      )

    if (!valid) {
      const updated =
        await client.query(
          `
            UPDATE account_password_resets
            SET attempts = attempts + 1
            WHERE id = $1
              AND used_at IS NULL
              AND verified_at IS NULL
              AND attempts < $2
            RETURNING attempts
          `,
          [
            reset.id,
            EMAIL_MAX_ATTEMPTS
          ]
        )

      await client.query('COMMIT')

      if (
        updated.rows[0]?.attempts >=
        EMAIL_MAX_ATTEMPTS
      ) {
        return res.status(429).json({
          error:
            'Too many attempts. Request a new code.'
        })
      }

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    const resetToken =
      crypto.randomBytes(32).toString('hex')

    const resetTokenHash =
      crypto
        .createHash('sha256')
        .update(resetToken)
        .digest('hex')

    const consumed =
      await client.query(
        `
          UPDATE account_password_resets
          SET verified_at = NOW(),
              reset_token_hash = $1,
              reset_token_expires_at =
                NOW() + INTERVAL '10 minutes'
          WHERE id = $2
            AND used_at IS NULL
            AND verified_at IS NULL
            AND expires_at > NOW()
          RETURNING id
        `,
        [
          resetTokenHash,
          reset.id
        ]
      )

    if (!consumed.rowCount) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'Invalid or expired code.'
      })
    }

    await client.query('COMMIT')

    return res.json({
      ok: true,
      resetToken
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    console.error(
      'Password reset verify error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to verify reset code.'
    })
  } finally {
    client.release()
  }
})


router.post('/account/password/reset', async (req, res) => {
  const client = await db.connect()

  try {
    const resetToken =
      String(req.body?.resetToken || '')

    const password =
      String(req.body?.password || '')

    if (
      !resetToken ||
      password.length < 8 ||
      password.length > 128
    ) {
      return res.status(400).json({
        error:
          'Invalid reset token or password.'
      })
    }

    const resetTokenHash =
      crypto
        .createHash('sha256')
        .update(resetToken)
        .digest('hex')

    const passwordHash =
      await hashAccountPassword(password)

    await client.query('BEGIN')

    const resetResult =
      await client.query(
        `
          SELECT id, user_id
          FROM account_password_resets
          WHERE reset_token_hash = $1
            AND verified_at IS NOT NULL
            AND used_at IS NULL
            AND reset_token_expires_at > NOW()
          LIMIT 1
          FOR UPDATE
        `,
        [resetTokenHash]
      )

    const reset =
      resetResult.rows[0]

    if (!reset) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error:
          'Invalid or expired reset token.'
      })
    }

    const consumed =
      await client.query(
        `
          UPDATE account_password_resets
          SET used_at = NOW()
          WHERE id = $1
            AND used_at IS NULL
            AND reset_token_expires_at > NOW()
          RETURNING user_id
        `,
        [reset.id]
      )

    if (!consumed.rowCount) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error:
          'Invalid or expired reset token.'
      })
    }

    await client.query(
      `
        UPDATE account_users
        SET password_hash = $1,
            email_verified = TRUE,
            updated_at = NOW()
        WHERE id = $2
      `,
      [
        passwordHash,
        reset.user_id
      ]
    )

    await client.query(
      `
        DELETE FROM account_sessions
        WHERE user_id = $1
      `,
      [reset.user_id]
    )

    await client.query('COMMIT')

    return res.json({ ok: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    console.error(
      'Password reset error:',
      error
    )

    return res.status(500).json({
      error: 'Unable to reset password.'
    })
  } finally {
    client.release()
  }
})



router.post('/account/email/login', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    const password = String(req.body?.password || '')

    if (!isValidAccountEmail(email) || !password) {
      return res.status(401).json({
        error: 'Invalid email or password.'
      })
    }

    const rate =
      await getLoginRateState(email, req)

    if (
      rate.ip_attempts >= LOGIN_MAX_IP_ATTEMPTS ||
      rate.pair_attempts >= LOGIN_MAX_PAIR_ATTEMPTS
    ) {
      const retryAfter =
        rate.ip_attempts >= LOGIN_MAX_IP_ATTEMPTS
          ? loginRetryAfterSeconds(rate.oldest_ip_attempt)
          : loginRetryAfterSeconds(rate.oldest_pair_attempt)

      res.setHeader(
        'Retry-After',
        String(retryAfter)
      )

      console.warn('Password login rate limited', {
        ipAttempts: rate.ip_attempts,
        pairAttempts: rate.pair_attempts
      })

      return res.status(429).json({
        error:
          'Too many sign-in attempts. Please wait and try again.'
      })
    }

    const delay =
      progressiveLoginDelay(rate.email_attempts)

    if (delay) {
      await sleep(delay)
    }

    const result = await db.query(
      `
        SELECT id, password_hash, email_verified
        FROM account_users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    )

    const user = result.rows[0]

    if (!user || !user.password_hash) {
      await recordFailedLoginAttempt(
        rate.emailHash,
        rate.ipHash
      )

      return res.status(401).json({
        error: 'Invalid email or password.'
      })
    }

    const validPassword =
      await verifyAccountPassword(
        password,
        user.password_hash
      )

    if (!validPassword) {
      await recordFailedLoginAttempt(
        rate.emailHash,
        rate.ipHash
      )

      return res.status(401).json({
        error: 'Invalid email or password.'
      })
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Email verification required.',
        verificationRequired: true
      })
    }

    // A successful login clears account-specific failures, while
    // unrelated IP abuse remains visible for rate limiting.
    await db.query(
      `
        DELETE FROM account_login_attempts
        WHERE email_hash = $1
      `,
      [rate.emailHash]
    )

    const sessionToken =
      await createAccountSession(user.id)

    return res.json({
      ok: true,
      session: sessionToken
    })
  } catch (error) {
    console.error('Email login error:', error)

    return res.status(500).json({
      error: 'Unable to sign in.'
    })
  }
})



router.get(
  '/account/me',

  async (req, res) => {
    try {
      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res
          .status(401)
          .json({
            authenticated: false
          })
      }

      const subscriptionResult = await db.query(
        `
          SELECT
            status,
            stripe_customer_id,
            stripe_subscription_id,
            price_id,
            current_period_end,
            cancel_at_period_end
          FROM stripe_subscriptions
          WHERE user_id = $1
          LIMIT 1
        `,
        [user.id]
      )

      const subscription =
        subscriptionResult.rows[0] || null

      const plan =
        stripePlanFromStatus(
          subscription?.status
        )

      let price = null

      if (subscription?.price_id) {
        try {
          const stripePrice =
            await retrieveStripePrice(
              subscription.price_id
            )

          price = {
            id: stripePrice.id,
            unitAmount:
              Number.isFinite(
                Number(stripePrice.unit_amount)
              )
                ? Number(stripePrice.unit_amount)
                : null,
            currency:
              stripePrice.currency || null,
            interval:
              stripePrice.recurring?.interval || null,
            intervalCount:
              stripePrice.recurring?.interval_count || null
          }
        } catch (error) {
          console.warn(
            'Unable to retrieve Stripe price for account:',
            error?.message || error
          )
        }
      }

      res.json({
        authenticated: true,
        plan,
        subscription: subscription
          ? {
              status:
                subscription.status,
              priceId:
                subscription.price_id,
              currentPeriodEnd:
                subscription.current_period_end,
              cancelAtPeriodEnd:
                subscription.cancel_at_period_end,
              hasStripeCustomer:
                Boolean(
                  subscription.stripe_customer_id
                ),
              hasStripeSubscription:
                Boolean(
                  subscription.stripe_subscription_id
                ),
              price
            }
          : null,

        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
          plan
        }
      })

    } catch (error) {
      console.error(
        'Account me error:',
        error
      )

      res.status(500).json({
        error:
          'Falha ao verificar conta.'
      })
    }
  }
)



router.post(
  '/account/logout',

  async (req, res) => {
    try {
      const authorization =
        req.headers.authorization || ''

      if (
        authorization.startsWith(
          'Bearer '
        )
      ) {
        const token =
          authorization
            .slice(7)
            .trim()

        if (token) {
          const tokenHash =
            hashAccountSessionToken(
              token
            )

          await db.query(
            `
              DELETE FROM account_sessions
              WHERE token_hash = $1
            `,
            [tokenHash]
          )
        }
      }

      res.json({
        ok: true
      })

    } catch (error) {
      console.error(
        'Account logout error:',
        error
      )

      res.status(500).json({
        error:
          'Falha ao encerrar sessão.'
      })
    }
  }
)



  return router
}
