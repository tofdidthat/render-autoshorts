import { Router } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

export function createRenderRouter({
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
}) {
  const router = Router()

  router.post(
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
      const account =
        await getAccountFromRequest(req)

      if (!account) {
        deleteFile(
          req.files?.cover?.[0]?.path
        )
        deleteFile(
          req.files?.audio?.[0]?.path
        )

        return res
          .status(401)
          .json({
            error:
              'Invalid 1CE session.'
          })
      }

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

          return res
            .status(400)
            .json({
              error:
                'Envie cover e audio.'
            })
        }

        const render =
          await withRenderCapacity(
            account.id,
            () =>
              renderAudio({
                cover,
                audio,
                ownerUserId:
                  account.id
              })
          )

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
              res
                .status(500)
                .json({
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
          if (
            error?.code ===
              'RENDER_CAPACITY_FULL' ||
            error?.code ===
              'USER_RENDER_LIMIT'
          ) {
            return res
              .status(429)
              .json({
                error:
                  error.message
              })
          }

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

  router.post(
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
      const account =
        await getAccountFromRequest(req)

      if (!account) {
        deleteFile(
          req.files?.video?.[0]?.path
        )
        deleteFile(
          req.files?.audio?.[0]?.path
        )

        return res
          .status(401)
          .json({
            error:
              'Invalid 1CE session.'
          })
      }

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

          return res
            .status(400)
            .json({
              error:
                'Envie um vídeo.'
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

        if (audio) {
          await withRenderCapacity(
            account.id,
            () =>
              execFileAsync(
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
                ],
                {
                  timeout:
                    10 * 60 * 1000,
                  maxBuffer:
                    4 * 1024 * 1024
                }
              )
          )
        } else {
          await withRenderCapacity(
            account.id,
            () =>
              execFileAsync(
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
                ],
                {
                  timeout:
                    10 * 60 * 1000,
                  maxBuffer:
                    4 * 1024 * 1024
                }
              )
          )
        }

        const ffmpegSeconds =
          (
            (
              Date.now() -
              startedAt
            ) /
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
            mimeType:
              'video/mp4',
            createdAt: Date.now()
          }
        )

        renderSaved = true

        scheduleRenderCleanup(
          renderId
        )

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
          fs.createReadStream(
            outputPath
          )

        stream.on(
          'error',
          error => {
            console.error(
              'Erro ao enviar vídeo:',
              error
            )

            if (!res.headersSent) {
              res
                .status(500)
                .json({
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
          if (
            error?.code ===
              'RENDER_CAPACITY_FULL' ||
            error?.code ===
              'USER_RENDER_LIMIT'
          ) {
            return res
              .status(429)
              .json({
                error:
                  error.message
              })
          }

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

  router.get(
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
          renderTtlMs -
            (
              Date.now() -
              render.createdAt
            )
        )

      return res.json({
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

  router.get(
    '/public-render/:renderId.mp4',
    (req, res) => {
      const { renderId } =
        req.params

      const render =
        renders.get(renderId)

      if (
        !render ||
        !fs.existsSync(
          render.path
        )
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

  router.delete(
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

      return res.json({
        ok: true
      })
    }
  )

  return router
}
