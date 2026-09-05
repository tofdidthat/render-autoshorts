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

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, DELETE, OPTIONS'
  )

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  )

  // Permite que o navegador leia o renderId
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

  console.log(`Render removido: ${renderId}`)

  return true
}

function scheduleRenderCleanup(renderId) {
  setTimeout(() => {
    deleteRender(renderId)
  }, RENDER_TTL_MS)
}

// Limpeza extra caso algum timer não execute
setInterval(() => {
  const now = Date.now()

  for (const [renderId, render] of renders.entries()) {
    if (now - render.createdAt >= RENDER_TTL_MS) {
      deleteRender(renderId)
    }
  }
}, 60 * 1000).unref()

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
    const cover = req.files?.cover?.[0]
    const audio = req.files?.audio?.[0]

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
          error: 'Envie cover e audio.'
        })
      }

      renderId = crypto.randomUUID()

      outputPath = path.join(
        os.tmpdir(),
        `${renderId}.mp4`
      )

      const startedAt = Date.now()

      await execFileAsync('ffmpeg', [
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
        '1',

        '-c:a',
        'aac',

        '-b:a',
        '192k',

        '-shortest',

        '-movflags',
        '+faststart',

        outputPath
      ])

      const ffmpegSeconds =
        ((Date.now() - startedAt) / 1000).toFixed(2)

      console.log(
        `FFmpeg terminou em ${ffmpegSeconds}s`
      )

      const stats = fs.statSync(outputPath)

      renders.set(renderId, {
        id: renderId,
        path: outputPath,
        size: stats.size,
        mimeType: 'video/mp4',
        createdAt: Date.now()
      })

      renderSaved = true
      scheduleRenderCleanup(renderId)

      console.log(
        `Render temporário salvo: ${renderId} - ${(stats.size / 1024 / 1024).toFixed(2)} MB`
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
        fs.createReadStream(outputPath)

      stream.on('error', error => {
        console.error(
          'Erro ao enviar MP4:',
          error
        )

        if (!res.headersSent) {
          res.status(500).json({
            error: 'Falha ao enviar o vídeo.'
          })
        } else {
          res.destroy(error)
        }
      })

      stream.pipe(res)

    } catch (error) {
      console.error(error)

      cleanupInputs()

      // Se o render não chegou a ser salvo,
      // podemos apagar imediatamente.
      if (!renderSaved) {
        deleteFile(outputPath)
      }

      if (!res.headersSent) {
        res.status(500).json({
          error: 'Falha ao renderizar vídeo.',
          details: error?.message
        })
      }
    }
  }
)

// Permite confirmar que um render temporário existe
app.get('/render/:renderId', (req, res) => {
  const render = renders.get(
    req.params.renderId
  )

  if (!render || !fs.existsSync(render.path)) {
    return res.status(404).json({
      error: 'Render não encontrado ou expirado.'
    })
  }

  const expiresInMs =
    Math.max(
      0,
      RENDER_TTL_MS -
      (Date.now() - render.createdAt)
    )

  res.json({
    ok: true,
    renderId: render.id,
    size: render.size,
    mimeType: render.mimeType,
    expiresInSeconds:
      Math.ceil(expiresInMs / 1000)
  })
})

// Permite apagar o render depois que terminarmos de usá-lo
app.delete('/render/:renderId', (req, res) => {
  const deleted =
    deleteRender(req.params.renderId)

  if (!deleted) {
    return res.status(404).json({
      error: 'Render não encontrado.'
    })
  }

  res.json({
    ok: true
  })
})

app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `Render server listening on port ${port}`
    )
  }
)
