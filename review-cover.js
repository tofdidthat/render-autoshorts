import multer from 'multer'
import fs from 'node:fs'

// Only the account that owns a pending desktop review can change its video.
export function registerReviewCover(router, { account, limited, publicationService, renders, renderAudio, execFileAsync, deleteFile }) {
  const multipart = multer({ storage: multer.diskStorage({}),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1, fieldSize: 100, parts: 2 }
  }).single('cover')
  router.post('/publish-cover', limited, account, (req, res, next) => {
    multipart(req, res, async error => {
      let render, replacement, editing = false
      try {
        if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Choose a JPG, PNG or WEBP image up to 10 MB.' })
        const row = await publicationService.lookup(req.body?.ticket, req.account.id)
        render = row && renders.get(row.render_id)
        if (!row || !render || render.ownerUserId !== req.account.id || !fs.existsSync(render.path)) return res.sendStatus(404)
        if (row.status !== 'pending' || !render.coverEditable || render.reviewEditing || render.reviewConfirming || render.publicationBusyUntil > Date.now()) return res.sendStatus(409)
        if (!req.file) return res.status(400).json({ error: 'Choose a cover image.' })
        render.reviewEditing = true
        editing = true
        render.publicationBusyUntil = Date.now() + 11 * 60000
        const probe = JSON.parse((await execFileAsync('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-show_streams', '-show_format', '-of', 'json', req.file.path], { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout)
        if (!['image2', 'jpeg_pipe', 'png_pipe', 'webp_pipe'].includes(probe.format?.format_name) ||
            !probe.streams?.some(s => ['mjpeg', 'png', 'webp'].includes(s.codec_name))) {
          return res.status(400).json({ error: 'Choose a JPG, PNG or WEBP image.' })
        }
        replacement = await renderAudio({ cover: req.file, audio: { path: render.path }, ownerUserId: req.account.id, register: false, copyAudio: true })
        const current = await publicationService.lookup(req.body.ticket, req.account.id)
        if (current?.status !== 'pending' || Date.now() - render.createdAt >= 600000) return res.sendStatus(409)
        const oldPath = render.path
        render.path = replacement.path
        render.size = replacement.size
        render.hasCover = true
        replacement = null
        deleteFile(oldPath)
        res.json({ ok: true, hasCover: true })
      } catch (error) {
        if (error instanceof SyntaxError || error.cmd?.includes('ffprobe')) res.status(400).json({ error: 'Invalid cover image.' })
        else next(error)
      } finally {
        deleteFile(req.file?.path)
        deleteFile(replacement?.path)
        if (editing) { delete render.reviewEditing; delete render.publicationBusyUntil }
      }
    })
  })
}
