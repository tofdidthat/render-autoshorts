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
  createStripeBillingPortalSession
} from './stripe.js'

const { Pool } = pg

const db = new Pool({
  connectionString: process.env.DATABASE_URL
})

const execFileAsync = promisify(execFile)

const app = express()
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

async function sendTelegramFile({
  method,
  filePath,
  fieldName,
  fileName,
  mimeType,
  chatId,
  threadId = null,
  caption = ''
}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN

  if (!botToken || !chatId) {
    throw new Error(
      'Variáveis do Telegram não configuradas no Railway.'
    )
  }

  const fileBuffer =
    await fs.promises.readFile(filePath)

  const formData = new FormData()

  formData.append(
    'chat_id',
    String(chatId)
  )

 if (threadId) {
  formData.append(
    'message_thread_id',
    String(threadId)
  )
}

  if (caption) {
    formData.append(
      'caption',
      caption
    )
  }

  formData.append(
    fieldName,
    new Blob(
      [fileBuffer],
      { type: mimeType }
    ),
    fileName
  )

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: 'POST',
      body: formData, signal: AbortSignal.timeout(120000)
    }
  )

  const data =
    await response
      .json()
      .catch(() => ({}))

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.description ||
      `Telegram respondeu HTTP ${response.status}`
    )
  }

  return data
}

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

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'AutoShorts Render',
    temporaryRenders: renders.size
  })
})

const desktopHandlers = {}
const publicationService = createPublicationService({ db, renders, handlers: desktopHandlers,
  backendUrl: () => process.env.BACKEND_PUBLIC_URL, frontendUrl: () => process.env.ONECE_FRONTEND_URL || 'https://1ce.lol' })

const renderAudio = createRenderService({
  execFileAsync, renders, scheduleRenderCleanup, deleteFile
})
let desktopDatabaseReady = false

// Account-owned social links can be disconnected without affecting other accounts.
for (const provider of ['telegram','discord']) {
  app.delete('/account/'+provider+'/connection', async(req,res)=> {
    try {
      const account=await getAccountFromRequest(req)
      if(!account)return res.status(401).json({error:'Invalid 1CE session.'})
      await db.query('DELETE FROM '+provider+'_connections WHERE user_id=$1',[account.id])
      await db.query('DELETE FROM '+provider+'_connect_codes WHERE user_id=$1',[account.id])
      return res.json({disconnected:true})
    }catch{return res.status(500).json({error:'Could not disconnect platform.'})}
  })
}

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

app.post(
  '/render',

  upload.fields([
    {
      name: 'cover',
      maxCount: 1
    },

    {
      name: 'audio',
      maxCount: 1
    }
  ]),

  async (req, res) => {
    const cover =
      req.files?.cover?.[0]

    const audio =
      req.files?.audio?.[0]

    let outputPath = null
    let renderId = null
    let renderSaved = false

    const cleanupInputs = () => {
      deleteFile(cover?.path)
      deleteFile(audio?.path)
    }

    try {
      if (!cover || !audio) {
        cleanupInputs()

        return res.status(400).json({
          error:
            'Envie cover e audio.'
        })
      }

      const render = await renderAudio({ cover, audio })
      renderId = render.id
      outputPath = render.path
      renderSaved = true

      cleanupInputs()

      res.setHeader(
        'Content-Type',
        'video/mp4'
      )

      res.setHeader(
        'Content-Disposition',
        'attachment; filename="autoshorts.mp4"'
      )

      res.setHeader(
        'X-Render-Id',
        renderId
      )

      const stream =
        fs.createReadStream(
          outputPath
        )

      stream.on(
        'error',
        error => {
          console.error(
            'Erro ao enviar MP4:',
            error
          )

          if (!res.headersSent) {
            res.status(500).json({
              error:
                'Falha ao enviar o vídeo.'
            })
          } else {
            res.destroy(error)
          }
        }
      )

      stream.pipe(res)
    } catch (error) {
      console.error(error)

      cleanupInputs()

      if (!renderSaved) {
        deleteFile(outputPath)
      }

      if (!res.headersSent) {
        res.status(500).json({
          error:
            'Falha ao renderizar vídeo.',

          details:
            error?.message
        })
      }
    }
  }
)

// ============================================================
// PREPARA VÍDEO JÁ PRONTO
// Mantém o áudio original ou substitui por outro áudio
// ============================================================

app.post(
  '/prepare-video',

  upload.fields([
    {
      name: 'video',
      maxCount: 1
    },
    {
      name: 'audio',
      maxCount: 1
    }
  ]),

  async (req, res) => {
    const video =
      req.files?.video?.[0]

    const audio =
      req.files?.audio?.[0]

    let outputPath = null
    let renderId = null
    let renderSaved = false

    const cleanupInputs = () => {
      deleteFile(video?.path)
      deleteFile(audio?.path)
    }

    try {
      if (!video) {
        cleanupInputs()

        return res.status(400).json({
          error: 'Envie um vídeo.'
        })
      }

      renderId = crypto.randomUUID()

      outputPath = path.join(
        os.tmpdir(),
        `${renderId}.mp4`
      )

      const startedAt = Date.now()

      if (audio) {
        // Substitui completamente o áudio original
        await execFileAsync(
          'ffmpeg',
          [
            '-y',

            '-i',
            video.path,

            '-i',
            audio.path,

            '-map',
            '0:v:0',

            '-map',
            '1:a:0',

            '-c:v',
            'copy',

            '-c:a',
            'aac',

            '-b:a',
            '192k',

            '-shortest',

            '-movflags',
            '+faststart',

            outputPath
          ]
        )
      } else {
        // Mantém o vídeo e áudio originais.
        // Remux para MP4 sem recodificar o vídeo.
        await execFileAsync(
          'ffmpeg',
          [
            '-y',

            '-i',
            video.path,

            '-map',
            '0:v:0',

            '-map',
            '0:a?',

            '-c',
            'copy',

            '-movflags',
            '+faststart',

            outputPath
          ]
        )
      }

      const ffmpegSeconds =
        (
          (Date.now() - startedAt) /
          1000
        ).toFixed(2)

      console.log(
        `Prepare video terminou em ${ffmpegSeconds}s`
      )

      const stats =
        fs.statSync(outputPath)

      if (!stats.size) {
        throw new Error(
          'O vídeo processado está vazio.'
        )
      }

      renders.set(
        renderId,
        {
          id: renderId,
          path: outputPath,
          size: stats.size,
          mimeType: 'video/mp4',
          createdAt: Date.now()
        }
      )

      renderSaved = true

      scheduleRenderCleanup(renderId)

      console.log(
        `Vídeo temporário salvo: ${renderId} - ${(
          stats.size /
          1024 /
          1024
        ).toFixed(2)} MB`
      )

      cleanupInputs()

      res.setHeader(
        'Content-Type',
        'video/mp4'
      )

      res.setHeader(
        'Content-Disposition',
        'attachment; filename="1ce.mp4"'
      )

      res.setHeader(
        'X-Render-Id',
        renderId
      )

      const stream =
        fs.createReadStream(outputPath)

      stream.on(
        'error',
        error => {
          console.error(
            'Erro ao enviar vídeo:',
            error
          )

          if (!res.headersSent) {
            res.status(500).json({
              error:
                'Falha ao enviar o vídeo.'
            })
          } else {
            res.destroy(error)
          }
        }
      )

      stream.pipe(res)

    } catch (error) {
      console.error(
        'Erro prepare-video:',
        error
      )

      cleanupInputs()

      if (!renderSaved) {
        deleteFile(outputPath)
      }

      if (!res.headersSent) {
        res.status(500).json({
          error:
            'Falha ao preparar vídeo.',

          details:
            error?.message
        })
      }
    }
  }
)

// Verifica render temporário
app.get(
  '/render/:renderId',

  (req, res) => {
    const render =
      renders.get(
        req.params.renderId
      )

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

    const expiresInMs =
      Math.max(
        0,

        RENDER_TTL_MS -
          (
            Date.now() -
            render.createdAt
          )
      )

    res.json({
      ok: true,

      renderId:
        render.id,

      size:
        render.size,

      mimeType:
        render.mimeType,

      expiresInSeconds:
        Math.ceil(
          expiresInMs /
          1000
        )
    })
  }
)


// ============================================================
// INSTAGRAM
// URL pública temporária para a Meta buscar o MP4
// ============================================================

app.get(
  '/public-render/:renderId.mp4',

  (req, res) => {
    const { renderId } = req.params

    const render =
      renders.get(renderId)

    if (
      !render ||
      !fs.existsSync(render.path)
    ) {
      if (render) {
        renders.delete(renderId)
      }

      return res
        .status(404)
        .json({
          error:
            'Render não encontrado ou expirado.'
        })
    }

    res.setHeader(
      'Content-Type',
      'video/mp4'
    )

    res.setHeader(
      'Content-Disposition',
      'inline'
    )

    res.setHeader(
      'Cache-Control',
      'public, max-age=300'
    )

    return res.sendFile(
      path.resolve(render.path)
    )
  }
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
app.delete(
  '/render/:renderId',

  (req, res) => {
    const deleted =
      deleteRender(
        req.params.renderId
      )

    if (!deleted) {
      return res
        .status(404)
        .json({
          error:
            'Render não encontrado.'
        })
    }

    res.json({
      ok: true
    })
  }
)


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

app.post('/telegram/connect-code', async (req, res) => {
  try {
    const {
      clientId
    } = req.body || {}

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
      })
    }

    const account = await getAccountFromRequest(req)

    if (!account) {
      return res.status(401).json({
        error: 'Invalid 1CE session.'
      })
    }

    if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(503).json({
        error:
          'Telegram account linking requires TELEGRAM_WEBHOOK_SECRET in Railway and secret_token in setWebhook.'
      })
    }
    const code =
      crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase()

    await db.query(
      `
        INSERT INTO telegram_connect_codes (
          code,
          client_id,
          user_id,
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
        code,
        String(clientId),
        account.id
      ]
    )

    return res.json({
      ok: true,
      code,
      botUsername: 'oncetelegrambot'
    })

  } catch (error) {
    console.error(
      'Telegram connect code error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to create Telegram connection code.'
    })
  }
})

async function sendTelegramMessage(
  chatId,
  threadId,
  text
) {
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN

  if (!botToken || !chatId) {
    return
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          chat_id: chatId,

          ...(threadId
            ? {
                message_thread_id:
                  threadId
              }
            : {}),

          text
        })
      }
    )

  const data =
    await response
      .json()
      .catch(() => ({}))

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.description ||
      'Telegram message failed.'
    )
  }
}

// ============================================================
// TELEGRAM CONNECTION STATUS
// Verifica se este navegador já conectou um Telegram
// ============================================================

app.get('/telegram/connect-status', async (req, res) => {
  try {
    const clientId =
      String(req.query.clientId || '').trim()

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
      })
    }

    const account = req.headers.authorization ? await getAccountFromRequest(req) : null
    if (req.headers.authorization && !account) return res.status(401).json({ error: 'Invalid 1CE session.' })
    const result =
      await db.query(
        `
          SELECT
            chat_title,
            thread_id,
            created_at
          FROM telegram_connections
          WHERE ${account ? 'user_id' : 'client_id'} = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [account ? account.id : clientId]
      )

    if (!result.rows.length) {
      return res.json({
        ok: true,
        connected: false
      })
    }

    const connection =
      result.rows[0]

    return res.json({
      ok: true,
      connected: true,

      connection: {
        chatTitle:
          connection.chat_title,

        threadId:
          connection.thread_id,

        connectedAt:
          connection.created_at
      }
    })

  } catch (error) {
    console.error(
      'Telegram connection status error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to check Telegram connection.'
    })
  }
})

// ============================================================
// TELEGRAM WEBHOOK
// Conecta grupo/tópico ao usuário da 1CE
// ============================================================

app.post('/telegram/webhook', async (req, res) => {
  try {
    const received =
      req.headers['x-telegram-bot-api-secret-token']

    const expected =
      process.env.TELEGRAM_WEBHOOK_SECRET

    if (
      !received ||
      !expected ||
      typeof received !== 'string' ||
      Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(
        Buffer.from(received),
        Buffer.from(expected)
      )
    ) {
      return res.sendStatus(401)
    }

    const update = req.body || {}

    const message =
      update.message ||
      update.channel_post

    if (!message) {
      return res.json({ ok: true })
    }

    const text =
      String(message.text || '').trim()

    if (!text.startsWith('/connect')) {
      return res.json({ ok: true })
    }

    const parts =
      text.split(/\s+/)

    const code =
      String(parts[1] || '')
        .trim()
        .toUpperCase()

    const chatId =
      message.chat?.id

    const chatTitle =
      message.chat?.title ||
      message.chat?.username ||
      'Telegram'

    const threadId =
      message.message_thread_id || null

    if (!code) {
      await sendTelegramMessage(
        chatId,
        threadId,
        '❌ Connection code missing. Use /connect CODE'
      )

      return res.json({ ok: true })
    }

    if (!chatId) {
      return res.json({ ok: true })
    }

    const codeResult =
      await db.query(
        `
          SELECT
            code,
            client_id, user_id
          FROM telegram_connect_codes
          WHERE code = $1
            AND used_at IS NULL
            AND expires_at > NOW()
          LIMIT 1
        `,
        [code]
      )

    if (!codeResult.rows.length) {
      await sendTelegramMessage(
        chatId,
        threadId,
        '❌ Invalid or expired connection code.'
      )

      return res.json({ ok: true })
    }

    const claimed=await db.query(`UPDATE telegram_connect_codes SET used_at=NOW()
      WHERE code=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING code`,[code])
    if (!claimed.rowCount) return res.json({ok:true})

    const clientId =
      codeResult.rows[0].client_id

    await db.query(
      `
        INSERT INTO telegram_connections (
          client_id,
          chat_id,
          chat_title,
          thread_id, user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (
          client_id,
          chat_id,
          thread_id
        )
        DO UPDATE SET
          chat_title = EXCLUDED.chat_title,
          user_id = EXCLUDED.user_id
      `,
      [
        clientId,
        String(chatId),
        String(chatTitle),
        threadId
          ? String(threadId)
          : null,
        codeResult.rows[0].user_id
      ]
    )

    await db.query(
      `
        UPDATE telegram_connect_codes
        SET used_at = NOW()
        WHERE code = $1
      `,
      [code]
    )

    console.log(
      'Telegram conectado:',
      {
        clientId,
        chatId,
        chatTitle,
        threadId
      }
    )

    await sendTelegramMessage(
      chatId,
      threadId,
      '✅ Connected to 1CE!'
    )

    return res.json({
      ok: true
    })

  } catch (error) {
    console.error(
      'Telegram webhook error:',
      error
    )

    return res
      .status(500)
      .json({
        error:
          'Telegram webhook error.'
      })
  }
})
// ============================================================
// TELEGRAM
// Envia imagem + áudio para o tópico NEW BEATS
// ============================================================

app.post(
  '/publish-telegram',

  desktopHandlers.telegram = async (req, res) => {
    const {
  renderId,
  title,
  description,
  audioFileName
} = req.body || {}
    let imagePath = null
    let audioPath = null

    try {
      if (!renderId) {
        return res.status(400).json({
          error: 'renderId não informado.'
        })
      }

      let connectionResult

      if (req.publicationConnection) {
        connectionResult = {
          rows: [req.publicationConnection]
        }
      } else {
        const account = await getAccountFromRequest(req)

        if (!account) {
          return res.status(401).json({
            error: 'Invalid 1CE session.'
          })
        }

        connectionResult = await db.query(
          `
            SELECT
              chat_id,
              thread_id,
              chat_title
            FROM telegram_connections
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [account.id]
        )
      }

      if (!connectionResult.rows.length) {
        return res.status(404).json({
          error:
            'Telegram não conectado.'
        })
      }

      const connection =
        connectionResult.rows[0]

      const chatId =
        connection.chat_id

      const threadId =
        connection.thread_id || null

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

      imagePath = path.join(
        os.tmpdir(),
        `${renderId}-telegram.jpg`
      )

      audioPath = path.join(
        os.tmpdir(),
        `${renderId}-telegram.mp3`
      )

      // -------------------------------------------------------
      // Extrai um frame do vídeo
      // -------------------------------------------------------

      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-ss', '1',
            '-i', render.path,
            '-frames:v', '1',
            '-q:v', '2',
            imagePath
          ]
        )
      } catch {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i', render.path,
            '-frames:v', '1',
            '-q:v', '2',
            imagePath
          ]
        )
      }

      // -------------------------------------------------------
      // Extrai o áudio do vídeo
      // -------------------------------------------------------

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i', render.path,
          '-vn',
          '-c:a', 'libmp3lame',
          '-b:a', '192k',
          audioPath
        ]
      )

      const safeTitle =
        String(title || 'New Beat')
          .trim()
          .slice(0, 100)

      const safeDescription =
  String(description || '')
    .trim()
    .slice(0, 900)

const originalAudioName =
  String(
    audioFileName ||
    `${safeTitle}.mp3`
  )
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.[^.]+$/, '') + '.mp3'

const telegramCaption =
  safeDescription
    ? `🔥 ${safeTitle}\n\n${safeDescription}`
    : `🔥 ${safeTitle}`

      // -------------------------------------------------------
      // 1. Envia a imagem
      // -------------------------------------------------------

      await sendTelegramFile({
        method: 'sendPhoto',
        filePath: imagePath,
        fieldName: 'photo',
        fileName: 'cover.jpg',
        mimeType: 'image/jpeg',
        chatId,
        threadId,
        caption: telegramCaption
      })

      // -------------------------------------------------------
      // 2. Envia o áudio
      // -------------------------------------------------------

      await sendTelegramFile({
        method: 'sendAudio',
        filePath: audioPath,
        fieldName: 'audio',
       fileName: originalAudioName,
        mimeType: 'audio/mpeg',
        chatId,
        threadId,
        caption: ''
      })

      console.log(
        `Telegram publicado: ${renderId} -> ${connection.chat_title}`
      )

      return res.json({
        ok: true,
        renderId
      })

    } catch (error) {
      console.error(
        'Erro Telegram:',
        error
      )

      return res.status(500).json({
        error:
          'Falha ao publicar no Telegram.',

        details:
          error?.message
      })

    } finally {
      deleteFile(imagePath)
      deleteFile(audioPath)
    }
  }
)

// ============================================================
// DISCORD CONNECT
// Gera código temporário para conectar um canal
// ============================================================

app.post('/discord/connect-code', async (req, res) => {
  try {
    const {
      clientId
    } = req.body || {}

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
      })
    }

    const account = req.headers.authorization ? await getAccountFromRequest(req) : null
    if (req.headers.authorization && !account) return res.status(401).json({ error: 'Invalid 1CE session.' })
    const code =
      crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase()

    await db.query(
      `
        INSERT INTO discord_connect_codes (
          code,
          client_id,
          user_id,
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
        code,
        String(clientId),
        account?.id || null
      ]
    )

    return res.json({
      ok: true,
      code
    })

  } catch (error) {
    console.error(
      'Discord connect code error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to create Discord connection code.'
    })
  }
})

// ============================================================
// DISCORD CONNECTION STATUS
// Verifica se este navegador já conectou um Discord
// ============================================================

app.get('/discord/connect-status', async (req, res) => {
  try {
    const clientId =
      String(req.query.clientId || '').trim()

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
      })
    }

    const account = req.headers.authorization ? await getAccountFromRequest(req) : null
    if (req.headers.authorization && !account) return res.status(401).json({ error: 'Invalid 1CE session.' })
    const result =
      await db.query(
        `
          SELECT
            guild_id,
            guild_name,
            channel_id,
            channel_name,
            created_at
          FROM discord_connections
          WHERE ${account ? 'user_id' : 'client_id'} = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [account ? account.id : clientId]
      )

    if (!result.rows.length) {
      return res.json({
        ok: true,
        connected: false
      })
    }

    const connection =
      result.rows[0]

    return res.json({
      ok: true,
      connected: true,

      connection: {
        guildId:
          connection.guild_id,

        guildName:
          connection.guild_name,

        channelId:
          connection.channel_id,

        channelName:
          connection.channel_name,

        connectedAt:
          connection.created_at
      }
    })

  } catch (error) {
    console.error(
      'Discord connection status error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to check Discord connection.'
    })
  }
})

function verifyDiscordRequest(req) {
  try {
    const signature =
      req.headers['x-signature-ed25519']

    const timestamp =
      req.headers['x-signature-timestamp']

    const publicKey =
      process.env.DISCORD_PUBLIC_KEY

    if (
      !signature ||
      !timestamp ||
      !publicKey ||
      !req.rawBody
    ) {
      return false
    }

    const message =
      Buffer.concat([
        Buffer.from(timestamp),
        req.rawBody
      ])

    const publicKeyDer =
      Buffer.concat([
        Buffer.from(
          '302a300506032b6570032100',
          'hex'
        ),

        Buffer.from(
          publicKey,
          'hex'
        )
      ])

    return crypto.verify(
      null,
      message,
      {
        key: publicKeyDer,
        format: 'der',
        type: 'spki'
      },
      Buffer.from(signature, 'hex')
    )

  } catch (error) {
    console.error(
      'Discord signature verification error:',
      error
    )

    return false
  }
}

// ============================================================
// DISCORD INTERACTIONS
// Recebe o comando /connect
// ============================================================

app.post('/discord/interactions', async (req, res) => {
  try {

    if (!verifyDiscordRequest(req)) {
  return res
    .status(401)
    .send('Invalid request signature')
}
    const interaction = req.body || {}

    // Discord verifica o endpoint com um PING
    if (interaction.type === 1) {
      return res.json({
        type: 1
      })
    }

    // Slash command
    if (
      interaction.type === 2 &&
      interaction.data?.name === 'connect'
    ) {
      const code =
        String(
          interaction.data?.options?.find(
            option => option.name === 'code'
          )?.value || ''
        )
          .trim()
          .toUpperCase()

      const guildId =
        String(interaction.guild_id || '')

      const channelId =
        String(interaction.channel_id || '')

      const guildName =
        String(
          interaction.guild?.name ||
          'Discord'
        )

      const channelName =
        String(
          interaction.channel?.name ||
          'Discord Channel'
        )

      if (!code) {
        return res.json({
          type: 4,
          data: {
            content:
              '❌ Connection code missing.',
            flags: 64
          }
        })
      }

      const codeResult =
        await db.query(
          `
            SELECT
              code,
              client_id, user_id
            FROM discord_connect_codes
            WHERE code = $1
              AND used_at IS NULL
              AND expires_at > NOW()
            LIMIT 1
          `,
          [code]
        )

      if (!codeResult.rows.length) {
        return res.json({
          type: 4,
          data: {
            content:
              '❌ Invalid or expired connection code.',
            flags: 64
          }
        })
      }

      const claimed=await db.query(`UPDATE discord_connect_codes SET used_at=NOW()
        WHERE code=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING code`,[code])
      if (!claimed.rowCount) return res.json({type:4,data:{content:'Invalid or already used connection code.',flags:64}})
      const clientId =
        codeResult.rows[0].client_id

      await db.query(
        `
          INSERT INTO discord_connections (
            client_id,
            guild_id,
            guild_name,
            channel_id,
            channel_name, user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (
            client_id,
            guild_id,
            channel_id
          )
          DO UPDATE SET
            guild_name = EXCLUDED.guild_name,
            channel_name = EXCLUDED.channel_name,
            user_id = EXCLUDED.user_id
        `,
        [
          clientId,
          guildId,
          guildName,
          channelId,
          channelName,
          codeResult.rows[0].user_id
        ]
      )

      await db.query(
        `
          UPDATE discord_connect_codes
          SET used_at = NOW()
          WHERE code = $1
        `,
        [code]
      )

      console.log(
        'Discord conectado:',
        {
          clientId,
          guildId,
          channelId,
          channelName
        }
      )

      return res.json({
        type: 4,
        data: {
          content:
            '✅ Connected to 1CE!',
          flags: 64
        }
      })
    }

    return res.json({
      type: 4,
      data: {
        content: 'Unknown command.',
        flags: 64
      }
    })

  } catch (error) {
    console.error(
      'Discord interaction error:',
      error
    )

    return res.status(500).json({
      error:
        'Discord interaction error.'
    })
  }
})

// ============================================================
// DISCORD PUBLISH
// Envia capa + título/descrição + áudio
// ============================================================

app.post('/publish-discord', desktopHandlers.discord = async (req, res) => {
  const {
    renderId,
    title,
    description,
    audioFileName
  } = req.body || {}

  let imagePath = null
  let audioPath = null

  try {
    if (!renderId) {
      return res.status(400).json({
        error: 'renderId não informado.'
      })
    }

    const botToken =
      process.env.DISCORD_BOT_TOKEN

    if (!botToken) {
      return res.status(500).json({
        error:
          'Discord bot não configurado.'
      })
    }

    // -------------------------------------------------------
    // Busca o canal Discord conectado
    // -------------------------------------------------------

    let connectionResult

    if (req.publicationConnection) {
      connectionResult = {
        rows: [req.publicationConnection]
      }
    } else {
      const account = await getAccountFromRequest(req)

      if (!account) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      connectionResult = await db.query(
        `
          SELECT
            guild_id,
            channel_id,
            channel_name
          FROM discord_connections
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [account.id]
      )
    }

    if (!connectionResult.rows.length) {
      return res.status(404).json({
        error:
          'Discord não conectado.'
      })
    }

    const connection =
      connectionResult.rows[0]

    const channelId =
      connection.channel_id

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

    imagePath = path.join(
      os.tmpdir(),
      `${renderId}-discord.jpg`
    )

    audioPath = path.join(
      os.tmpdir(),
      `${renderId}-discord.mp3`
    )

    // -------------------------------------------------------
    // Extrai a capa do vídeo
    // -------------------------------------------------------

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss', '1',
          '-i', render.path,
          '-frames:v', '1',
          '-q:v', '2',
          imagePath
        ]
      )
    } catch {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i', render.path,
          '-frames:v', '1',
          '-q:v', '2',
          imagePath
        ]
      )
    }

    // -------------------------------------------------------
    // Extrai MP3
    // -------------------------------------------------------

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', render.path,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '192k',
        audioPath
      ]
    )

    const safeTitle =
      String(title || 'New Beat')
        .trim()
        .slice(0, 100)

    const safeDescription =
      String(description || '')
        .trim()
        .slice(0, 1800)

    const originalAudioName =
      String(
        audioFileName ||
        `${safeTitle}.mp3`
      )
        .trim()
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\.[^.]+$/, '') +
      '.mp3'

    const discordMessage =
      safeDescription
        ? `🔥 ${safeTitle}\n\n${safeDescription}`
        : `🔥 ${safeTitle}`

   // -------------------------------------------------------
// Envia capa + áudio na MESMA mensagem
// -------------------------------------------------------

const imageBuffer =
  await fs.promises.readFile(
    imagePath
  )

const audioBuffer =
  await fs.promises.readFile(
    audioPath
  )

const discordForm =
  new FormData()

discordForm.append(
  'payload_json',
  JSON.stringify({
    content: discordMessage,

    attachments: [
      {
        id: 0,
        filename: 'cover.jpg'
      },
      {
        id: 1,
        filename: originalAudioName
      }
    ]
  })
)

discordForm.append(
  'files[0]',
  new Blob(
    [imageBuffer],
    {
      type: 'image/jpeg'
    }
  ),
  'cover.jpg'
)

discordForm.append(
  'files[1]',
  new Blob(
    [audioBuffer],
    {
      type: 'audio/mpeg'
    }
  ),
  originalAudioName
)

const discordResponse =
  await (req.publicationFetch || fetch)(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: 'POST',

      headers: {
        Authorization:
          `Bot ${botToken}`
      },

      body: discordForm
    }
  )

const discordData =
  await discordResponse
    .json()
    .catch(() => ({}))

if (!discordResponse.ok) {
  throw new Error(
    discordData?.message ||
    `Discord respondeu HTTP ${discordResponse.status}`
  )
}

    console.log(
      `Discord publicado: ${renderId} -> ${connection.channel_name}`
    )

    return res.json({
      ok: true,
      renderId
    })

  } catch (error) {
    console.error(
      'Erro Discord:',
      error
    )

    return res.status(500).json({
      error:
        'Falha ao publicar no Discord.',

      details:
        error?.message
    })

  } finally {
    deleteFile(imagePath)
    deleteFile(audioPath)
  }
})


// ============================================================
// DISCORD
// Registra o comando /connect no servidor de teste
// ============================================================

async function registerDiscordCommands() {
  try {
    const botToken =
      process.env.DISCORD_BOT_TOKEN

    const applicationId =
      process.env.DISCORD_APPLICATION_ID

    const guildId =
      process.env.DISCORD_GUILD_ID

    if (
      !botToken ||
      !applicationId ||
      !guildId
    ) {
      console.log(
        'Discord variables not configured.'
      )
      return
    }

    const response = await fetch(
      `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bot ${botToken}`,

          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          name: 'connect',

          description:
            'Connect this Discord channel to 1CE',

          options: [
            {
              name: 'code',

              description:
                'Connection code generated by 1CE',

              type: 3,

              required: true
            }
          ]
        })
      }
    )

    const data =
      await response
        .json()
        .catch(() => ({}))

    if (!response.ok) {
      throw new Error(
        data?.message ||
        `Discord HTTP ${response.status}`
      )
    }

    console.log(
      'Discord /connect command ready.'
    )

  } catch (error) {
    console.error(
      'Discord command registration error:',
      error
    )
  }
}

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


function hashOAuthTransactionId(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
}

app.post('/account/oauth/start', async (req, res) => {
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

app.post('/account/oauth/complete', async (req, res) => {
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
  const recent = await db.query(
    `SELECT created_at FROM account_password_resets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  )

  if (recent.rows.length) {
    const elapsed = Date.now() - new Date(recent.rows[0].created_at).getTime()
    if (elapsed < EMAIL_RESEND_COOLDOWN_SECONDS * 1000) {
      const error = new Error('Please wait before requesting another code.')
      error.statusCode = 429
      throw error
    }
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const codeHash = hashEmailVerificationCode(code)

  await db.query(
    `UPDATE account_password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  )

  const inserted = await db.query(
    `INSERT INTO account_password_resets (user_id, code_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute')) RETURNING id`,
    [userId, codeHash, EMAIL_CODE_TTL_MINUTES]
  )

  try {
    await sendPasswordResetEmail(email, code)
  } catch (error) {
    await db.query(`DELETE FROM account_password_resets WHERE id = $1`, [inserted.rows[0].id]).catch(() => {})
    throw error
  }
}

async function issueEmailVerificationCode(userId, email) {
  const recent = await db.query(
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
      Date.now() - new Date(recent.rows[0].created_at).getTime()

    if (elapsed < EMAIL_RESEND_COOLDOWN_SECONDS * 1000) {
      const error = new Error('Please wait before requesting another code.')
      error.statusCode = 429
      throw error
    }
  }

  const code = String(
    crypto.randomInt(0, 1000000)
  ).padStart(6, '0')

  const codeHash = hashEmailVerificationCode(code)

  await db.query(
    `
      UPDATE account_email_verifications
      SET used_at = NOW()
      WHERE user_id = $1
        AND used_at IS NULL
    `,
    [userId]
  )

  const inserted = await db.query(
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
    [userId, codeHash, EMAIL_CODE_TTL_MINUTES]
  )

  try {
    await sendAccountVerificationEmail(email, code)
  } catch (error) {
    await db.query(
      `DELETE FROM account_email_verifications WHERE id = $1`,
      [inserted.rows[0].id]
    ).catch(() => {})

    throw error
  }
}

app.post('/account/email/register', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    const password = String(req.body?.password || '')
    const name = String(req.body?.name || '').trim().slice(0, 120)

    if (!isValidAccountEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' })
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: 'Password must contain between 8 and 128 characters.'
      })
    }

    const existing = await db.query(
      `
        SELECT id, password_hash, email_verified
        FROM account_users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    )

    let userId

    if (existing.rows.length) {
      const user = existing.rows[0]

      if (user.email_verified || user.password_hash) {
        return res.status(409).json({
          error: 'An account with this email already exists.'
        })
      }

      const passwordHash = await hashAccountPassword(password)

      const updated = await db.query(
        `
          UPDATE account_users
          SET password_hash = $1,
              name = COALESCE(NULLIF($2, ''), name),
              updated_at = NOW()
          WHERE id = $3
          RETURNING id
        `,
        [passwordHash, name, user.id]
      )

      userId = updated.rows[0].id
    } else {
      const passwordHash = await hashAccountPassword(password)

      const created = await db.query(
        `
          INSERT INTO account_users (
            email,
            password_hash,
            email_verified,
            name,
            updated_at
          )
          VALUES ($1, $2, FALSE, $3, NOW())
          RETURNING id
        `,
        [email, passwordHash, name]
      )

      userId = created.rows[0].id
    }

    await issueEmailVerificationCode(userId, email)

    return res.status(201).json({
      ok: true,
      verificationRequired: true,
      email
    })
  } catch (error) {
    console.error('Email register error:', error)

    return res
      .status(error?.statusCode || 500)
      .json({
        error:
          error?.statusCode === 429
            ? error.message
            : 'Unable to create account.'
      })
  }
})

app.post('/account/email/verify', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()

    if (!isValidAccountEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid email or code.' })
    }

    const userResult = await db.query(
      `
        SELECT id, email_verified
        FROM account_users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    )

    if (!userResult.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const user = userResult.rows[0]

    if (user.email_verified) {
      return res.status(409).json({ error: 'Email is already verified.' })
    }

    const verificationResult = await db.query(
      `
        SELECT id, code_hash, attempts
        FROM account_email_verifications
        WHERE user_id = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [user.id]
    )

    if (!verificationResult.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const verification = verificationResult.rows[0]

    if (verification.attempts >= EMAIL_MAX_ATTEMPTS) {
      return res.status(429).json({
        error: 'Too many attempts. Request a new code.'
      })
    }

    const receivedHash = hashEmailVerificationCode(code)
    const expected = Buffer.from(verification.code_hash, 'hex')
    const received = Buffer.from(receivedHash, 'hex')

    const valid =
      expected.length === received.length &&
      crypto.timingSafeEqual(expected, received)

    if (!valid) {
      await db.query(
        `
          UPDATE account_email_verifications
          SET attempts = attempts + 1
          WHERE id = $1
        `,
        [verification.id]
      )

      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const client = await db.connect()

    try {
      await client.query('BEGIN')

      await client.query(
        `
          UPDATE account_users
          SET email_verified = TRUE,
              updated_at = NOW()
          WHERE id = $1
        `,
        [user.id]
      )

      await client.query(
        `
          UPDATE account_email_verifications
          SET used_at = NOW()
          WHERE user_id = $1
            AND used_at IS NULL
        `,
        [user.id]
      )

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const sessionToken = await createAccountSession(user.id)

    return res.json({
      ok: true,
      verified: true,
      session: sessionToken
    })
  } catch (error) {
    console.error('Email verification error:', error)
    return res.status(500).json({ error: 'Unable to verify email.' })
  }
})

app.post('/account/email/resend', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)

    if (!isValidAccountEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' })
    }

    const result = await db.query(
      `
        SELECT id, email_verified, password_hash
        FROM account_users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    )

    if (!result.rows.length || result.rows[0].email_verified) {
      return res.json({ ok: true })
    }

    if (!result.rows[0].password_hash) {
      return res.json({ ok: true })
    }

    await issueEmailVerificationCode(result.rows[0].id, email)

    return res.json({ ok: true })
  } catch (error) {
    console.error('Email resend error:', error)

    return res
      .status(error?.statusCode || 500)
      .json({
        error:
          error?.statusCode === 429
            ? error.message
            : 'Unable to resend verification code.'
      })
  }
})

app.post('/account/password/forgot', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    if (!isValidAccountEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' })
    }

    const result = await db.query(
      `SELECT id FROM account_users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    )

    // Generic response prevents account enumeration.
    if (!result.rows.length) {
      return res.json({ ok: true })
    }

    await issuePasswordResetCode(result.rows[0].id, email)
    return res.json({ ok: true })
  } catch (error) {
    console.error('Password forgot error:', error)
    return res.status(error?.statusCode || 500).json({
      error: error?.statusCode === 429 ? error.message : 'Unable to request password reset.'
    })
  }
})

app.post('/account/password/verify', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()

    if (!isValidAccountEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid email or code.' })
    }

    const userResult = await db.query(
      `SELECT id FROM account_users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    )
    if (!userResult.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const resetResult = await db.query(
      `SELECT id, code_hash, attempts FROM account_password_resets
       WHERE user_id = $1 AND used_at IS NULL AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userResult.rows[0].id]
    )
    if (!resetResult.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const reset = resetResult.rows[0]
    if (reset.attempts >= EMAIL_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many attempts. Request a new code.' })
    }

    const expected = Buffer.from(reset.code_hash, 'hex')
    const received = Buffer.from(hashEmailVerificationCode(code), 'hex')
    const valid = expected.length === received.length && crypto.timingSafeEqual(expected, received)

    if (!valid) {
      await db.query(`UPDATE account_password_resets SET attempts = attempts + 1 WHERE id = $1`, [reset.id])
      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const resetToken = crypto.randomBytes(32).toString('hex')
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex')

    await db.query(
      `UPDATE account_password_resets
       SET verified_at = NOW(), reset_token_hash = $1, reset_token_expires_at = NOW() + INTERVAL '10 minutes'
       WHERE id = $2`,
      [resetTokenHash, reset.id]
    )

    return res.json({ ok: true, resetToken })
  } catch (error) {
    console.error('Password reset verify error:', error)
    return res.status(500).json({ error: 'Unable to verify reset code.' })
  }
})

app.post('/account/password/reset', async (req, res) => {
  try {
    const resetToken = String(req.body?.resetToken || '')
    const password = String(req.body?.password || '')

    if (!resetToken || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Invalid reset token or password.' })
    }

    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex')
    const resetResult = await db.query(
      `SELECT id, user_id FROM account_password_resets
       WHERE reset_token_hash = $1 AND verified_at IS NOT NULL AND used_at IS NULL
         AND reset_token_expires_at > NOW()
       LIMIT 1`,
      [resetTokenHash]
    )
    if (!resetResult.rows.length) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' })
    }

    const reset = resetResult.rows[0]
    const passwordHash = await hashAccountPassword(password)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE account_users SET password_hash = $1, email_verified = TRUE, updated_at = NOW() WHERE id = $2`,
        [passwordHash, reset.user_id]
      )
      await client.query(`UPDATE account_password_resets SET used_at = NOW() WHERE id = $1`, [reset.id])
      // Sign out existing sessions after a password reset.
      await client.query(`DELETE FROM account_sessions WHERE user_id = $1`, [reset.user_id])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    return res.json({ ok: true })
  } catch (error) {
    console.error('Password reset error:', error)
    return res.status(500).json({ error: 'Unable to reset password.' })
  }
})


app.post('/account/email/login', async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email)
    const password = String(req.body?.password || '')

    if (!isValidAccountEmail(email) || !password) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    const result = await db.query(
      `
        SELECT id, password_hash, email_verified
        FROM account_users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    )

    const user = result.rows[0]

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    const validPassword = await verifyAccountPassword(
      password,
      user.password_hash
    )

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Email verification required.',
        verificationRequired: true
      })
    }

    const sessionToken = await createAccountSession(user.id)

    return res.json({
      ok: true,
      session: sessionToken
    })
  } catch (error) {
    console.error('Email login error:', error)
    return res.status(500).json({ error: 'Unable to sign in.' })
  }
})


// ------------------------------------------------------------
// INICIA LOGIN GOOGLE
// ------------------------------------------------------------

app.get(
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

    let state = crypto.randomBytes(24).toString('hex')
    if (req.query.desktop_user_code !== undefined || req.query.desktop_publication !== undefined) {
      if (!desktopDatabaseReady) return res.sendStatus(503)
      try { state = await startDesktopGoogle(req, res, db) }
      catch { return res.status(400).json({ error: 'Invalid desktop authorization.' }) }
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

app.get(
  '/account/google/callback',

  async (req, res) => {
    try {
      const desktopState = String(req.query.state || '').startsWith('desktop_')
      const desktopCode = desktopState ? await consumeDesktopGoogle(req, res, db) : null
      const code =
        String(req.query.code || '')

      if (!code) {
        return res.redirect(
          `${ONECE_FRONTEND_URL}/app?login=error`
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

      // Cria sessão própria da 1CE
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

      if (desktopCode) {
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

      // Token vai no fragmento (#), não na query string.
      // O fragmento não é enviado ao servidor da Vercel.
      res.redirect(
        `${ONECE_FRONTEND_URL}/app#session=${encodeURIComponent(sessionToken)}`
      )

    } catch (error) {
      console.error(
        '1CE Google login error:',
        error
      )

      res.redirect(
        `${ONECE_FRONTEND_URL}/app?login=error`
      )
    }
  }
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
  priceId = null,
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
  queryClient = db
}) {
  if (!userId) return

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
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, stripe_subscriptions.stripe_customer_id),
        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, stripe_subscriptions.stripe_subscription_id),
        status = EXCLUDED.status,
        price_id = COALESCE(EXCLUDED.price_id, stripe_subscriptions.price_id),
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = NOW()
    `,
    [
      Number(userId),
      customerId ? String(customerId) : null,
      subscriptionId ? String(subscriptionId) : null,
      String(status || 'inactive'),
      priceId ? String(priceId) : null,
      currentPeriodEnd
        ? new Date(Number(currentPeriodEnd) * 1000)
        : null,
      Boolean(cancelAtPeriodEnd)
    ]
  )
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
      const userId = object.client_reference_id || object.metadata?.onece_user_id

      if (userId && object.subscription) {
        await upsertStripeSubscription({
          userId,
          customerId: object.customer,
          subscriptionId: object.subscription,
          status: object.payment_status === 'paid' ? 'active' : 'incomplete',
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
        await findStripeUserIdBySubscription(object.id, client)

      if (userId) {
        await upsertStripeSubscription({
          userId,
          customerId: object.customer,
          subscriptionId: object.id,
          status: event.type === 'customer.subscription.deleted'
            ? 'canceled'
            : object.status,
          priceId: object.items?.data?.[0]?.price?.id || null,
          currentPeriodEnd: object.current_period_end || null,
          cancelAtPeriodEnd: object.cancel_at_period_end || false,
          queryClient: client
        })
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const subscriptionId =
        typeof object.subscription === 'string'
          ? object.subscription
          : object.subscription?.id

      const userId = await findStripeUserIdBySubscription(subscriptionId, client)

      if (userId) {
        await upsertStripeSubscription({
          userId,
          customerId: object.customer,
          subscriptionId,
          status: 'past_due',
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

app.get(
  '/account/me',

  async (req, res) => {
    try {
      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res
          .status(401)
          .json({
            authenticated: false
          })
      }

      const subscriptionResult = await db.query(
        `
          SELECT
            status,
            stripe_customer_id,
            stripe_subscription_id,
            price_id,
            current_period_end,
            cancel_at_period_end
          FROM stripe_subscriptions
          WHERE user_id = $1
          LIMIT 1
        `,
        [user.id]
      )

      const subscription = subscriptionResult.rows[0] || null
      const plan = stripePlanFromStatus(subscription?.status)

      res.json({
        authenticated: true,
        plan,
        subscription: subscription
          ? {
              status: subscription.status,
              currentPeriodEnd: subscription.current_period_end,
              cancelAtPeriodEnd: subscription.cancel_at_period_end
            }
          : null,

        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
          plan
        }
      })

    } catch (error) {
      console.error(
        'Account me error:',
        error
      )

      res.status(500).json({
        error:
          'Falha ao verificar conta.'
      })
    }
  }
)


// ------------------------------------------------------------
// LOGOUT
// ------------------------------------------------------------

app.post(
  '/account/logout',

  async (req, res) => {
    try {
      const authorization =
        req.headers.authorization || ''

      if (
        authorization.startsWith(
          'Bearer '
        )
      ) {
        const token =
          authorization
            .slice(7)
            .trim()

        if (token) {
          const tokenHash =
            hashAccountSessionToken(
              token
            )

          await db.query(
            `
              DELETE FROM account_sessions
              WHERE token_hash = $1
            `,
            [tokenHash]
          )
        }
      }

      res.json({
        ok: true
      })

    } catch (error) {
      console.error(
        'Account logout error:',
        error
      )

      res.status(500).json({
        error:
          'Falha ao encerrar sessão.'
      })
    }
  }
)

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

      const session =
        await createStripeCheckoutSession({
          market,
          customerEmail: user.email,
          userId: user.id
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

app.post(
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

app.get(
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

app.patch(
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

app.delete(
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

app.post(
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

app.get(
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

app.patch(
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

app.delete(
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

app.post(
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

app.get(
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

app.patch(
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
// DESCONECTAR INSTAGRAM
// ------------------------------------------------------------

app.delete(
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

async function setupDatabase() {
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
  CREATE INDEX IF NOT EXISTS
    instagram_connections_user_id_idx
  ON instagram_connections(user_id)
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
    console.error(
      'Error preparing Telegram database:',
      error
    )
  }
}

export { app, db, renders, setupDatabase, deleteRender }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
setupDatabase()
registerDiscordCommands()
app.listen(
  port,
  '0.0.0.0',

  () => {
    console.log(
      `Render server listening on port ${port}`
    )
  }
)
}

