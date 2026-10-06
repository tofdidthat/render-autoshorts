import { Router } from 'express'
import crypto from 'node:crypto'

export function createPlatformConnectionRouter({
  db,
  getAccountFromRequest,
  isValidInternalRequest
}) {
  const router = Router()

function hashOAuthTransactionId(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
}

router.post('/account/oauth/start', async (req, res) => {
  try {
    const account = await getAccountFromRequest(req)

    if (!account) {
      return res.status(401).json({
        error: 'Invalid 1CE session.'
      })
    }

    const provider =
      String(req.body?.provider || '').toLowerCase()

    if (!['youtube', 'tiktok', 'instagram'].includes(provider)) {
      return res.status(400).json({
        error: 'Invalid OAuth provider.'
      })
    }

    const transactionId =
      crypto.randomBytes(32).toString('base64url')

    const transactionHash =
      hashOAuthTransactionId(transactionId)

    await db.query(
      `
        INSERT INTO account_oauth_transactions (
          transaction_hash,
          user_id,
          provider,
          expires_at
        )
        VALUES (
          $1,
          $2,
          $3,
          NOW() + INTERVAL '10 minutes'
        )
      `,
      [
        transactionHash,
        account.id,
        provider
      ]
    )

    return res.json({
      oauthId: transactionId
    })
  } catch (error) {
    console.error('OAuth transaction start error:', error)

    return res.status(500).json({
      error: 'Unable to start OAuth connection.'
    })
  }
})

router.post('/account/oauth/complete', async (req, res) => {
  if (!isValidInternalRequest(req)) {
    return res.status(401).json({
      error: 'Unauthorized internal request.'
    })
  }

  const oauthId =
    String(req.body?.oauthId || '').trim()

  const provider =
    String(req.body?.provider || '').toLowerCase()

  const connection =
    req.body?.connection || {}

  if (
    !oauthId ||
    !['youtube', 'tiktok', 'instagram'].includes(provider) ||
    !connection?.access_token
  ) {
    return res.status(400).json({
      error: 'Invalid OAuth completion request.'
    })
  }

  const client = await db.connect()

  try {
    await client.query('BEGIN')

    const transactionResult =
      await client.query(
        `
          SELECT user_id
          FROM account_oauth_transactions
          WHERE transaction_hash = $1
            AND provider = $2
            AND used_at IS NULL
            AND expires_at > NOW()
          LIMIT 1
          FOR UPDATE
        `,
        [
          hashOAuthTransactionId(oauthId),
          provider
        ]
      )

    if (!transactionResult.rows.length) {
      await client.query('ROLLBACK')

      return res.status(400).json({
        error: 'OAuth transaction expired or already used.'
      })
    }

    const userId =
      transactionResult.rows[0].user_id

    if (provider === 'youtube') {
      await client.query(
        `
          INSERT INTO youtube_connections (
            user_id,
            access_token,
            refresh_token,
            scope,
            token_type,
            expires_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(
              EXCLUDED.refresh_token,
              youtube_connections.refresh_token
            ),
            scope = EXCLUDED.scope,
            token_type = EXCLUDED.token_type,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
        `,
        [
          userId,
          connection.access_token,
          connection.refresh_token || null,
          connection.scope || null,
          connection.token_type || 'Bearer',
          connection.expires_at || null
        ]
      )
    }

    if (provider === 'tiktok') {
      await client.query(
        `
          INSERT INTO tiktok_connections (
            user_id,
            open_id,
            access_token,
            refresh_token,
            scope,
            token_type,
            expires_at,
            refresh_expires_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            open_id = EXCLUDED.open_id,
            access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(
              EXCLUDED.refresh_token,
              tiktok_connections.refresh_token
            ),
            scope = EXCLUDED.scope,
            token_type = EXCLUDED.token_type,
            expires_at = EXCLUDED.expires_at,
            refresh_expires_at = EXCLUDED.refresh_expires_at,
            updated_at = NOW()
        `,
        [
          userId,
          connection.open_id || null,
          connection.access_token,
          connection.refresh_token || null,
          connection.scope || null,
          connection.token_type || 'Bearer',
          connection.expires_at || null,
          connection.refresh_expires_at || null
        ]
      )
    }

    if (provider === 'instagram') {
      await client.query(
        `
          INSERT INTO instagram_connections (
            user_id,
            instagram_user_id,
            page_id,
            page_name,
            username,
            access_token,
            token_type,
            expires_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            instagram_user_id = EXCLUDED.instagram_user_id,
            page_id = EXCLUDED.page_id,
            page_name = EXCLUDED.page_name,
            username = EXCLUDED.username,
            access_token = EXCLUDED.access_token,
            token_type = EXCLUDED.token_type,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
        `,
        [
          userId,
          connection.instagram_user_id || null,
          connection.page_id || null,
          connection.page_name || null,
          connection.username || null,
          connection.access_token,
          connection.token_type || 'Bearer',
          connection.expires_at || null
        ]
      )
    }

    await client.query(
      `
        UPDATE account_oauth_transactions
        SET used_at = NOW()
        WHERE transaction_hash = $1
      `,
      [hashOAuthTransactionId(oauthId)]
    )

    await client.query('COMMIT')

    return res.json({
      connected: true
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    console.error('OAuth transaction completion error:', error)

    return res.status(500).json({
      error: 'Unable to complete OAuth connection.'
    })
  } finally {
    client.release()
  }
})




router.post(
  '/account/youtube/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const {
        access_token,
        refresh_token,
        scope,
        token_type,
        expires_at
      } = req.body || {}

      if (!access_token) {
        return res.status(400).json({
          error: 'access_token is required.'
        })
      }

      await db.query(
        `
          INSERT INTO youtube_connections (
            user_id,
            access_token,
            refresh_token,
            scope,
            token_type,
            expires_at,
            updated_at
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            NOW()
          )

          ON CONFLICT (user_id)

          DO UPDATE SET
            access_token =
              EXCLUDED.access_token,

            refresh_token =
              COALESCE(
                EXCLUDED.refresh_token,
                youtube_connections.refresh_token
              ),

            scope =
              EXCLUDED.scope,

            token_type =
              EXCLUDED.token_type,

            expires_at =
              EXCLUDED.expires_at,

            refresh_started_at = NULL,

            updated_at =
              NOW()
        `,
        [
          user.id,
          access_token,
          refresh_token || null,
          scope || null,
          token_type || 'Bearer',
          expires_at || null
        ]
      )

      return res.json({
        connected: true
      })

    } catch (error) {
      console.error(
        'YouTube connection save error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to save YouTube connection.'
      })
    }
  }
)


// ------------------------------------------------------------
// BUSCAR CONEXÃO YOUTUBE
// SOMENTE PARA SERVIÇO INTERNO
// ------------------------------------------------------------

router.get(
  '/account/youtube/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const result =
        await db.query(
          `
            SELECT
              access_token,
              refresh_token,
              scope,
              token_type,
              expires_at
            FROM youtube_connections
            WHERE user_id = $1
            LIMIT 1
          `,
          [user.id]
        )

      const connection =
        result.rows[0]

      if (!connection) {
        return res.json({
          connected: false
        })
      }

      return res.json({
        connected: true,

        connection: {
          access_token:
            connection.access_token,

          refresh_token:
            connection.refresh_token,

          scope:
            connection.scope,

          token_type:
            connection.token_type,

          expires_at:
            connection.expires_at
              ? Number(
                  connection.expires_at
                )
              : null
        }
      })

    } catch (error) {
      console.error(
        'YouTube connection get error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to get YouTube connection.'
      })
    }
  }
)


// ------------------------------------------------------------
// ATUALIZAR TOKENS APÓS REFRESH
// ------------------------------------------------------------

router.patch(
  '/account/youtube/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const {
        access_token,
        scope,
        token_type,
        expires_at
      } = req.body || {}

      if (!access_token) {
        return res.status(400).json({
          error: 'access_token is required.'
        })
      }

      const result =
        await db.query(
          `
            UPDATE youtube_connections

            SET
              access_token = $1,
              scope = $2,
              token_type = $3,
              expires_at = $4,
              updated_at = NOW()

            WHERE user_id = $5

            RETURNING id
          `,
          [
            access_token,
            scope || null,
            token_type || 'Bearer',
            expires_at || null,
            user.id
          ]
        )

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            'YouTube connection not found.'
        })
      }

      return res.json({
        updated: true
      })

    } catch (error) {
      console.error(
        'YouTube connection update error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to update YouTube connection.'
      })
    }
  }
)


// ------------------------------------------------------------
// DESCONECTAR YOUTUBE
// ------------------------------------------------------------

router.delete(
  '/account/youtube/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      await db.query(
        `
          DELETE FROM youtube_connections
          WHERE user_id = $1
        `,
        [user.id]
      )

      return res.json({
        disconnected: true
      })

    } catch (error) {
      console.error(
        'YouTube disconnect error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to disconnect YouTube.'
      })
    }
  }
)

// ============================================================
// 1CE - TIKTOK CONNECTION STORAGE
// Comunicação privada Vercel <-> Railway
// ============================================================

// ------------------------------------------------------------
// SALVAR / ATUALIZAR CONEXÃO TIKTOK
// ------------------------------------------------------------

router.post(
  '/account/tiktok/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const {
        open_id,
        access_token,
        refresh_token,
        scope,
        token_type,
        expires_at,
        refresh_expires_at
      } = req.body || {}

      if (!access_token) {
        return res.status(400).json({
          error: 'access_token is required.'
        })
      }

      await db.query(
        `
          INSERT INTO tiktok_connections (
            user_id,
            open_id,
            access_token,
            refresh_token,
            scope,
            token_type,
            expires_at,
            refresh_expires_at,
            updated_at
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NOW()
          )

          ON CONFLICT (user_id)

          DO UPDATE SET
            open_id =
              EXCLUDED.open_id,

            access_token =
              EXCLUDED.access_token,

            refresh_token =
              COALESCE(
                EXCLUDED.refresh_token,
                tiktok_connections.refresh_token
              ),

            scope =
              EXCLUDED.scope,

            token_type =
              EXCLUDED.token_type,

            expires_at =
              EXCLUDED.expires_at,

            refresh_expires_at =
              EXCLUDED.refresh_expires_at,

            updated_at =
              NOW()
        `,
        [
          user.id,
          open_id || null,
          access_token,
          refresh_token || null,
          scope || null,
          token_type || 'Bearer',
          expires_at || null,
          refresh_expires_at || null
        ]
      )

      return res.json({
        connected: true
      })

    } catch (error) {
      console.error(
        'TikTok connection save error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to save TikTok connection.'
      })
    }
  }
)

// ------------------------------------------------------------
// BUSCAR CONEXÃO TIKTOK
// SOMENTE PARA SERVIÇO INTERNO
// ------------------------------------------------------------

router.get(
  '/account/tiktok/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const result =
        await db.query(
          `
            SELECT
              open_id,
              access_token,
              refresh_token,
              scope,
              token_type,
              expires_at,
              refresh_expires_at
            FROM tiktok_connections
            WHERE user_id = $1
            LIMIT 1
          `,
          [user.id]
        )

      const connection =
        result.rows[0]

      if (!connection) {
        return res.json({
          connected: false
        })
      }

      return res.json({
        connected: true,

        connection: {
          open_id:
            connection.open_id,

          access_token:
            connection.access_token,

          refresh_token:
            connection.refresh_token,

          scope:
            connection.scope,

          token_type:
            connection.token_type,

          expires_at:
            connection.expires_at
              ? Number(connection.expires_at)
              : null,

          refresh_expires_at:
            connection.refresh_expires_at
              ? Number(connection.refresh_expires_at)
              : null
        }
      })

    } catch (error) {
      console.error(
        'TikTok connection get error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to get TikTok connection.'
      })
    }
  }
)

// ------------------------------------------------------------
// ATUALIZAR TOKENS TIKTOK APÓS REFRESH
// ------------------------------------------------------------

router.patch(
  '/account/tiktok/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const {
        access_token,
        refresh_token,
        scope,
        token_type,
        expires_at,
        refresh_expires_at
      } = req.body || {}

      if (!access_token) {
        return res.status(400).json({
          error: 'access_token is required.'
        })
      }

      const result =
        await db.query(
          `
            UPDATE tiktok_connections

            SET
              access_token = $1,

              refresh_token =
                COALESCE(
                  $2,
                  refresh_token
                ),

              scope = $3,
              token_type = $4,
              expires_at = $5,
              refresh_expires_at = $6,
              updated_at = NOW()

            WHERE user_id = $7

            RETURNING id
          `,
          [
            access_token,
            refresh_token || null,
            scope || null,
            token_type || 'Bearer',
            expires_at || null,
            refresh_expires_at || null,
            user.id
          ]
        )

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            'TikTok connection not found.'
        })
      }

      return res.json({
        updated: true
      })

    } catch (error) {
      console.error(
        'TikTok connection update error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to update TikTok connection.'
      })
    }
  }
)

// ------------------------------------------------------------
// DESCONECTAR TIKTOK
// ------------------------------------------------------------

router.delete(
  '/account/tiktok/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      await db.query(
        `
          DELETE FROM tiktok_connections
          WHERE user_id = $1
        `,
        [user.id]
      )

      return res.json({
        disconnected: true
      })

    } catch (error) {
      console.error(
        'TikTok disconnect error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to disconnect TikTok.'
      })
    }
  }
)


// ============================================================
// 1CE - INSTAGRAM CONNECTION STORAGE
// Comunicação privada Vercel <-> Railway
// ============================================================

// ------------------------------------------------------------
// SALVAR / ATUALIZAR CONEXÃO INSTAGRAM
// ------------------------------------------------------------

router.post(
  '/account/instagram/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const {
        instagram_user_id,
        page_id,
        page_name,
        username,
        access_token,
        token_type,
        expires_at
      } = req.body || {}

      if (!access_token) {
        return res.status(400).json({
          error: 'access_token is required.'
        })
      }

      await db.query(
        `
          INSERT INTO instagram_connections (
            user_id,
            instagram_user_id,
            page_id,
            page_name,
            username,
            access_token,
            token_type,
            expires_at,
            updated_at
          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            NOW()
          )

          ON CONFLICT (user_id)

          DO UPDATE SET
            instagram_user_id =
              EXCLUDED.instagram_user_id,

            page_id =
              EXCLUDED.page_id,

            page_name =
              EXCLUDED.page_name,

            username =
              EXCLUDED.username,

            access_token =
              EXCLUDED.access_token,

            token_type =
              EXCLUDED.token_type,

            expires_at =
              EXCLUDED.expires_at,

            updated_at =
              NOW()
        `,
        [
          user.id,
          instagram_user_id || null,
          page_id || null,
          page_name || null,
          username || null,
          access_token,
          token_type || 'Bearer',
          expires_at || null
        ]
      )

      return res.json({
        connected: true
      })

    } catch (error) {
      console.error(
        'Instagram connection save error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to save Instagram connection.'
      })
    }
  }
)


// ------------------------------------------------------------
// BUSCAR CONEXÃO INSTAGRAM
// SOMENTE PARA SERVIÇO INTERNO
// ------------------------------------------------------------

router.get(
  '/account/instagram/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const result =
        await db.query(
          `
            SELECT
              instagram_user_id,
              page_id,
              page_name,
              username,
              access_token,
              token_type,
              expires_at
            FROM instagram_connections
            WHERE user_id = $1
            LIMIT 1
          `,
          [user.id]
        )

      const connection =
        result.rows[0]

      if (!connection) {
        return res.json({
          connected: false
        })
      }

      return res.json({
        connected: true,

        connection: {
          instagram_user_id:
            connection.instagram_user_id,

          page_id:
            connection.page_id,

          page_name:
            connection.page_name,

          username:
            connection.username,

          access_token:
            connection.access_token,

          token_type:
            connection.token_type,

          expires_at:
            connection.expires_at
              ? Number(connection.expires_at)
              : null
        }
      })

    } catch (error) {
      console.error(
        'Instagram connection get error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to get Instagram connection.'
      })
    }
  }
)


// ------------------------------------------------------------
// ATUALIZAR TOKEN / DADOS INSTAGRAM
// ------------------------------------------------------------

router.patch(
  '/account/instagram/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const {
        instagram_user_id,
        page_id,
        page_name,
        username,
        access_token,
        token_type,
        expires_at
      } = req.body || {}

      if (!access_token) {
        return res.status(400).json({
          error: 'access_token is required.'
        })
      }

      const result =
        await db.query(
          `
            UPDATE instagram_connections

            SET
              instagram_user_id =
                COALESCE(
                  $1,
                  instagram_user_id
                ),

              page_id =
                COALESCE(
                  $2,
                  page_id
                ),

              page_name =
                COALESCE(
                  $3,
                  page_name
                ),

              username =
                COALESCE(
                  $4,
                  username
                ),

              access_token = $5,
              token_type = $6,
              expires_at = $7,
              refresh_started_at = NULL,
              updated_at = NOW()

            WHERE user_id = $8

            RETURNING id
          `,
          [
            instagram_user_id || null,
            page_id || null,
            page_name || null,
            username || null,
            access_token,
            token_type || 'Bearer',
            expires_at || null,
            user.id
          ]
        )

      if (!result.rowCount) {
        return res.status(404).json({
          error:
            'Instagram connection not found.'
        })
      }

      return res.json({
        updated: true
      })

    } catch (error) {
      console.error(
        'Instagram connection update error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to update Instagram connection.'
      })
    }
  }
)


// ------------------------------------------------------------
// INSTAGRAM TOKEN REFRESH LEASE
// Prevents concurrent refreshes across Vercel instances.
// ------------------------------------------------------------

router.post(
  '/account/instagram/refresh-lease',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const result =
        await db.query(
          `
            UPDATE instagram_connections
            SET refresh_started_at = NOW()
            WHERE user_id = $1
              AND (
                refresh_started_at IS NULL
                OR refresh_started_at <
                  NOW() - INTERVAL '2 minutes'
              )
            RETURNING
              access_token,
              token_type,
              expires_at
          `,
          [user.id]
        )

      if (!result.rowCount) {
        return res.json({
          claimed: false
        })
      }

      const connection =
        result.rows[0]

      return res.json({
        claimed: true,
        connection: {
          access_token:
            connection.access_token,
          token_type:
            connection.token_type,
          expires_at:
            connection.expires_at
              ? Number(connection.expires_at)
              : null
        }
      })

    } catch (error) {
      console.error(
        'Instagram refresh lease error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to claim Instagram refresh lease.'
      })
    }
  }
)

router.post(
  '/account/instagram/refresh-release',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      await db.query(
        `
          UPDATE instagram_connections
          SET refresh_started_at = NULL
          WHERE user_id = $1
        `,
        [user.id]
      )

      return res.json({
        released: true
      })

    } catch (error) {
      console.error(
        'Instagram refresh release error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to release Instagram refresh lease.'
      })
    }
  }
)



router.delete(
  '/account/instagram/connection',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      await db.query(
        `
          DELETE FROM instagram_connections
          WHERE user_id = $1
        `,
        [user.id]
      )

      return res.json({
        disconnected: true
      })

    } catch (error) {
      console.error(
        'Instagram disconnect error:',
        error
      )

      return res.status(500).json({
        error:
          'Failed to disconnect Instagram.'
      })
    }
  }
)



  return router
}
