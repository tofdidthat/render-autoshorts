import express from 'express'
import multer from 'multer'
import fs from 'fs'
import pg from 'pg'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

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
      '/discord/interactions'
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
    'GET, POST, DELETE, OPTIONS'
  )

  res.setHeader(
  'Access-Control-Allow-Headers',
  'Content-Type, Authorization'
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

  deleteFile(render.path)

  renders.delete(renderId)

  console.log(
    `Render removido: ${renderId}`
  )

  return true
}

function scheduleRenderCleanup(renderId) {
  setTimeout(() => {
    deleteRender(renderId)
  }, RENDER_TTL_MS)
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
      body: formData
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

      renderId =
        crypto.randomUUID()

      outputPath = path.join(
        os.tmpdir(),
        `${renderId}.mp4`
      )

      const startedAt =
        Date.now()

      await execFileAsync(
        'ffmpeg',
        [
          '-y',

          '-framerate',
          '1',

          '-loop',
          '1',

          '-i',
          cover.path,

          '-i',
          audio.path,

          '-c:v',
          'libx264',

          '-preset',
          'ultrafast',

          '-tune',
          'stillimage',

          '-vf',
          'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',

          '-pix_fmt',
          'yuv420p',

          '-r',
          '30',

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

      const ffmpegSeconds =
        (
          (
            Date.now() -
            startedAt
          ) /
          1000
        ).toFixed(2)

      console.log(
        `FFmpeg terminou em ${ffmpegSeconds}s`
      )

      const stats =
        fs.statSync(outputPath)

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

      scheduleRenderCleanup(
        renderId
      )

      console.log(
        `Render temporário salvo: ${renderId} - ${(
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

  async (req, res) => {
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
          await fetch(
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

  async (req, res) => {
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
        await fetch(
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
          expires_at
        )
        VALUES (
          $1,
          $2,
          NOW() + INTERVAL '10 minutes'
        )
      `,
      [
        code,
        String(clientId)
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

    const result =
      await db.query(
        `
          SELECT
            chat_title,
            thread_id,
            created_at
          FROM telegram_connections
          WHERE client_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [clientId]
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
            client_id
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

    const clientId =
      codeResult.rows[0].client_id

    await db.query(
      `
        INSERT INTO telegram_connections (
          client_id,
          chat_id,
          chat_title,
          thread_id
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (
          client_id,
          chat_id,
          thread_id
        )
        DO UPDATE SET
          chat_title = EXCLUDED.chat_title
      `,
      [
        clientId,
        String(chatId),
        String(chatTitle),
        threadId
          ? String(threadId)
          : null
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

  async (req, res) => {
    const {
  renderId,
  title,
  description,
  audioFileName,
  clientId
} = req.body || {}
    let imagePath = null
    let audioPath = null

    try {
      if (!renderId) {
        return res.status(400).json({
          error: 'renderId não informado.'
        })
      }

      if (!clientId) {
        return res.status(400).json({
          error: 'clientId não informado.'
        })
      }

      // -------------------------------------------------------
      // Busca o Telegram conectado a este usuário
      // -------------------------------------------------------

      const connectionResult =
        await db.query(
          `
            SELECT
              chat_id,
              thread_id,
              chat_title
            FROM telegram_connections
            WHERE client_id = $1
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [String(clientId)]
        )

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
          expires_at
        )
        VALUES (
          $1,
          $2,
          NOW() + INTERVAL '10 minutes'
        )
      `,
      [
        code,
        String(clientId)
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
          WHERE client_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [clientId]
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
              client_id
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

      const clientId =
        codeResult.rows[0].client_id

      await db.query(
        `
          INSERT INTO discord_connections (
            client_id,
            guild_id,
            guild_name,
            channel_id,
            channel_name
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (
            client_id,
            guild_id,
            channel_id
          )
          DO UPDATE SET
            guild_name = EXCLUDED.guild_name,
            channel_name = EXCLUDED.channel_name
        `,
        [
          clientId,
          guildId,
          guildName,
          channelId,
          channelName
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

app.post('/publish-discord', async (req, res) => {
  const {
    renderId,
    title,
    description,
    audioFileName,
    clientId
  } = req.body || {}

  let imagePath = null
  let audioPath = null

  try {
    if (!renderId) {
      return res.status(400).json({
        error: 'renderId não informado.'
      })
    }

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
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

    const connectionResult =
      await db.query(
        `
          SELECT
            guild_id,
            channel_id,
            channel_name
          FROM discord_connections
          WHERE client_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [String(clientId)]
      )

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
  await fetch(
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


// ------------------------------------------------------------
// INICIA LOGIN GOOGLE
// ------------------------------------------------------------

app.get(
  '/account/google',
  (req, res) => {
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

    const state =
      crypto.randomBytes(24).toString('hex')

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
        !googleUser.email
      ) {
        console.error(
          'Google userinfo error:',
          googleUser
        )

        throw new Error(
          'Não foi possível obter a conta Google.'
        )
      }

      // Cria ou atualiza usuário 1CE
      const userResult =
        await db.query(
          `
            INSERT INTO account_users (
              google_id,
              email,
              name,
              picture,
              updated_at
            )
            VALUES ($1, $2, $3, $4, NOW())

            ON CONFLICT (google_id)
            DO UPDATE SET
              email = EXCLUDED.email,
              name = EXCLUDED.name,
              picture = EXCLUDED.picture,
              updated_at = NOW()

            RETURNING id
          `,
          [
            googleUser.sub,
            googleUser.email,
            googleUser.name || '',
            googleUser.picture || ''
          ]
        )

      const userId =
        userResult.rows[0].id

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

      res.json({
        authenticated: true,

        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture
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

async function setupDatabase() {
  try {
await db.query(`
  CREATE TABLE IF NOT EXISTS account_users (
    id SERIAL PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    picture TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
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
    
  console.log('Telegram + Discord database ready.')
  } catch (error) {
    console.error(
      'Error preparing Telegram database:',
      error
    )
  }
}

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
