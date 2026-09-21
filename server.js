import express from 'express'
import multer from 'multer'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const app = express()
const port = process.env.PORT || 8080

const RENDER_TTL_MS = 10 * 60 * 1000

const renders = new Map()

app.use(express.json({
  limit: '1mb'
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
    'Content-Type'
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
  caption = ''
}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  const threadId = process.env.TELEGRAM_NEW_BEATS_THREAD_ID

  if (!botToken || !chatId || !threadId) {
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

  formData.append(
    'message_thread_id',
    String(threadId)
  )

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
// TELEGRAM
// Envia imagem + áudio para o tópico NEW BEATS
// ============================================================

app.post(
  '/publish-telegram',

  async (req, res) => {
    const {
      renderId,
      title
    } = req.body || {}

    let imagePath = null
    let audioPath = null

    try {
      if (!renderId) {
        return res.status(400).json({
          error: 'renderId não informado.'
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
        // Alguns vídeos podem ter menos de 1 segundo.
        // Nesse caso tenta o primeiro frame.
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

      // -------------------------------------------------------
      // 1. Envia a imagem
      // -------------------------------------------------------

      await sendTelegramFile({
        method: 'sendPhoto',
        filePath: imagePath,
        fieldName: 'photo',
        fileName: 'cover.jpg',
        mimeType: 'image/jpeg',
        caption: `🔥 ${safeTitle}`
      })

      // -------------------------------------------------------
      // 2. Envia o áudio separadamente
      // -------------------------------------------------------

      await sendTelegramFile({
        method: 'sendAudio',
        filePath: audioPath,
        fieldName: 'audio',
        fileName: `${safeTitle}.mp3`,
        mimeType: 'audio/mpeg',
        caption: ''
      })

      console.log(
        `Telegram publicado: ${renderId}`
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

app.listen(
  port,
  '0.0.0.0',

  () => {
    console.log(
      `Render server listening on port ${port}`
    )
  }
)
