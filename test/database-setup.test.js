import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDatabaseSetup
} from '../database/setup.js'

test('database setup owns readiness and delegates existing schema setup', async () => {
  const calls = {
    query: 0,
    desktop: 0,
    publication: 0
  }

  const setup =
    createDatabaseSetup({
      db: {
        async query() {
          calls.query += 1
          return {
            rows: [],
            rowCount: 0
          }
        }
      },
      async setupDesktopDatabase() {
        calls.desktop += 1
      },
      async setupPublicationDatabase() {
        calls.publication += 1
      }
    })

  assert.equal(
    setup.isReady(),
    false
  )

  await setup.setupDatabase()

  assert.equal(
    setup.isReady(),
    true
  )

  assert.ok(
    calls.query > 0
  )

  assert.equal(
    calls.desktop,
    1
  )

  assert.equal(
    calls.publication,
    1
  )
})

test('database retry preserves exponential retry behavior and readiness', async () => {
  let firstFailure = true
  const delays = []

  const setup =
    createDatabaseSetup({
      db: {
        async query() {
          if (firstFailure) {
            firstFailure = false
            throw new Error(
              'temporary database failure'
            )
          }

          return {
            rows: [],
            rowCount: 0
          }
        }
      },
      async setupDesktopDatabase() {},
      async setupPublicationDatabase() {},
      async sleep(delayMs) {
        delays.push(delayMs)
      }
    })

  await setup.initializeDatabaseWithRetry()

  assert.equal(
    setup.isReady(),
    true
  )

  assert.deepEqual(
    delays,
    [2000]
  )
})
