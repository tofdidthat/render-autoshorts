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

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 }
})

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'AutoShorts Render' })
})

app.post('/render', upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const cover = req.files?.cover?.[0]
  const audio = req.files?.audio?.[0]
  let outputPath

  const cleanup = () => {
    for (const p of [outputPath, cover?.path, audio?.path]) {
      if (p) try { fs.unlinkSync(p) } catch {}
    }
  }

  try {
    if (!cover || !audio) {
      cleanup()
      return res.status(400).json({ error: 'Envie cover e audio.' })
    }

    outputPath = path.join(os.tmpdir(), `${crypto.randomUUID()}.mp4`)

    const startedAt = Date.now()
    
    await execFileAsync('ffmpeg', [
      '-y',
      '-framerate', '1',
      '-loop', '1',
      '-i', cover.path,
      '-i', audio.path,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
      '-pix_fmt', 'yuv420p',
      '-r', '1',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      outputPath
    ])

console.log(
  `FFmpeg terminou em ${((Date.now() - startedAt) / 1000).toFixed(2)}s`
)
    
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Disposition', 'attachment; filename="autoshorts.mp4"')

    const stream = fs.createReadStream(outputPath)
    res.on('finish', cleanup)
    res.on('close', cleanup)
    stream.pipe(res)
  } catch (error) {
    console.error(error)
    cleanup()
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Falha ao renderizar vídeo.',
        details: error?.message
      })
    }
  }
})

app.listen(port, '0.0.0.0', () => {
  console.log(`Render server listening on port ${port}`)
})
