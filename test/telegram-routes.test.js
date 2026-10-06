import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import {
  createTelegramRouter
} from '../routes/telegram-routes.js'

async function withServer(router, task) {
  const app = express()
  app.use(express.json())
  app.use(router)

  const server = http.createServer(app)

  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', resolve)
  )

  const address = server.address()
  const origin =
    `http://127.0.0.1:${address.port}`

  try {
    await task(origin)
  } finally {
    await new Promise(resolve =>
      server.close(resolve)
    )
  }
}

function makeRouter(overrides = {}) {
  return createTelegramRouter({
    db:
      overrides.db || {
        async query() {
          return {
            rows: [],
            rowCount: 0
          }
        }
      },
    getAccountFromRequest:
      overrides.getAccountFromRequest ||
      (async () => null),
    renders:
      overrides.renders ||
      new Map(),
    execFileAsync:
      overrides.execFileAsync ||
      (async () => {}),
    deleteFile:
      overrides.deleteFile ||
      (() => {}),
    desktopHandlers:
      overrides.desktopHandlers ||
      {},
    fetcher:
      overrides.fetcher ||
      (async () =>
        Response.json({
          ok: true
        }))
  })
}

test('Telegram webhook rejects an invalid secret before touching database', async () => {
  const previous =
    process.env.TELEGRAM_WEBHOOK_SECRET

  process.env.TELEGRAM_WEBHOOK_SECRET =
    'expected-secret'

  let queries = 0

  const router =
    makeRouter({
      db: {
        async query() {
          queries += 1
          throw new Error(
            'database should not run'
          )
        }
      }
    })

  try {
    await withServer(
      router,
      async origin => {
        const response =
          await fetch(
            origin +
              '/telegram/webhook',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
                'x-telegram-bot-api-secret-token':
                  'wrong-secret'
              },
              body: JSON.stringify({
                message: {
                  text:
                    '/connect ABCD'
                }
              })
            }
          )

        assert.equal(
          response.status,
          401
        )

        assert.equal(
          queries,
          0
        )
      }
    )
  } finally {
    if (previous == null) {
      delete process.env
        .TELEGRAM_WEBHOOK_SECRET
    } else {
      process.env
        .TELEGRAM_WEBHOOK_SECRET =
        previous
    }
  }
})

test('Telegram webhook requires chat admin and preserves code user ownership', async () => {
  const previousSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET

  const previousToken =
    process.env.TELEGRAM_BOT_TOKEN

  process.env.TELEGRAM_WEBHOOK_SECRET =
    'telegram-secret'

  process.env.TELEGRAM_BOT_TOKEN =
    'bot-token'

  const queries = []

  const db = {
    async query(sql, params) {
      queries.push({
        sql,
        params
      })

      if (
        /SELECT\s+code,\s+client_id, user_id\s+FROM telegram_connect_codes/s
          .test(sql)
      ) {
        return {
          rows: [
            {
              code: 'ABCD',
              client_id:
                'client-1',
              user_id: 77
            }
          ],
          rowCount: 1
        }
      }

      if (
        /UPDATE telegram_connect_codes SET used_at=NOW\(\)/s
          .test(sql)
      ) {
        return {
          rows: [
            { code: 'ABCD' }
          ],
          rowCount: 1
        }
      }

      return {
        rows: [],
        rowCount: 1
      }
    }
  }

  const telegramCalls = []

  const router =
    makeRouter({
      db,
      fetcher: async url => {
        telegramCalls.push(url)

        if (
          String(url)
            .includes(
              '/getChatMember?'
            )
        ) {
          return Response.json({
            ok: true,
            result: {
              status: 'creator'
            }
          })
        }

        return Response.json({
          ok: true,
          result: {}
        })
      }
    })

  try {
    await withServer(
      router,
      async origin => {
        const response =
          await fetch(
            origin +
              '/telegram/webhook',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
                'x-telegram-bot-api-secret-token':
                  'telegram-secret'
              },
              body: JSON.stringify({
                message: {
                  text:
                    '/connect ABCD',
                  from: {
                    id: 123
                  },
                  chat: {
                    id: -999,
                    type:
                      'supergroup',
                    title:
                      'Beats'
                  }
                }
              })
            }
          )

        assert.equal(
          response.status,
          200
        )

        const inserted =
          queries.find(entry =>
            /INSERT INTO telegram_connections/
              .test(entry.sql)
          )

        assert.ok(inserted)

        assert.equal(
          inserted.params[0],
          'client-1'
        )

        assert.equal(
          inserted.params[4],
          77
        )

        assert.ok(
          telegramCalls.some(url =>
            String(url)
              .includes(
                '/getChatMember?'
              )
          )
        )
      }
    )
  } finally {
    if (previousSecret == null) {
      delete process.env
        .TELEGRAM_WEBHOOK_SECRET
    } else {
      process.env
        .TELEGRAM_WEBHOOK_SECRET =
        previousSecret
    }

    if (previousToken == null) {
      delete process.env
        .TELEGRAM_BOT_TOKEN
    } else {
      process.env
        .TELEGRAM_BOT_TOKEN =
        previousToken
    }
  }
})

test('Telegram disconnect deletes only the authenticated account connection and codes', async () => {
  const queries = []

  const router =
    makeRouter({
      db: {
        async query(sql, params) {
          queries.push({
            sql,
            params
          })

          return {
            rows: [],
            rowCount: 1
          }
        }
      },
      getAccountFromRequest:
        async () => ({ id: 55 })
    })

  await withServer(
    router,
    async origin => {
      const response =
        await fetch(
          origin +
            '/account/telegram/connection',
          {
            method: 'DELETE',
            headers: {
              Authorization:
                'Bearer session'
            }
          }
        )

      assert.equal(
        response.status,
        200
      )

      assert.equal(
        queries.length,
        2
      )

      assert.ok(
        queries.every(
          query =>
            query.params[0] === 55
        )
      )

      assert.match(
        queries[0].sql,
        /telegram_connections/
      )

      assert.match(
        queries[1].sql,
        /telegram_connect_codes/
      )
    }
  )
})
