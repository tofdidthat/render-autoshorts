import { Router } from 'express'
import crypto from 'node:crypto'

export function createGoogleAuthRouter({
  db,
  normalizeAccountEmail,
  createAccountSessionToken,
  hashAccountSessionToken,
  startDesktopGoogle,
  consumeDesktopGoogle,
  publicationService,
  isDesktopReady,
  frontendUrl,
  fetcher = (...args) =>
    globalThis.fetch(...args)
}) {
  const router = Router()

  const fetch = (...args) =>
    fetcher(...args)

function hashGoogleLoginValue(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
}

function googleVerifierChallenge(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('base64url')
}

function getRequestCookie(req, name) {
  const raw =
    String(req.headers.cookie || '')

  for (const part of raw.split(';')) {
    const index = part.indexOf('=')

    if (index === -1) continue

    const key =
      part.slice(0, index).trim()

    if (key !== name) continue

    return decodeURIComponent(
      part.slice(index + 1).trim()
    )
  }

  return ''
}

router.post('/account/google/exchange', async (req, res) => {
  const loginCode =
    String(req.body?.loginCode || '').trim()

  const verifier =
    String(req.body?.verifier || '').trim()

  if (
    !/^[A-Za-z0-9_-]{43}$/.test(loginCode) ||
    !/^[A-Za-z0-9_-]{43}$/.test(verifier)
  ) {
    return res.status(400).json({
      error: 'Invalid Google login exchange.'
    })
  }

  const client = await db.connect()

  try {
    await client.query('BEGIN')

    const result = await client.query(
      `
        SELECT
          user_id,
          verifier_challenge
        FROM account_google_login_attempts
        WHERE exchange_hash = $1
          AND user_id IS NOT NULL
          AND callback_used_at IS NOT NULL
          AND exchanged_at IS NULL
          AND exchange_expires_at > NOW()
        LIMIT 1
        FOR UPDATE
      `,
      [hashGoogleLoginValue(loginCode)]
    )

    const attempt = result.rows[0]

    if (
      !attempt ||
      googleVerifierChallenge(verifier) !== attempt.verifier_challenge
    ) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'Google login exchange expired or invalid.'
      })
    }

    const sessionToken =
      createAccountSessionToken()

    const tokenHash =
      hashAccountSessionToken(sessionToken)

    await client.query(
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
      [
        attempt.user_id,
        tokenHash
      ]
    )

    await client.query(
      `
        UPDATE account_google_login_attempts
        SET exchanged_at = NOW()
        WHERE exchange_hash = $1
      `,
      [hashGoogleLoginValue(loginCode)]
    )

    await client.query('COMMIT')

    return res.json({
      ok: true,
      session: sessionToken
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    console.error('Google login exchange error:', error)

    return res.status(500).json({
      error: 'Unable to complete Google login.'
    })
  } finally {
    client.release()
  }
})

// ------------------------------------------------------------
// INICIA LOGIN GOOGLE
// ------------------------------------------------------------

router.get(
  '/account/google',
  async (req, res) => {
    const clientId =
      process.env.GOOGLE_ACCOUNT_CLIENT_ID

    const backendUrl =
      process.env.BACKEND_PUBLIC_URL

    if (!clientId || !backendUrl) {
      return res.status(500).json({
        error:
          'Google Account Login não configurado.'
      })
    }

    let state

    if (
      req.query.desktop_user_code !== undefined ||
      req.query.desktop_publication !== undefined
    ) {
      if (!isDesktopReady()) return res.sendStatus(503)

      try {
        state = await startDesktopGoogle(req, res, db)
      } catch {
        return res.status(400).json({
          error: 'Invalid desktop authorization.'
        })
      }
    } else {
      const verifierChallenge =
        String(req.query.challenge || '').trim()

      if (!/^[A-Za-z0-9_-]{43}$/.test(verifierChallenge)) {
        return res.status(400).json({
          error: 'Invalid Google login challenge.'
        })
      }

      state =
        crypto.randomBytes(32).toString('base64url')

      await db.query(
        `
          INSERT INTO account_google_login_attempts (
            state_hash,
            verifier_challenge,
            expires_at
          )
          VALUES (
            $1,
            $2,
            NOW() + INTERVAL '10 minutes'
          )
        `,
        [
          hashGoogleLoginValue(state),
          verifierChallenge
        ]
      )

      res.cookie(
        'onece_google_login_state',
        state,
        {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAge: 10 * 60 * 1000,
          path: '/account/google'
        }
      )
    }

    const params =
      new URLSearchParams({
        client_id: clientId,

        redirect_uri:
          `${backendUrl}/account/google/callback`,

        response_type: 'code',

        scope:
          'openid email profile',

        state,

        access_type: 'online',

        prompt: 'select_account'
      })

    res.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
    )
  }
)


// ------------------------------------------------------------
// CALLBACK GOOGLE
// ------------------------------------------------------------

router.get(
  '/account/google/callback',

  async (req, res) => {
    try {
      const receivedState =
        String(req.query.state || '')

      const desktopState =
        receivedState.startsWith('desktop_')

      const desktopCode =
        desktopState
          ? await consumeDesktopGoogle(req, res, db)
          : null

      let normalLoginAttempt = null

      if (!desktopState) {
        const cookieState =
          getRequestCookie(
            req,
            'onece_google_login_state'
          )

        if (
          !receivedState ||
          !cookieState ||
          receivedState.length !== cookieState.length ||
          !crypto.timingSafeEqual(
            Buffer.from(receivedState),
            Buffer.from(cookieState)
          )
        ) {
          return res.redirect(
            `${frontendUrl()}/app?login=error`
          )
        }

        const claimed = await db.query(
          `
            UPDATE account_google_login_attempts
            SET callback_used_at = NOW()
            WHERE state_hash = $1
              AND callback_used_at IS NULL
              AND expires_at > NOW()
            RETURNING verifier_challenge
          `,
          [hashGoogleLoginValue(receivedState)]
        )

        normalLoginAttempt =
          claimed.rows[0] || null

        if (!normalLoginAttempt) {
          return res.redirect(
            `${frontendUrl()}/app?login=error`
          )
        }
      }

      const code =
        String(req.query.code || '')

      if (!code) {
        return res.redirect(
          `${frontendUrl()}/app?login=error`
        )
      }

      const clientId =
        process.env.GOOGLE_ACCOUNT_CLIENT_ID

      const clientSecret =
        process.env.GOOGLE_ACCOUNT_CLIENT_SECRET

      const backendUrl =
        process.env.BACKEND_PUBLIC_URL

      if (
        !clientId ||
        !clientSecret ||
        !backendUrl
      ) {
        throw new Error(
          'Variáveis do Google Account Login ausentes.'
        )
      }

      // Troca authorization code por tokens
      const tokenResponse =
        await fetch(
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded'
            },

            body:
              new URLSearchParams({
                code,

                client_id:
                  clientId,

                client_secret:
                  clientSecret,

                redirect_uri:
                  `${backendUrl}/account/google/callback`,

                grant_type:
                  'authorization_code'
              })
          }
        )

      const tokenData =
        await tokenResponse
          .json()
          .catch(() => ({}))

      if (
        !tokenResponse.ok ||
        !tokenData.access_token
      ) {
        console.error(
          'Google token error:',
          tokenData
        )

        throw new Error(
          'Falha ao obter token do Google.'
        )
      }

      // Busca perfil básico da conta
      const userResponse =
        await fetch(
          'https://openidconnect.googleapis.com/v1/userinfo',
          {
            headers: {
              Authorization:
                `Bearer ${tokenData.access_token}`
            }
          }
        )

      const googleUser =
        await userResponse
          .json()
          .catch(() => ({}))

      if (
        !userResponse.ok ||
        !googleUser.sub ||
        !googleUser.email ||
        googleUser.email_verified !== true
      ) {
        console.error(
          'Google userinfo error:',
          googleUser
        )

        throw new Error(
          'Não foi possível obter a conta Google.'
        )
      }

      // Cria, atualiza ou vincula usuário 1CE.
      // Um cadastro por e-mail ainda não verificado não pode preservar
      // credenciais criadas antes de o verdadeiro dono entrar pelo Google.
      const googleEmail =
        normalizeAccountEmail(googleUser.email)

      const client = await db.connect()
      let userId

      try {
        await client.query('BEGIN')

        const existingByGoogle =
          await client.query(
            `
              SELECT id, email
              FROM account_users
              WHERE google_id = $1
              LIMIT 1
              FOR UPDATE
            `,
            [googleUser.sub]
          )

        if (existingByGoogle.rows.length) {
          userId = existingByGoogle.rows[0].id

          await client.query(
            `
              UPDATE account_users
              SET email = $1,
                  name = $2,
                  picture = $3,
                  email_verified = TRUE,
                  updated_at = NOW()
              WHERE id = $4
            `,
            [
              googleEmail,
              googleUser.name || '',
              googleUser.picture || '',
              userId
            ]
          )
        } else {
          const existingByEmail =
            await client.query(
              `
                SELECT id, google_id, email_verified
                FROM account_users
                WHERE LOWER(email) = $1
                LIMIT 1
                FOR UPDATE
              `,
              [googleEmail]
            )

          if (existingByEmail.rows.length) {
            const existingUser = existingByEmail.rows[0]

            if (
              existingUser.google_id &&
              existingUser.google_id !== googleUser.sub
            ) {
              throw new Error(
                'Este e-mail já está vinculado a outra conta Google.'
              )
            }

            userId = existingUser.id

            if (!existingUser.email_verified) {
              // A senha e os códigos pertencem a um cadastro cuja posse do
              // e-mail nunca foi provada. O Google verificado passa a ser a
              // primeira prova válida de propriedade dessa conta.
              await client.query(
                `
                  UPDATE account_users
                  SET password_hash = NULL
                  WHERE id = $1
                `,
                [userId]
              )

              await client.query(
                `
                  DELETE FROM account_email_verifications
                  WHERE user_id = $1
                `,
                [userId]
              )

              await client.query(
                `
                  DELETE FROM account_password_resets
                  WHERE user_id = $1
                `,
                [userId]
              )

              await client.query(
                `
                  DELETE FROM account_sessions
                  WHERE user_id = $1
                `,
                [userId]
              )
            }

            await client.query(
              `
                UPDATE account_users
                SET google_id = $1,
                    name = COALESCE(NULLIF($2, ''), name),
                    picture = COALESCE(NULLIF($3, ''), picture),
                    email_verified = TRUE,
                    updated_at = NOW()
                WHERE id = $4
              `,
              [
                googleUser.sub,
                googleUser.name || '',
                googleUser.picture || '',
                userId
              ]
            )
          } else {
            const created =
              await client.query(
                `
                  INSERT INTO account_users (
                    google_id,
                    email,
                    name,
                    picture,
                    email_verified,
                    updated_at
                  )
                  VALUES ($1, $2, $3, $4, TRUE, NOW())
                  RETURNING id
                `,
                [
                  googleUser.sub,
                  googleEmail,
                  googleUser.name || '',
                  googleUser.picture || ''
                ]
              )

            userId = created.rows[0].id
          }
        }

        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      if (desktopCode) {
        // Desktop keeps its existing dedicated authorization flow.
        const sessionToken =
          createAccountSessionToken()

        const tokenHash =
          hashAccountSessionToken(
            sessionToken
          )

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
          [
            userId,
            tokenHash
          ]
        )

        if (desktopCode.startsWith('publishapp:')) {
          return res.redirect(publicationService.reviewOrigin()+'/app?desktopPublication='+encodeURIComponent(desktopCode.slice(11))+
            '#session='+encodeURIComponent(sessionToken))
        }

        if (desktopCode.startsWith('publish:')) {
          return res.redirect('/api/desktop/publish?request='+encodeURIComponent(desktopCode.slice(8))+
            '#session='+encodeURIComponent(sessionToken))
        }

        return res.redirect(
          '/api/desktop/connect?user_code=' + encodeURIComponent(desktopCode) +
          '#session=' + encodeURIComponent(sessionToken)
        )
      }

      const loginCode =
        crypto.randomBytes(32).toString('base64url')

      const exchangeResult =
        await db.query(
          `
            UPDATE account_google_login_attempts
            SET
              user_id = $1,
              exchange_hash = $2,
              exchange_expires_at =
                NOW() + INTERVAL '5 minutes'
            WHERE state_hash = $3
              AND callback_used_at IS NOT NULL
              AND exchanged_at IS NULL
            RETURNING state_hash
          `,
          [
            userId,
            hashGoogleLoginValue(loginCode),
            hashGoogleLoginValue(receivedState)
          ]
        )

      if (!exchangeResult.rowCount) {
        throw new Error(
          'Google login attempt could not be completed.'
        )
      }

      res.clearCookie(
        'onece_google_login_state',
        {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/account/google'
        }
      )

      res.redirect(
        `${frontendUrl()}/app?login_code=${encodeURIComponent(loginCode)}`
      )

    } catch (error) {
      console.error(
        '1CE Google login error:',
        error
      )

      res.redirect(
        `${frontendUrl()}/app?login=error`
      )
    }
  }
)




  return router
}
