import express from 'express'
import { createRenderService } from './render-service.js'
import { createDesktopRouter, setupDesktopDatabase, startDesktopGoogle, consumeDesktopGoogle } from './desktop.js'
import multer from 'multer'
import fs from 'fs'
import pg from 'pg'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'node:url'
import { setupPublicationDatabase, createPublicationService } from './publication.js'
import {
  createStripeCheckoutSession,
  createStripeBillingPortalSession,
  retrieveStripeSubscription,
  retrieveStripePrice
} from './stripe.js'
import { createHealthRouter } from './routes/health-routes.js'
import { createRenderRouter } from './routes/render-routes.js'
import { createAccountRouter } from './routes/account-routes.js'
import { createGoogleAuthRouter } from './routes/google-auth-routes.js'
import { createPlatformConnectionRouter } from './routes/platform-connection-routes.js'
import { createTelegramRouter } from './routes/telegram-routes.js'
import { createDiscordRouter, registerDiscordCommands } from './routes/discord-routes.js'

const { Pool } = pg

const db = new Pool({
  connectionString: process.env.DATABASE_URL
})

const execFileAsync = promisify(execFile)

const app = express()
app.set('trust proxy', 1)

const port = process.env.PORT || 8080

const RENDER_TTL_MS = 10 * 60 * 1000

const renders = new Map()

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

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 200 * 1024 * 1024
  }
})

function deleteFile(filePath) {
  if (!filePath) return

  try {
    fs.unlinkSync(filePath)
  } catch {}
}

function deleteRender(renderId) {
  const render = renders.get(renderId)

  if (!render) {
    return false
  }

  if (render.publicationBusyUntil > Date.now()) return false
  deleteFile(render.path)

  renders.delete(renderId)

  console.log(
    `Render removido: ${renderId}`
  )

  return true
}

function scheduleRenderCleanup(renderId) {
  setTimeout(() => {
    if (!deleteRender(renderId) && renders.has(renderId)) scheduleRenderCleanup(renderId)
  }, RENDER_TTL_MS).unref()
}

setInterval(() => {
  const now = Date.now()

  for (
    const [renderId, render]
    of renders.entries()
  ) {
    if (
      now - render.createdAt >=
      RENDER_TTL_MS
    ) {
      deleteRender(renderId)
    }
  }
}, 60 * 1000).unref()

function validateTikTokUploadUrl(uploadUrl) {
  let parsed

  try {
    parsed = new URL(uploadUrl)
  } catch {
    throw new Error(
      'URL de upload do TikTok inválida.'
    )
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      'URL de upload do TikTok deve usar HTTPS.'
    )
  }

  const hostname = parsed.hostname.toLowerCase()

  const allowed =
    hostname === 'open-upload.tiktokapis.com' ||
    (
      hostname.startsWith('open-upload-') &&
      hostname.endsWith('.tiktokapis.com')
    )

  if (!allowed) {
    console.error(
      'Host recebido do TikTok:',
      hostname
    )

    throw new Error(
      `Domínio de upload do TikTok não permitido: ${hostname}`
    )
  }

  return parsed.toString()
}

const desktopHandlers = {}
const publicationService = createPublicationService({ db, renders, handlers: desktopHandlers,
  backendUrl: () => process.env.BACKEND_PUBLIC_URL, frontendUrl: () => process.env.ONECE_FRONTEND_URL || 'https://1ce.lol' })

const renderAudio = createRenderService({
  execFileAsync, renders, scheduleRenderCleanup, deleteFile
})

const MAX_GLOBAL_RENDER_JOBS =
  Math.max(
    1,
    Number(process.env.MAX_GLOBAL_RENDER_JOBS || 2)
  )

const MAX_USER_RENDER_JOBS =
  Math.max(
    1,
    Number(process.env.MAX_USER_RENDER_JOBS || 1)
  )

let activeRenderJobs = 0
const activeRenderJobsByUser = new Map()

async function withRenderCapacity(userId, task) {
  if (activeRenderJobs >= MAX_GLOBAL_RENDER_JOBS) {
    const error = new Error('Render capacity is currently full.')
    error.code = 'RENDER_CAPACITY_FULL'
    throw error
  }

  const currentUserJobs =
    activeRenderJobsByUser.get(userId) || 0

  if (currentUserJobs >= MAX_USER_RENDER_JOBS) {
    const error = new Error('You already have a render in progress.')
    error.code = 'USER_RENDER_LIMIT'
    throw error
  }

  activeRenderJobs += 1
  activeRenderJobsByUser.set(
    userId,
    currentUserJobs + 1
  )

  try {
    return await task()
  } finally {
    activeRenderJobs =
      Math.max(0, activeRenderJobs - 1)

    const remaining =
      (activeRenderJobsByUser.get(userId) || 1) - 1

    if (remaining <= 0) {
      activeRenderJobsByUser.delete(userId)
    } else {
      activeRenderJobsByUser.set(userId, remaining)
    }
  }
}
let desktopDatabaseReady = false

app.use(
  createHealthRouter({
    ready: () =>
      desktopDatabaseReady,
    renders
  })
)


// Account-owned social links can be disconnected without affecting other accounts.
// Desktop renders stay private and cannot enter legacy publication routes.
app.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith('/api/desktop/')) return next()
  let decodedPath
  try { decodedPath = decodeURIComponent(req.path) } catch { return res.sendStatus(400) }
  const pathId = decodedPath.match(/^\/(?:render|public-render)\/([^/]+?)\/?$/i)?.[1]?.replace(/\.mp4$/i, '')
  const id = req.body?.renderId || pathId
  if (typeof id === 'string' && renders.get(id)?.ownerUserId != null) {
    return res.status(404).json({ error: 'Render não encontrado.' })
  }
  next()
})

app.use('/api/desktop', createDesktopRouter({
  db, getAccountFromRequest, renderAudio, renders, deleteRender, deleteFile, publicationService,
  execFileAsync, ready: () => desktopDatabaseReady,
  publicUrl: () => process.env.BACKEND_PUBLIC_URL
}))

app.use(
  createRenderRouter({
    upload,
    getAccountFromRequest,
    renderAudio,
    withRenderCapacity,
    execFileAsync,
    renders,
    renderTtlMs: RENDER_TTL_MS,
    deleteFile,
    deleteRender,
    scheduleRenderCleanup
  })
)


// ============================================================
// TIKTOK
// ============================================================

// Envia diretamente do Railway ao TikTok
app.post(
  '/upload-tiktok',

  desktopHandlers.tiktok = async (req, res) => {
    try {
      const {
        renderId,
        uploadUrl,
        chunkSize,
        totalChunkCount
      } = req.body || {}

      if (!renderId) {
        return res
          .status(400)
          .json({
            error:
              'renderId não informado.'
          })
      }

      if (!uploadUrl) {
        return res
          .status(400)
          .json({
            error:
              'uploadUrl não informada.'
          })
      }

      const render =
        renders.get(renderId)

      if (
        !render ||
        !fs.existsSync(
          render.path
        )
      ) {
        return res
          .status(404)
          .json({
            error:
              'Render não encontrado ou expirado.'
          })
      }

      const safeUploadUrl =
        validateTikTokUploadUrl(
          uploadUrl
        )

      const fileSize =
        render.size

      const requestedChunkSize =
        Number(chunkSize)

      const requestedChunkCount =
        Number(totalChunkCount)

      const actualChunkSize =
        Number.isFinite(
          requestedChunkSize
        ) &&
        requestedChunkSize > 0
          ? requestedChunkSize
          : fileSize

      const actualChunkCount =
        Number.isFinite(
          requestedChunkCount
        ) &&
        requestedChunkCount > 0
          ? requestedChunkCount
          : 1

      console.log(
        `TikTok upload iniciado: ${renderId}`
      )

      for (
        let index = 0;
        index <
        actualChunkCount;
        index++
      ) {
        const start =
          index *
          actualChunkSize

        const endExclusive =
          index ===
          actualChunkCount - 1
            ? fileSize
            : Math.min(
                start +
                  actualChunkSize,
                fileSize
              )

        if (
          start >=
          fileSize
        ) {
          break
        }

        const chunkLength =
          endExclusive -
          start

        const chunk =
          Buffer.allocUnsafe(
            chunkLength
          )

        const fileHandle =
          await fs.promises.open(
            render.path,
            'r'
          )

        try {
          await fileHandle.read(
            chunk,
            0,
            chunkLength,
            start
          )
        } finally {
          await fileHandle.close()
        }

        const tikTokResponse =
          await (req.publicationFetch || fetch)(
            safeUploadUrl,
            {
              method: 'PUT',

              headers: {
                'Content-Type':
                  'video/mp4',

                'Content-Length':
                  String(
                    chunkLength
                  ),

                'Content-Range':
                  `bytes ${start}-${endExclusive - 1}/${fileSize}`
              },

              body: chunk
            }
          )

        if (
          !tikTokResponse.ok
        ) {
          const errorText =
            await tikTokResponse
              .text()
              .catch(
                () => ''
              )

          throw new Error(
            `TikTok respondeu HTTP ${tikTokResponse.status}${
              errorText
                ? `: ${errorText}`
                : ''
            }`
          )
        }

        console.log(
          `TikTok chunk ${index + 1}/${actualChunkCount} enviado`
        )
      }

      console.log(
        `TikTok upload concluído: ${renderId}`
      )

      return res.json({
        ok: true,
        renderId
      })
    } catch (error) {
      console.error(
        'Erro TikTok:',
        error
      )

      return res
        .status(500)
        .json({
          error:
            'Falha ao enviar vídeo para o TikTok.',

          details:
            error?.message
        })
    }
  }
)

// Apaga render temporário
// ============================================================
// YOUTUBE
// ============================================================

function validateYouTubeUploadUrl(uploadUrl) {
  let parsed

  try {
    parsed = new URL(uploadUrl)
  } catch {
    throw new Error(
      'URL de upload do YouTube inválida.'
    )
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      'URL de upload do YouTube deve usar HTTPS.'
    )
  }

  const hostname =
    parsed.hostname.toLowerCase()

  const allowed =
    hostname === 'www.googleapis.com' ||
    hostname === 'youtube.googleapis.com' ||
    hostname.endsWith('.googleapis.com')

  if (!allowed) {
    console.error(
      'Host recebido do YouTube:',
      hostname
    )

    throw new Error(
      `Domínio de upload do YouTube não permitido: ${hostname}`
    )
  }

  return parsed.toString()
}


// Envia diretamente do Railway para o YouTube
app.post(
  '/upload-youtube',

  desktopHandlers.youtube = async (req, res) => {
    try {
      const {
        renderId,
        uploadUrl
      } = req.body || {}

      if (!renderId) {
        return res.status(400).json({
          error:
            'renderId não informado.'
        })
      }

      if (!uploadUrl) {
        return res.status(400).json({
          error:
            'uploadUrl não informada.'
        })
      }

      const render =
        renders.get(renderId)

      if (
        !render ||
        !fs.existsSync(render.path)
      ) {
        return res.status(404).json({
          error:
            'Render não encontrado ou expirado.'
        })
      }

      const safeUploadUrl =
        validateYouTubeUploadUrl(
          uploadUrl
        )

      console.log(
        `YouTube upload iniciado: ${renderId}`
      )

      const videoBuffer =
        await fs.promises.readFile(
          render.path
        )

      const youtubeResponse =
        await (req.publicationFetch || fetch)(
          safeUploadUrl,
          {
            method: 'PUT',

            headers: {
              'Content-Type':
                'video/mp4',

              'Content-Length':
                String(
                  videoBuffer.length
                )
            },

            body: videoBuffer
          }
        )

      const responseText =
        await youtubeResponse
          .text()
          .catch(() => '')

      if (!youtubeResponse.ok) {
        throw new Error(
          `YouTube respondeu HTTP ${youtubeResponse.status}${
            responseText
              ? `: ${responseText}`
              : ''
          }`
        )
      }

      let video = {}

      if (responseText) {
        try {
          video =
            JSON.parse(
              responseText
            )
        } catch {}
      }

      console.log(
        `YouTube upload concluído: ${renderId}`
      )

      return res.json({
        ok: true,
        renderId,
        video
      })
    } catch (error) {
      console.error(
        'Erro YouTube:',
        error
      )

      return res.status(500).json({
        error:
          'Falha ao enviar vídeo para o YouTube.',

        details:
          error?.message
      })
    }
  }
)

// ============================================================
// TELEGRAM CONNECT
// Gera código temporário para conectar um chat
// ============================================================

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

// ============================================================
// DISCORD CONNECT
// Gera código temporário para conectar um canal
// ============================================================

// ============================================================
// 1CE ACCOUNT AUTH - GOOGLE
// Login principal da conta 1CE
// Separado das conexões YouTube / TikTok / Instagram
// ============================================================

const ONECE_FRONTEND_URL =
  process.env.ONECE_FRONTEND_URL ||
  'https://1ce.app'

function createAccountSessionToken() {
  return crypto.randomBytes(32).toString('hex')
}

function hashAccountSessionToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex')
}

async function getAccountFromRequest(req) {
  const authorization =
    req.headers.authorization || ''

  if (!authorization.startsWith('Bearer ')) {
    return null
  }

  const token =
    authorization.slice(7).trim()

  if (!token) {
    return null
  }

  const tokenHash =
    hashAccountSessionToken(token)

  const result = await db.query(
    `
      SELECT
        u.id,
        u.google_id,
        u.email,
        u.name,
        u.picture
      FROM account_sessions s
      JOIN account_users u
        ON u.id = s.user_id
      WHERE
        s.token_hash = $1
        AND s.expires_at > NOW()
      LIMIT 1
    `,
    [tokenHash]
  )

  return result.rows[0] || null
}


app.use(
  createPlatformConnectionRouter({
    db,
    getAccountFromRequest,
    isValidInternalRequest
  })
)

// ------------------------------------------------------------
// EMAIL / PASSWORD AUTH
// Cadastro + verificação por código enviado pelo Resend
// ------------------------------------------------------------

const EMAIL_CODE_TTL_MINUTES = 10
const EMAIL_RESEND_COOLDOWN_SECONDS = 60
const EMAIL_MAX_ATTEMPTS = 5

function normalizeAccountEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function isValidAccountEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hashEmailVerificationCode(code) {
  return crypto
    .createHash('sha256')
    .update(String(code))
    .digest('hex')
}

function hashAccountPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16)

    crypto.scrypt(
      String(password),
      salt,
      64,
      { N: 16384, r: 8, p: 1 },
      (error, derivedKey) => {
        if (error) return reject(error)

        resolve(
          `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`
        )
      }
    )
  })
}

function verifyAccountPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const parts = String(storedHash || '').split('$')

    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return resolve(false)
    }

    let salt
    let expected

    try {
      salt = Buffer.from(parts[1], 'hex')
      expected = Buffer.from(parts[2], 'hex')
    } catch {
      return resolve(false)
    }

    if (!salt.length || !expected.length) {
      return resolve(false)
    }

    crypto.scrypt(
      String(password),
      salt,
      expected.length,
      { N: 16384, r: 8, p: 1 },
      (error, derivedKey) => {
        if (error) return reject(error)

        if (derivedKey.length !== expected.length) {
          return resolve(false)
        }

        resolve(
          crypto.timingSafeEqual(derivedKey, expected)
        )
      }
    )
  })
}

async function createAccountSession(userId) {
  const sessionToken = createAccountSessionToken()
  const tokenHash = hashAccountSessionToken(sessionToken)

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
    [userId, tokenHash]
  )

  return sessionToken
}

async function sendAccountVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY
  const from =
    process.env.RESEND_FROM_EMAIL ||
    '1CE <no-reply@1ce.lol>'

  if (!apiKey) {
    throw new Error('RESEND_API_KEY não configurada.')
  }

  const response = await fetch(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Your 1CE verification code',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px;color:#111">
            <h1 style="font-size:24px;margin:0 0 18px">Verify your email</h1>
            <p style="font-size:16px;line-height:1.5">Use this code to finish creating your 1CE account:</p>
            <div style="font-size:36px;font-weight:700;letter-spacing:8px;margin:28px 0">${code}</div>
            <p style="font-size:14px;color:#666">This code expires in ${EMAIL_CODE_TTL_MINUTES} minutes.</p>
            <p style="font-size:14px;color:#666">If you did not request this code, you can ignore this email.</p>
          </div>
        `
      })
    }
  )

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    console.error('Resend error:', data)
    throw new Error(
      data?.message || `Resend respondeu HTTP ${response.status}`
    )
  }

  return data
}

async function sendPasswordResetEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL || '1CE <no-reply@1ce.lol>'

  if (!apiKey) throw new Error('RESEND_API_KEY não configurada.')

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Reset your 1CE password',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:32px;color:#111">
          <h1 style="font-size:24px;margin:0 0 18px">Reset your password</h1>
          <p style="font-size:16px;line-height:1.5">Use this code to reset your 1CE password:</p>
          <div style="font-size:36px;font-weight:700;letter-spacing:8px;margin:28px 0">${code}</div>
          <p style="font-size:14px;color:#666">This code expires in ${EMAIL_CODE_TTL_MINUTES} minutes.</p>
          <p style="font-size:14px;color:#666">If you did not request a password reset, you can ignore this email.</p>
        </div>
      `
    })
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error('Resend password reset error:', data)
    throw new Error(data?.message || `Resend respondeu HTTP ${response.status}`)
  }
  return data
}

async function issuePasswordResetCode(userId, email) {
  const code =
    String(
      crypto.randomInt(0, 1000000)
    ).padStart(6, '0')

  const codeHash =
    hashEmailVerificationCode(code)

  const client = await db.connect()
  let insertedId

  try {
    await client.query('BEGIN')

    await client.query(
      `
        SELECT id
        FROM account_users
        WHERE id = $1
        FOR UPDATE
      `,
      [userId]
    )

    const recent =
      await client.query(
        `
          SELECT created_at
          FROM account_password_resets
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [userId]
      )

    if (recent.rows.length) {
      const elapsed =
        Date.now() -
        new Date(
          recent.rows[0].created_at
        ).getTime()

      if (
        elapsed <
        EMAIL_RESEND_COOLDOWN_SECONDS * 1000
      ) {
        const error =
          new Error(
            'Please wait before requesting another code.'
          )

        error.statusCode = 429
        throw error
      }
    }

    await client.query(
      `
        UPDATE account_password_resets
        SET used_at = NOW()
        WHERE user_id = $1
          AND used_at IS NULL
      `,
      [userId]
    )

    const inserted =
      await client.query(
        `
          INSERT INTO account_password_resets (
            user_id,
            code_hash,
            expires_at
          )
          VALUES (
            $1,
            $2,
            NOW() + ($3 * INTERVAL '1 minute')
          )
          RETURNING id
        `,
        [
          userId,
          codeHash,
          EMAIL_CODE_TTL_MINUTES
        ]
      )

    insertedId =
      inserted.rows[0].id

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  try {
    await sendPasswordResetEmail(
      email,
      code
    )
  } catch (error) {
    await db.query(
      `
        DELETE FROM account_password_resets
        WHERE id = $1
      `,
      [insertedId]
    ).catch(() => {})

    throw error
  }
}

async function issueEmailVerificationCode(userId, email) {
  const code =
    String(
      crypto.randomInt(0, 1000000)
    ).padStart(6, '0')

  const codeHash =
    hashEmailVerificationCode(code)

  const client = await db.connect()
  let insertedId

  try {
    await client.query('BEGIN')

    await client.query(
      `
        SELECT id
        FROM account_users
        WHERE id = $1
        FOR UPDATE
      `,
      [userId]
    )

    const recent =
      await client.query(
        `
          SELECT created_at
          FROM account_email_verifications
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [userId]
      )

    if (recent.rows.length) {
      const elapsed =
        Date.now() -
        new Date(
          recent.rows[0].created_at
        ).getTime()

      if (
        elapsed <
        EMAIL_RESEND_COOLDOWN_SECONDS * 1000
      ) {
        const error =
          new Error(
            'Please wait before requesting another code.'
          )

        error.statusCode = 429
        throw error
      }
    }

    await client.query(
      `
        UPDATE account_email_verifications
        SET used_at = NOW()
        WHERE user_id = $1
          AND used_at IS NULL
      `,
      [userId]
    )

    const inserted =
      await client.query(
        `
          INSERT INTO account_email_verifications (
            user_id,
            code_hash,
            expires_at
          )
          VALUES (
            $1,
            $2,
            NOW() + ($3 * INTERVAL '1 minute')
          )
          RETURNING id
        `,
        [
          userId,
          codeHash,
          EMAIL_CODE_TTL_MINUTES
        ]
      )

    insertedId =
      inserted.rows[0].id

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  try {
    await sendAccountVerificationEmail(
      email,
      code
    )
  } catch (error) {
    await db.query(
      `
        DELETE FROM account_email_verifications
        WHERE id = $1
      `,
      [insertedId]
    ).catch(() => {})

    throw error
  }
}

const LOGIN_WINDOW_MINUTES = 15
const LOGIN_MAX_IP_ATTEMPTS = 30
const LOGIN_MAX_PAIR_ATTEMPTS = 8

function hashLoginRateValue(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getLoginRateState(email, req) {
  const emailHash =
    hashLoginRateValue(email)

  const ipHash =
    hashLoginRateValue(req.ip || req.socket?.remoteAddress || 'unknown')

  const result = await db.query(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE ip_hash = $2
        )::int AS ip_attempts,

        COUNT(*) FILTER (
          WHERE email_hash = $1
            AND ip_hash = $2
        )::int AS pair_attempts,

        COUNT(*) FILTER (
          WHERE email_hash = $1
        )::int AS email_attempts,

        MIN(created_at) FILTER (
          WHERE ip_hash = $2
        ) AS oldest_ip_attempt,

        MIN(created_at) FILTER (
          WHERE email_hash = $1
            AND ip_hash = $2
        ) AS oldest_pair_attempt
      FROM account_login_attempts
      WHERE created_at >
        NOW() - ($3 * INTERVAL '1 minute')
    `,
    [
      emailHash,
      ipHash,
      LOGIN_WINDOW_MINUTES
    ]
  )

  return {
    emailHash,
    ipHash,
    ...result.rows[0]
  }
}

function loginRetryAfterSeconds(oldestAttempt) {
  if (!oldestAttempt) return 60

  const elapsedSeconds =
    Math.floor(
      (Date.now() - new Date(oldestAttempt).getTime()) /
      1000
    )

  return Math.max(
    1,
    LOGIN_WINDOW_MINUTES * 60 - elapsedSeconds
  )
}

async function recordFailedLoginAttempt(emailHash, ipHash) {
  await db.query(
    `
      INSERT INTO account_login_attempts (
        email_hash,
        ip_hash
      )
      VALUES ($1, $2)
    `,
    [
      emailHash,
      ipHash
    ]
  )

  // Opportunistic cleanup keeps the table bounded without a separate job.
  if (Math.random() < 0.02) {
    db.query(
      `
        DELETE FROM account_login_attempts
        WHERE created_at < NOW() - INTERVAL '24 hours'
      `
    ).catch(() => {})
  }
}

function progressiveLoginDelay(attempts) {
  if (attempts < 2) return 0

  return Math.min(
    4000,
    250 * (2 ** Math.min(attempts - 2, 4))
  )
}

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
    emailMaxAttempts:
      EMAIL_MAX_ATTEMPTS,
    createAccountSession,
    getLoginRateState,
    loginMaxIpAttempts:
      LOGIN_MAX_IP_ATTEMPTS,
    loginMaxPairAttempts:
      LOGIN_MAX_PAIR_ATTEMPTS,
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
      desktopDatabaseReady,
    frontendUrl: () =>
      process.env.ONECE_FRONTEND_URL ||
      'https://1ce.app'
  })
)

// ============================================================
// 1CE - STRIPE WEBHOOK / SUBSCRIPTION SYNC
// ============================================================

function verifyStripeWebhookSignature(req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const header = String(req.headers['stripe-signature'] || '')

  if (!secret || !header || !req.rawBody) return false

  const parts = header.split(',')
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2)
  const signatures = parts
    .filter(part => part.startsWith('v1='))
    .map(part => part.slice(3))

  if (!timestamp || !signatures.length) return false

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${req.rawBody.toString('utf8')}`)
    .digest('hex')

  return signatures.some(signature => {
    try {
      const a = Buffer.from(signature, 'hex')
      const b = Buffer.from(expected, 'hex')
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    } catch {
      return false
    }
  })
}

function stripePlanFromStatus(status) {
  return ['active', 'trialing'].includes(String(status || '').toLowerCase())
    ? 'pro'
    : 'free'
}

async function upsertStripeSubscription({
  userId,
  customerId,
  subscriptionId,
  status,
  priceId,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  queryClient = db
}) {
  if (!userId) return { updated: false }

  const existingResult =
    await queryClient.query(
      `
        SELECT
          stripe_customer_id,
          stripe_subscription_id,
          status,
          price_id,
          current_period_end,
          cancel_at_period_end
        FROM stripe_subscriptions
        WHERE user_id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [Number(userId)]
    )

  const existing =
    existingResult.rows[0] || null

  if (
    existing?.stripe_subscription_id &&
    subscriptionId &&
    existing.stripe_subscription_id !== String(subscriptionId)
  ) {
    const existingStatus =
      String(existing.status || '').toLowerCase()

    const terminal =
      ['canceled', 'incomplete_expired'].includes(existingStatus)

    if (!terminal) {
      console.warn(
        'Ignoring Stripe event for non-canonical subscription',
        {
          userId: Number(userId),
          currentSubscription:
            existing.stripe_subscription_id,
          incomingSubscription:
            String(subscriptionId)
        }
      )

      return {
        updated: false,
        ignoredDifferentSubscription: true
      }
    }
  }

  const nextCustomerId =
    customerId != null
      ? String(customerId)
      : existing?.stripe_customer_id || null

  const nextSubscriptionId =
    subscriptionId != null
      ? String(subscriptionId)
      : existing?.stripe_subscription_id || null

  const nextStatus =
    status != null
      ? String(status)
      : existing?.status || 'inactive'

  const nextPriceId =
    priceId !== undefined && priceId !== null
      ? String(priceId)
      : existing?.price_id || null

  const nextCurrentPeriodEnd =
    currentPeriodEnd !== undefined
      ? (
          currentPeriodEnd
            ? new Date(Number(currentPeriodEnd) * 1000)
            : null
        )
      : existing?.current_period_end || null

  const nextCancelAtPeriodEnd =
    typeof cancelAtPeriodEnd === 'boolean'
      ? cancelAtPeriodEnd
      : Boolean(existing?.cancel_at_period_end)

  await queryClient.query(
    `
      INSERT INTO stripe_subscriptions (
        user_id,
        stripe_customer_id,
        stripe_subscription_id,
        status,
        price_id,
        current_period_end,
        cancel_at_period_end,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        status = EXCLUDED.status,
        price_id = EXCLUDED.price_id,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = NOW()
    `,
    [
      Number(userId),
      nextCustomerId,
      nextSubscriptionId,
      nextStatus,
      nextPriceId,
      nextCurrentPeriodEnd,
      nextCancelAtPeriodEnd
    ]
  )

  return { updated: true }
}

async function syncStripeSubscription({
  userId,
  subscriptionId,
  queryClient = db
}) {
  if (!userId || !subscriptionId) {
    return { updated: false }
  }

  const subscription =
    await retrieveStripeSubscription(
      subscriptionId
    )

  return upsertStripeSubscription({
    userId,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status: subscription.status,
    priceId:
      subscription.items?.data?.[0]?.price?.id,
    currentPeriodEnd:
      subscription.current_period_end,
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end,
    queryClient
  })
}

async function findStripeUserIdBySubscription(subscriptionId, queryClient = db) {
  if (!subscriptionId) return null

  const result = await queryClient.query(
    `SELECT user_id FROM stripe_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
    [String(subscriptionId)]
  )

  return result.rows[0]?.user_id || null
}

app.post('/stripe/webhook', async (req, res) => {
  if (!verifyStripeWebhookSignature(req)) {
    return res.status(400).send('Invalid Stripe signature')
  }

  const event = req.body || {}
  const eventId = String(event.id || '')

  if (!eventId) {
    return res.status(400).send('Invalid Stripe event')
  }

  const client = await db.connect()

  try {
    await client.query('BEGIN')

    const inserted = await client.query(
      `
        INSERT INTO stripe_webhook_events (event_id, event_type)
        VALUES ($1, $2)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `,
      [eventId, String(event.type || '')]
    )

    if (!inserted.rows.length) {
      await client.query('COMMIT')
      return res.json({ received: true, duplicate: true })
    }

    const object = event.data?.object || {}

    if (event.type === 'checkout.session.completed') {
      const userId =
        object.client_reference_id ||
        object.metadata?.onece_user_id

      if (userId && object.subscription) {
        await syncStripeSubscription({
          userId,
          subscriptionId: object.subscription,
          queryClient: client
        })
      }
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const userId =
        object.metadata?.onece_user_id ||
        await findStripeUserIdBySubscription(
          object.id,
          client
        )

      if (userId) {
        await syncStripeSubscription({
          userId,
          subscriptionId: object.id,
          queryClient: client
        })
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const subscriptionId =
        typeof object.subscription === 'string'
          ? object.subscription
          : object.subscription?.id

      const userId =
        await findStripeUserIdBySubscription(
          subscriptionId,
          client
        )

      if (userId) {
        await syncStripeSubscription({
          userId,
          subscriptionId,
          queryClient: client
        })
      }
    }

    await client.query('COMMIT')
    return res.json({ received: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Stripe webhook error:', error)
    return res.status(500).json({ error: 'Stripe webhook failed.' })
  } finally {
    client.release()
  }
})

// ------------------------------------------------------------
// USUÁRIO LOGADO
// ------------------------------------------------------------

// ------------------------------------------------------------
// LOGOUT
// ------------------------------------------------------------

// ============================================================
// 1CE - STRIPE CUSTOMER PORTAL
// ============================================================

app.post(
  '/stripe/create-portal-session',

  async (req, res) => {
    try {
      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const subscriptionResult =
        await db.query(
          `
            SELECT stripe_customer_id
            FROM stripe_subscriptions
            WHERE user_id = $1
            LIMIT 1
          `,
          [user.id]
        )

      const customerId =
        subscriptionResult.rows[0]?.stripe_customer_id

      if (!customerId) {
        return res.status(404).json({
          error: 'Stripe customer not found for this account.'
        })
      }

      const session =
        await createStripeBillingPortalSession({
          customerId
        })

      if (!session?.url) {
        throw new Error(
          'Stripe Billing Portal session returned without URL.'
        )
      }

      return res.json({
        url: session.url
      })

    } catch (error) {
      console.error(
        'Stripe billing portal session error:',
        error
      )

      return res.status(500).json({
        error:
          error?.message ||
          'Failed to create Stripe Billing Portal session.'
      })
    }
  }
)

// ============================================================
// 1CE - STRIPE CHECKOUT
// ============================================================

app.post(
  '/stripe/create-checkout-session',

  async (req, res) => {
    try {
      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const market =
        String(req.body?.market || '')
          .trim()
          .toLowerCase()

      if (
        market !== 'br' &&
        market !== 'global'
      ) {
        return res.status(400).json({
          error: 'Invalid market. Use br or global.'
        })
      }

      const subscriptionResult =
        await db.query(
          `
            SELECT
              stripe_customer_id,
              stripe_subscription_id,
              status
            FROM stripe_subscriptions
            WHERE user_id = $1
            LIMIT 1
          `,
          [user.id]
        )

      const existingSubscription =
        subscriptionResult.rows[0] || null

      const existingStatus =
        String(existingSubscription?.status || '')
          .toLowerCase()

      const hasExistingSubscription =
        Boolean(
          existingSubscription?.stripe_subscription_id &&
          ![
            'canceled',
            'incomplete_expired'
          ].includes(existingStatus)
        )

      if (hasExistingSubscription) {
        const customerId =
          existingSubscription?.stripe_customer_id

        if (!customerId) {
          return res.status(409).json({
            error:
              'An existing subscription was found, but its Stripe customer is unavailable.'
          })
        }

        const portalSession =
          await createStripeBillingPortalSession({
            customerId
          })

        if (!portalSession?.url) {
          throw new Error(
            'Stripe Billing Portal session returned without URL.'
          )
        }

        return res.json({
          url: portalSession.url,
          portal: true
        })
      }

      const customerId =
        existingSubscription?.stripe_customer_id || null

      const idempotencyKey =
        crypto
          .createHash('sha256')
          .update(
            [
              'onece-checkout',
              user.id,
              market,
              customerId || user.email || '',
              existingSubscription?.stripe_subscription_id || 'none',
              existingStatus || 'none'
            ].join(':')
          )
          .digest('hex')

      const session =
        await createStripeCheckoutSession({
          market,
          customerEmail: user.email,
          customerId,
          userId: user.id,
          idempotencyKey
        })

      if (!session?.url) {
        throw new Error(
          'Stripe Checkout session returned without URL.'
        )
      }

      return res.json({
        url: session.url,
        sessionId: session.id
      })

    } catch (error) {
      console.error(
        'Stripe checkout session error:',
        error
      )

      return res.status(500).json({
        error:
          error?.message ||
          'Failed to create Stripe Checkout session.'
      })
    }
  }
)


// ============================================================
// 1CE - YOUTUBE CONNECTION STORAGE
// Comunicação privada Vercel <-> Railway
// ============================================================

function isValidInternalRequest(req) {
  const secret =
    req.headers['x-1ce-internal-secret']

  const expected =
    process.env.ONECE_INTERNAL_SECRET

  if (!secret || !expected) {
    return false
  }

  const left =
    Buffer.from(String(secret))

  const right =
    Buffer.from(String(expected))

  if (left.length !== right.length) {
    return false
  }

  return crypto.timingSafeEqual(
    left,
    right
  )
}


// ------------------------------------------------------------
// SALVAR / ATUALIZAR CONEXÃO YOUTUBE
// ------------------------------------------------------------

// ------------------------------------------------------------
// META DEAUTHORIZATION / DATA DELETION
// Chamadas internas da API Vercel validadas por ONECE_INTERNAL_SECRET.
// ------------------------------------------------------------

app.post(
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

app.post(
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

app.get(
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

async function setupDatabase() {
  desktopDatabaseReady = false

  try {
await db.query(`
  CREATE TABLE IF NOT EXISTS account_users (
    id SERIAL PRIMARY KEY,
    google_id TEXT UNIQUE,
    email TEXT NOT NULL,
    password_hash TEXT,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    name TEXT,
    picture TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`)

// Prepara contas existentes para suportar Google OU Email/Senha.
// Usuários que já entraram pelo Google têm o e-mail considerado verificado.
await db.query(`
  ALTER TABLE account_users
  ALTER COLUMN google_id DROP NOT NULL
`)

await db.query(`
  ALTER TABLE account_users
  ADD COLUMN IF NOT EXISTS password_hash TEXT
`)

await db.query(`
  ALTER TABLE account_users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE
`)

await db.query(`
  UPDATE account_users
  SET email_verified = TRUE
  WHERE google_id IS NOT NULL
    AND email_verified = FALSE
`)

await db.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS
    account_users_email_lower_unique_idx
  ON account_users (LOWER(email))
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS account_email_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL
      REFERENCES account_users(id)
      ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS
    account_email_verifications_user_id_idx
  ON account_email_verifications(user_id)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS account_password_resets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL
      REFERENCES account_users(id)
      ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    reset_token_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    reset_token_expires_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS
    account_password_resets_user_id_idx
  ON account_password_resets(user_id)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS account_sessions (
    id SERIAL PRIMARY KEY,

    user_id INTEGER NOT NULL
      REFERENCES account_users(id)
      ON DELETE CASCADE,

    token_hash TEXT UNIQUE NOT NULL,

    created_at TIMESTAMPTZ
      DEFAULT NOW(),

    expires_at TIMESTAMPTZ
      NOT NULL
  )
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS account_login_attempts (
    id BIGSERIAL PRIMARY KEY,
    email_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS account_login_attempts_email_time_idx
  ON account_login_attempts(email_hash, created_at DESC)
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS account_login_attempts_ip_time_idx
  ON account_login_attempts(ip_hash, created_at DESC)
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS account_login_attempts_pair_time_idx
  ON account_login_attempts(email_hash, ip_hash, created_at DESC)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS account_google_login_attempts (
    state_hash TEXT PRIMARY KEY,
    verifier_challenge TEXT NOT NULL,
    user_id INTEGER
      REFERENCES account_users(id)
      ON DELETE CASCADE,
    exchange_hash TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    callback_used_at TIMESTAMPTZ,
    exchange_expires_at TIMESTAMPTZ,
    exchanged_at TIMESTAMPTZ
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS account_google_login_attempts_expiry_idx
  ON account_google_login_attempts(expires_at)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS account_oauth_transactions (
    transaction_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL
      REFERENCES account_users(id)
      ON DELETE CASCADE,
    provider TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS account_oauth_transactions_user_idx
  ON account_oauth_transactions(user_id)
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS account_oauth_transactions_expiry_idx
  ON account_oauth_transactions(expires_at)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS youtube_connections (
    id SERIAL PRIMARY KEY,

    user_id INTEGER NOT NULL UNIQUE
      REFERENCES account_users(id)
      ON DELETE CASCADE,

    access_token TEXT NOT NULL,
    refresh_token TEXT,

    scope TEXT,
    token_type TEXT DEFAULT 'Bearer',

    expires_at BIGINT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS
    youtube_connections_user_id_idx
  ON youtube_connections(user_id)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS tiktok_connections (
    id SERIAL PRIMARY KEY,

    user_id INTEGER NOT NULL UNIQUE
      REFERENCES account_users(id)
      ON DELETE CASCADE,

    open_id TEXT,

    access_token TEXT NOT NULL,
    refresh_token TEXT,

    scope TEXT,
    token_type TEXT DEFAULT 'Bearer',

    expires_at BIGINT,
    refresh_expires_at BIGINT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS
    tiktok_connections_user_id_idx
  ON tiktok_connections(user_id)
`)


await db.query(`
  CREATE TABLE IF NOT EXISTS instagram_connections (
    id SERIAL PRIMARY KEY,

    user_id INTEGER NOT NULL UNIQUE
      REFERENCES account_users(id)
      ON DELETE CASCADE,

    instagram_user_id TEXT,
    page_id TEXT,
    page_name TEXT,
    username TEXT,

    access_token TEXT NOT NULL,
    token_type TEXT DEFAULT 'Bearer',

    expires_at BIGINT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`)

await db.query(`
  ALTER TABLE instagram_connections
  ADD COLUMN IF NOT EXISTS refresh_started_at TIMESTAMPTZ
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS
    instagram_connections_user_id_idx
  ON instagram_connections(user_id)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS meta_data_deletion_requests (
    confirmation_code TEXT PRIMARY KEY,
    meta_user_id TEXT NOT NULL,
    user_id INTEGER
      REFERENCES account_users(id)
      ON DELETE SET NULL,
    status TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS meta_data_deletion_requests_user_idx
  ON meta_data_deletion_requests(user_id)
`)
    
await db.query(`
  CREATE INDEX IF NOT EXISTS
    account_sessions_user_id_idx
  ON account_sessions(user_id)
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS
    account_sessions_expires_at_idx
  ON account_sessions(expires_at)
`)

    
await db.query(`
  CREATE TABLE IF NOT EXISTS stripe_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE
      REFERENCES account_users(id)
      ON DELETE CASCADE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'inactive',
    price_id TEXT,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`)

await db.query(`
  CREATE INDEX IF NOT EXISTS stripe_subscriptions_customer_idx
  ON stripe_subscriptions(stripe_customer_id)
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`)

    await db.query(`
      CREATE TABLE IF NOT EXISTS telegram_connections (
        id SERIAL PRIMARY KEY,
        client_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_title TEXT,
        thread_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(client_id, chat_id, thread_id)
      )
    `)

    await db.query(`
      CREATE TABLE IF NOT EXISTS telegram_connect_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      )
    `)

await db.query(`
  CREATE TABLE IF NOT EXISTS discord_connections (
    id SERIAL PRIMARY KEY,
    client_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    guild_name TEXT,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, guild_id, channel_id)
  )
`)

await db.query(`
  CREATE TABLE IF NOT EXISTS discord_connect_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  )
`)
    
  await setupDesktopDatabase(db)
  await setupPublicationDatabase(db)
  desktopDatabaseReady = true
  console.log('Telegram + Discord + Desktop database ready.')
  } catch (error) {
    desktopDatabaseReady = false

    console.error(
      'Database setup failed:',
      error
    )

    throw error
  }
}

export { app, db, renders, setupDatabase, deleteRender }

async function initializeDatabaseWithRetry() {
  let attempt = 0

  while (!desktopDatabaseReady) {
    attempt += 1

    try {
      await setupDatabase()

      console.log(
        `Database ready after ${attempt} attempt(s).`
      )

      return
    } catch (error) {
      const delayMs =
        Math.min(
          30000,
          2000 * (2 ** Math.min(attempt - 1, 4))
        )

      console.error(
        `Database initialization attempt ${attempt} failed. Retrying in ${delayMs}ms.`
      )

      await new Promise(resolve =>
        setTimeout(resolve, delayMs)
      )
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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

