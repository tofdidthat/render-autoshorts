import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import {
  createPlatformConnectionRouter
} from '../routes/platform-connection-routes.js'

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

test('platform OAuth start binds transaction to the authenticated account', async () => {
  const queries = []

  const db = {
    async query(sql, params) {
      queries.push({ sql, params })
      return { rows: [], rowCount: 1 }
    }
  }

  const router =
    createPlatformConnectionRouter({
      db,
      getAccountFromRequest:
        async () => ({ id: 42 }),
      isValidInternalRequest:
        () => true
    })

  await withServer(
    router,
    async origin => {
      const response =
        await fetch(
          origin +
            '/account/oauth/start',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body: JSON.stringify({
              provider:
                'instagram'
            })
          }
        )

      const data =
        await response.json()

      assert.equal(
        response.status,
        200
      )

      assert.match(
        data.oauthId,
        /^[A-Za-z0-9_-]{43}$/
      )

      assert.equal(
        queries.length,
        1
      )

      assert.match(
        queries[0].sql,
        /INSERT INTO account_oauth_transactions/
      )

      assert.equal(
        queries[0].params[1],
        42
      )

      assert.equal(
        queries[0].params[2],
        'instagram'
      )
    }
  )
})

test('internal platform connection endpoints reject unauthorized callers before account lookup', async () => {
  let accountLookups = 0

  const router =
    createPlatformConnectionRouter({
      db: {
        async query() {
          throw new Error(
            'database should not run'
          )
        }
      },
      getAccountFromRequest:
        async () => {
          accountLookups += 1
          return { id: 1 }
        },
      isValidInternalRequest:
        () => false
    })

  await withServer(
    router,
    async origin => {
      const response =
        await fetch(
          origin +
            '/account/youtube/connection'
        )

      const data =
        await response.json()

      assert.equal(
        response.status,
        401
      )

      assert.equal(
        data.error,
        'Unauthorized internal request.'
      )

      assert.equal(
        accountLookups,
        0
      )
    }
  )
})

test('Instagram refresh lease remains account scoped and returns current token metadata', async () => {
  const queries = []

  const router =
    createPlatformConnectionRouter({
      db: {
        async query(sql, params) {
          queries.push({
            sql,
            params
          })

          return {
            rowCount: 1,
            rows: [
              {
                access_token:
                  'ig-token',
                token_type:
                  'Bearer',
                expires_at:
                  123456
              }
            ]
          }
        }
      },
      getAccountFromRequest:
        async () => ({ id: 7 }),
      isValidInternalRequest:
        () => true
    })

  await withServer(
    router,
    async origin => {
      const response =
        await fetch(
          origin +
            '/account/instagram/refresh-lease',
          {
            method: 'POST'
          }
        )

      const data =
        await response.json()

      assert.equal(
        response.status,
        200
      )

      assert.equal(
        data.claimed,
        true
      )

      assert.deepEqual(
        data.connection,
        {
          access_token:
            'ig-token',
          token_type:
            'Bearer',
          expires_at:
            123456
        }
      )

      assert.equal(
        queries[0].params[0],
        7
      )

      assert.match(
        queries[0].sql,
        /refresh_started_at/
      )
    }
  )
})
