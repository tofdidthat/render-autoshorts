import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  createRenderRouter
} from '../routes/render-routes.js'

async function withServer(router, task) {
  const app = express()
  app.use(express.json())
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

function tempFile(content = 'x') {
  const file =
    path.join(
      os.tmpdir(),
      `onece-render-test-${crypto.randomUUID()}`
    )

  fs.writeFileSync(
    file,
    content
  )

  return file
}

function fakeUpload(filesFactory) {
  return {
    fields() {
      return (req, res, next) => {
        req.files =
          filesFactory(req)

        next()
      }
    }
  }
}

function routerFor(overrides = {}) {
  const renders =
    overrides.renders ||
    new Map()

  return createRenderRouter({
    upload:
      overrides.upload ||
      fakeUpload(() => ({})),
    getAccountFromRequest:
      overrides.getAccountFromRequest ||
      (async () => null),
    renderAudio:
      overrides.renderAudio ||
      (async () => {
        throw new Error(
          'renderAudio should not run'
        )
      }),
    withRenderCapacity:
      overrides.withRenderCapacity ||
      (async (userId, task) =>
        task()),
    execFileAsync:
      overrides.execFileAsync ||
      (async () => {}),
    renders,
    renderTtlMs:
      overrides.renderTtlMs ||
      10 * 60 * 1000,
    deleteFile:
      overrides.deleteFile ||
      (file => {
        if (!file) return

        try {
          fs.unlinkSync(file)
        } catch {}
      }),
    deleteRender:
      overrides.deleteRender ||
      (id => {
        const render =
          renders.get(id)

        if (!render) {
          return false
        }

        try {
          fs.unlinkSync(
            render.path
          )
        } catch {}

        renders.delete(id)
        return true
      }),
    scheduleRenderCleanup:
      overrides
        .scheduleRenderCleanup ||
      (() => {})
  })
}

test('render route rejects missing account session and cleans uploaded inputs', async () => {
  const cover = tempFile('cover')
  const audio = tempFile('audio')

  const router =
    routerFor({
      upload:
        fakeUpload(() => ({
          cover: [{ path: cover }],
          audio: [{ path: audio }]
        }))
    })

  await withServer(
    router,
    async origin => {
      const response =
        await fetch(
          origin + '/render',
          { method: 'POST' }
        )

      assert.equal(
        response.status,
        401
      )

      assert.equal(
        fs.existsSync(cover),
        false
      )

      assert.equal(
        fs.existsSync(audio),
        false
      )
    }
  )
})

test('render route preserves 429 capacity response', async () => {
  const cover = tempFile('cover')
  const audio = tempFile('audio')

  const router =
    routerFor({
      upload:
        fakeUpload(() => ({
          cover: [{ path: cover }],
          audio: [{ path: audio }]
        })),
      getAccountFromRequest:
        async () => ({ id: 7 }),
      withRenderCapacity:
        async () => {
          const error =
            new Error(
              'You already have a render in progress.'
            )

          error.code =
            'USER_RENDER_LIMIT'

          throw error
        }
    })

  await withServer(
    router,
    async origin => {
      const response =
        await fetch(
          origin + '/render',
          { method: 'POST' }
        )

      const data =
        await response.json()

      assert.equal(
        response.status,
        429
      )

      assert.equal(
        data.error,
        'You already have a render in progress.'
      )
    }
  )
})

test('temporary render metadata keeps TTL and delete behavior', async () => {
  const file = tempFile('video')
  const createdAt =
    Date.now() - 30_000

  const renders =
    new Map([
      [
        'render-1',
        {
          id: 'render-1',
          path: file,
          size:
            fs.statSync(file).size,
          mimeType:
            'video/mp4',
          createdAt
        }
      ]
    ])

  const router =
    routerFor({
      renders,
      renderTtlMs: 60_000
    })

  await withServer(
    router,
    async origin => {
      const info =
        await fetch(
          origin +
            '/render/render-1'
        )

      const data =
        await info.json()

      assert.equal(
        info.status,
        200
      )

      assert.equal(
        data.renderId,
        'render-1'
      )

      assert.ok(
        data.expiresInSeconds <= 31
      )

      assert.ok(
        data.expiresInSeconds >= 28
      )

      const deleted =
        await fetch(
          origin +
            '/render/render-1',
          { method: 'DELETE' }
        )

      assert.equal(
        deleted.status,
        200
      )

      assert.equal(
        renders.has('render-1'),
        false
      )
    }
  )
})
