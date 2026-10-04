import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// Shared by /render and desktop. The caller owns multipart input cleanup.
export function createRenderService({ execFileAsync, renders, scheduleRenderCleanup, deleteFile }) {
  return async function renderAudio({ cover, audio, ownerUserId = null }) {
    const renderId = crypto.randomUUID()
    const outputPath = path.join(os.tmpdir(), `${renderId}.mp4`)
    const imageInput = cover
      ? ['-framerate', '1', '-loop', '1', '-i', cover.path]
      : ['-f', 'lavfi', '-i', 'color=c=black:s=720x1280:r=30']
    try {
      await execFileAsync('ffmpeg', [
        '-y', ...imageInput, '-i', audio.path,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
        '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
        '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart', outputPath
      ], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
      const stats = fs.statSync(outputPath)
      if (!stats.size) throw new Error('Empty render')
      const render = {
        id: renderId, path: outputPath, size: stats.size,
        mimeType: 'video/mp4', createdAt: Date.now(),
        ...(ownerUserId === null ? {} : { ownerUserId })
      }
      renders.set(renderId, render)
      scheduleRenderCleanup(renderId)
      return render
    } catch (error) {
      deleteFile(outputPath)
      throw error
    }
  }
}
