import fs from 'fs'
import multer from 'multer'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createRenderService } from './render-service.js'

export function createRenderRuntime({ renders }) {
  const execFileAsync = promisify(execFile)
  const renderTtlMs = 10 * 60 * 1000

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

    if (!render) return false
    if (render.publicationBusyUntil > Date.now()) return false

    deleteFile(render.path)
    renders.delete(renderId)

    console.log(`Render removido: ${renderId}`)
    return true
  }

  function scheduleRenderCleanup(renderId) {
    setTimeout(() => {
      if (!deleteRender(renderId) && renders.has(renderId)) {
        scheduleRenderCleanup(renderId)
      }
    }, renderTtlMs).unref()
  }

  setInterval(() => {
    const now = Date.now()

    for (const [renderId, render] of renders.entries()) {
      if (now - render.createdAt >= renderTtlMs) {
        deleteRender(renderId)
      }
    }
  }, 60 * 1000).unref()

  const renderAudio = createRenderService({
    execFileAsync,
    renders,
    scheduleRenderCleanup,
    deleteFile
  })

  const maxGlobalRenderJobs = Math.max(
    1,
    Number(process.env.MAX_GLOBAL_RENDER_JOBS || 2)
  )

  const maxUserRenderJobs = Math.max(
    1,
    Number(process.env.MAX_USER_RENDER_JOBS || 1)
  )

  let activeRenderJobs = 0
  const activeRenderJobsByUser = new Map()

  async function withRenderCapacity(userId, task) {
    if (activeRenderJobs >= maxGlobalRenderJobs) {
      const error = new Error('Render capacity is currently full.')
      error.code = 'RENDER_CAPACITY_FULL'
      throw error
    }

    const currentUserJobs =
      activeRenderJobsByUser.get(userId) || 0

    if (currentUserJobs >= maxUserRenderJobs) {
      const error = new Error('You already have a render in progress.')
      error.code = 'USER_RENDER_LIMIT'
      throw error
    }

    activeRenderJobs += 1
    activeRenderJobsByUser.set(userId, currentUserJobs + 1)

    try {
      return await task()
    } finally {
      activeRenderJobs = Math.max(0, activeRenderJobs - 1)

      const remaining =
        (activeRenderJobsByUser.get(userId) || 1) - 1

      if (remaining <= 0) {
        activeRenderJobsByUser.delete(userId)
      } else {
        activeRenderJobsByUser.set(userId, remaining)
      }
    }
  }

  return {
    execFileAsync,
    upload,
    renderTtlMs,
    deleteFile,
    deleteRender,
    scheduleRenderCleanup,
    renderAudio,
    withRenderCapacity
  }
}
