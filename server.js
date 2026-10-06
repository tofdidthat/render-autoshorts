import express from 'express'
import pg from 'pg'
import path from 'path'
import { fileURLToPath } from 'node:url'

import {
  createDesktopRouter,
  setupDesktopDatabase,
  startDesktopGoogle,
  consumeDesktopGoogle
} from './desktop.js'
import {
  setupPublicationDatabase,
  createPublicationService
} from './publication.js'
import { retrieveStripePrice } from './stripe.js'
import { createDatabaseSetup } from './database/setup.js'
import { createRenderRuntime } from './render-runtime.js'
import { createAccountService } from './services/account-service.js'
import { createInternalRequestValidator } from './security/internal-request.js'
import { createLegacyRenderVisibilityMiddleware } from './middleware/render-visibility.js'

import { createHealthRouter } from './routes/health-routes.js'
import { createRenderRouter } from './routes/render-routes.js'
import { createPlatformUploadRouter } from './routes/platform-upload-routes.js'
import { createAccountRouter } from './routes/account-routes.js'
import { createGoogleAuthRouter } from './routes/google-auth-routes.js'
import { createPlatformConnectionRouter } from './routes/platform-connection-routes.js'
import { createTelegramRouter } from './routes/telegram-routes.js'
import {
  createDiscordRouter,
  registerDiscordCommands
} from './routes/discord-routes.js'
import {
  createStripeRouter,
  stripePlanFromStatus
} from './routes/stripe-routes.js'
import { createMetaRouter } from './routes/meta-routes.js'

const { Pool } = pg

const db = new Pool({
  connectionString: process.env.DATABASE_URL
})

const databaseSetup = createDatabaseSetup({
  db,
  setupDesktopDatabase,
  setupPublicationDatabase
})

const {
  setupDatabase,
  initializeDatabaseWithRetry
} = databaseSetup

const app = express()
app.set('trust proxy', 1)

const port = process.env.PORT || 8080
const renders = new Map()
const desktopHandlers = {}

app.use(express.json({
  limit: '1mb',

  verify: (req, res, buf) => {
    if (
      req.originalUrl ===
      '/discord/interactions' ||
      req.originalUrl ===
      '/stripe/webhook'
    ) {
      req.rawBody = buf
    }
  }
}))

// CORS
app.use((req, res, next) => {
  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  )

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, DELETE, OPTIONS'
  )

  res.setHeader(
  'Access-Control-Allow-Headers',
  'Content-Type, Authorization, X-1CE-Internal-Secret'
)

  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Render-Id'
  )

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

const {
  execFileAsync,
  upload,
  renderTtlMs,
  deleteFile,
  deleteRender,
  scheduleRenderCleanup,
  renderAudio,
  withRenderCapacity
} = createRenderRuntime({ renders })

const {
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
  emailMaxAttempts,
  getLoginRateState,
  loginMaxIpAttempts,
  loginMaxPairAttempts,
  loginRetryAfterSeconds,
  progressiveLoginDelay,
  sleep,
  recordFailedLoginAttempt
} = createAccountService({ db })

const isValidInternalRequest =
  createInternalRequestValidator()

const publicationService = createPublicationService({
  db,
  renders,
  handlers: desktopHandlers,
  backendUrl: () => process.env.BACKEND_PUBLIC_URL,
  frontendUrl: () =>
    process.env.ONECE_FRONTEND_URL ||
    'https://1ce.lol'
})

app.use(
  createHealthRouter({
    ready: () => databaseSetup.isReady(),
    renders
  })
)

app.use(
  createLegacyRenderVisibilityMiddleware({
    renders
  })
)

app.use(
  '/api/desktop',
  createDesktopRouter({
    db,
    getAccountFromRequest,
    renderAudio,
    renders,
    deleteRender,
    deleteFile,
    publicationService,
    execFileAsync,
    ready: () => databaseSetup.isReady(),
    publicUrl: () => process.env.BACKEND_PUBLIC_URL
  })
)

app.use(
  createRenderRouter({
    upload,
    getAccountFromRequest,
    renderAudio,
    withRenderCapacity,
    execFileAsync,
    renders,
    renderTtlMs,
    deleteFile,
    deleteRender,
    scheduleRenderCleanup
  })
)

app.use(
  createPlatformUploadRouter({
    renders,
    desktopHandlers
  })
)

app.use(
  createTelegramRouter({
    db,
    getAccountFromRequest,
    renders,
    execFileAsync,
    deleteFile,
    desktopHandlers
  })
)

app.use(
  createDiscordRouter({
    db,
    getAccountFromRequest,
    renders,
    execFileAsync,
    deleteFile,
    desktopHandlers
  })
)

app.use(
  createPlatformConnectionRouter({
    db,
    getAccountFromRequest,
    isValidInternalRequest
  })
)

app.use(
  createAccountRouter({
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
  })
)

app.use(
  createGoogleAuthRouter({
    db,
    normalizeAccountEmail,
    createAccountSessionToken,
    hashAccountSessionToken,
    startDesktopGoogle,
    consumeDesktopGoogle,
    publicationService,
    isDesktopReady: () =>
      databaseSetup.isReady(),
    frontendUrl: () =>
      process.env.ONECE_FRONTEND_URL ||
      'https://1ce.app'
  })
)

app.use(
  createStripeRouter({
    db,
    getAccountFromRequest
  })
)

app.use(
  createMetaRouter({
    db,
    isValidInternalRequest
  })
)

export {
  app,
  db,
  renders,
  setupDatabase,
  deleteRender
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  app.listen(
    port,
    '0.0.0.0',
    () => {
      console.log(
        `Render server listening on port ${port}`
      )
    }
  )

  void initializeDatabaseWithRetry()
    .then(() => registerDiscordCommands())
    .catch(error => {
      console.error(
        'Unexpected database initialization loop failure:',
        error
      )
    })
}
