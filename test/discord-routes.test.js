import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import http from 'node:http'
import {
  createDiscordRouter,
  registerDiscordCommands
} from '../routes/discord-routes.js'

async function withServer(router, task) {
  const app = express()

  app.use(
    express.json({
      verify(req, res, buf) {
        req.rawBody = Buffer.from(buf)
      }
    })
  )

  app.use(router)

  const server =
    http.createServer(app)

  await new Promise(resolve =>
    server.listen(
      0,
      '127.0.0.1',
      resolve
    )
  )

  const address =
    server.address()

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
  return createDiscordRouter({
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

function discordKeys() {
  const {
    publicKey,
    privateKey
  } =
    crypto.generateKeyPairSync(
      'ed25519'
    )

  const der =
    publicKey.export({
      format: 'der',
      type: 'spki'
    })

  return {
    privateKey,
    publicKeyHex:
      der
        .subarray(
          der.length - 32
        )
        .toString('hex')
  }
}

function signedHeaders(
  privateKey,
  body
) {
  const timestamp = '1700000000'
  const raw =
    Buffer.from(
      JSON.stringify(body)
    )

  const signature =
    crypto.sign(
      null,
      Buffer.concat([
        Buffer.from(timestamp),
        raw
      ]),
      privateKey
    )

  return {
    raw,
    headers: {
      'Content-Type':
        'application/json',
      'x-signature-ed25519':
        signature.toString('hex'),
      'x-signature-timestamp':
        timestamp
    }
  }
}

test('Discord interactions reject invalid signatures before database access', async () => {
  const previous =
    process.env.DISCORD_PUBLIC_KEY

  const { publicKeyHex } =
    discordKeys()

  process.env.DISCORD_PUBLIC_KEY =
    publicKeyHex

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
              '/discord/interactions',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
                'x-signature-ed25519':
                  '00'.repeat(64),
                'x-signature-timestamp':
                  '1700000000'
              },
              body: JSON.stringify({
                type: 1
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
        .DISCORD_PUBLIC_KEY
    } else {
      process.env
        .DISCORD_PUBLIC_KEY =
        previous
    }
  }
})

test('Discord connect requires Administrator or Manage Server permission', async () => {
  const previous =
    process.env.DISCORD_PUBLIC_KEY

  const {
    privateKey,
    publicKeyHex
  } = discordKeys()

  process.env.DISCORD_PUBLIC_KEY =
    publicKeyHex

  let queries = 0

  const router =
    makeRouter({
      db: {
        async query() {
          queries += 1
          return {
            rows: [],
            rowCount: 0
          }
        }
      }
    })

  const body = {
    type: 2,
    guild_id: 'guild-1',
    channel_id: 'channel-1',
    member: {
      permissions: '0'
    },
    data: {
      name: 'connect',
      options: [
        {
          name: 'code',
          value: 'ABCD'
        }
      ]
    }
  }

  const { headers } =
    signedHeaders(
      privateKey,
      body
    )

  try {
    await withServer(
      router,
      async origin => {
        const response =
          await fetch(
            origin +
              '/discord/interactions',
            {
              method: 'POST',
              headers,
              body:
                JSON.stringify(body)
            }
          )

        const data =
          await response.json()

        assert.equal(
          response.status,
          200
        )

        assert.match(
          data.data.content,
          /administrator|Manage Server/i
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
        .DISCORD_PUBLIC_KEY
    } else {
      process.env
        .DISCORD_PUBLIC_KEY =
        previous
    }
  }
})

test('Discord Manage Server connection preserves code ownership', async () => {
  const previous =
    process.env.DISCORD_PUBLIC_KEY

  const {
    privateKey,
    publicKeyHex
  } = discordKeys()

  process.env.DISCORD_PUBLIC_KEY =
    publicKeyHex

  const queries = []

  const router =
    makeRouter({
      db: {
        async query(sql, params) {
          queries.push({
            sql,
            params
          })

          if (
            /SELECT\s+code,\s+client_id, user_id\s+FROM discord_connect_codes/s
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
            /UPDATE discord_connect_codes SET used_at=NOW\(\)/s
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
    })

  const body = {
    type: 2,
    guild_id: 'guild-1',
    channel_id: 'channel-1',
    guild: {
      name: 'Beats'
    },
    channel: {
      name: 'new-beats'
    },
    member: {
      permissions: '32'
    },
    data: {
      name: 'connect',
      options: [
        {
          name: 'code',
          value: 'ABCD'
        }
      ]
    }
  }

  const { headers } =
    signedHeaders(
      privateKey,
      body
    )

  try {
    await withServer(
      router,
      async origin => {
        const response =
          await fetch(
            origin +
              '/discord/interactions',
            {
              method: 'POST',
              headers,
              body:
                JSON.stringify(body)
            }
          )

        assert.equal(
          response.status,
          200
        )

        const inserted =
          queries.find(entry =>
            /INSERT INTO discord_connections/
              .test(entry.sql)
          )

        assert.ok(inserted)

        assert.equal(
          inserted.params[0],
          'client-1'
        )

        assert.equal(
          inserted.params[5],
          77
        )
      }
    )
  } finally {
    if (previous == null) {
      delete process.env
        .DISCORD_PUBLIC_KEY
    } else {
      process.env
        .DISCORD_PUBLIC_KEY =
        previous
    }
  }
})

test('Discord disconnect deletes only the authenticated account records', async () => {
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
            '/account/discord/connection',
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
        /discord_connections/
      )

      assert.match(
        queries[1].sql,
        /discord_connect_codes/
      )
    }
  )
})

test('Discord command registration keeps Manage Server as the default permission', async () => {
  const previous = {
    token:
      process.env.DISCORD_BOT_TOKEN,
    app:
      process.env.DISCORD_APPLICATION_ID,
    guild:
      process.env.DISCORD_GUILD_ID
  }

  process.env.DISCORD_BOT_TOKEN =
    'bot-token'

  process.env.DISCORD_APPLICATION_ID =
    'app-1'

  process.env.DISCORD_GUILD_ID =
    'guild-1'

  let request

  try {
    await registerDiscordCommands(
      async (url, options) => {
        request = {
          url,
          options
        }

        return Response.json({
          id: 'command-1'
        })
      }
    )

    assert.match(
      request.url,
      /applications\/app-1\/guilds\/guild-1\/commands$/
    )

    const body =
      JSON.parse(
        request.options.body
      )

    assert.equal(
      body.name,
      'connect'
    )

    assert.equal(
      body.default_member_permissions,
      '32'
    )

    assert.equal(
      body.dm_permission,
      false
    )
  } finally {
    for(const [key,value] of Object.entries({
      DISCORD_BOT_TOKEN:
        previous.token,
      DISCORD_APPLICATION_ID:
        previous.app,
      DISCORD_GUILD_ID:
        previous.guild
    })) {
      if (value == null) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})
