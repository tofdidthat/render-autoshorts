import express from 'express'

export function createMetaRouter({
  db,
  isValidInternalRequest
}) {
  const router = express.Router()

router.post(
  '/internal/meta/deauthorize',

  async (req, res) => {
    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const metaUserId =
        String(req.body?.metaUserId || '').trim()

      if (!metaUserId) {
        return res.status(400).json({
          error: 'metaUserId is required.'
        })
      }

      const result =
        await db.query(
          `
            DELETE FROM instagram_connections
            WHERE instagram_user_id = $1
            RETURNING user_id
          `,
          [metaUserId]
        )

      return res.json({
        success: true,
        disconnected: result.rowCount > 0
      })

    } catch (error) {
      console.error(
        'Meta deauthorization error:',
        error
      )

      return res.status(500).json({
        error: 'Failed to process Meta deauthorization.'
      })
    }
  }
)

router.post(
  '/internal/meta/data-deletion',

  async (req, res) => {
    const client = await db.connect()

    try {
      if (!isValidInternalRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized internal request.'
        })
      }

      const metaUserId =
        String(req.body?.metaUserId || '').trim()

      const confirmationCode =
        String(req.body?.confirmationCode || '').trim()

      if (!metaUserId || !confirmationCode) {
        return res.status(400).json({
          error:
            'metaUserId and confirmationCode are required.'
        })
      }

      await client.query('BEGIN')

      const connection =
        await client.query(
          `
            SELECT user_id
            FROM instagram_connections
            WHERE instagram_user_id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [metaUserId]
        )

      const userId =
        connection.rows[0]?.user_id || null

      await client.query(
        `
          INSERT INTO meta_data_deletion_requests (
            confirmation_code,
            meta_user_id,
            user_id,
            status,
            requested_at,
            completed_at
          )
          VALUES (
            $1,
            $2,
            $3,
            'completed',
            NOW(),
            NOW()
          )
          ON CONFLICT (confirmation_code)
          DO UPDATE SET
            meta_user_id = EXCLUDED.meta_user_id,
            user_id = COALESCE(
              meta_data_deletion_requests.user_id,
              EXCLUDED.user_id
            ),
            status = 'completed',
            completed_at = NOW()
        `,
        [
          confirmationCode,
          metaUserId,
          userId
        ]
      )

      if (userId) {
        await client.query(
          `
            DELETE FROM instagram_connections
            WHERE user_id = $1
          `,
          [userId]
        )
      } else {
        await client.query(
          `
            DELETE FROM instagram_connections
            WHERE instagram_user_id = $1
          `,
          [metaUserId]
        )
      }

      await client.query('COMMIT')

      return res.json({
        success: true,
        status: 'completed',
        disconnected: Boolean(userId)
      })

    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      console.error(
        'Meta data deletion error:',
        error
      )

      return res.status(500).json({
        error: 'Failed to process Meta data deletion.'
      })
    } finally {
      client.release()
    }
  }
)

router.get(
  '/internal/meta/data-deletion/:confirmationCode',

  async (req, res) => {
    try {
      const code =
        String(req.params.confirmationCode || '').trim()

      if (!/^[a-f0-9]{32}$/i.test(code)) {
        return res.status(404).json({
          status: 'not_found'
        })
      }

      const result =
        await db.query(
          `
            SELECT
              status,
              requested_at,
              completed_at
            FROM meta_data_deletion_requests
            WHERE confirmation_code = $1
            LIMIT 1
          `,
          [code]
        )

      const request =
        result.rows[0]

      if (!request) {
        return res.status(404).json({
          status: 'not_found'
        })
      }

      return res.json({
        status: request.status,
        requestedAt: request.requested_at,
        completedAt: request.completed_at
      })

    } catch (error) {
      console.error(
        'Meta data deletion status error:',
        error
      )

      return res.status(500).json({
        status: 'error'
      })
    }
  }
)

// ------------------------------------------------------------
// DESCONECTAR INSTAGRAM
// ------------------------------------------------------------

  return router
}
