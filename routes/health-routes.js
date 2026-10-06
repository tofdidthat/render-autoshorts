import { Router } from 'express'

export function createHealthRouter({
  ready,
  renders
}) {
  const router = Router()

  router.get('/', (req, res) => {
    const isReady =
      ready() === true

    return res
      .status(isReady ? 200 : 503)
      .json({
        ok: isReady,
        ready: isReady,
        service:
          'AutoShorts Render',
        temporaryRenders:
          renders.size
      })
  })

  router.get(
    '/health/live',
    (req, res) => {
      return res.json({
        ok: true,
        service:
          'AutoShorts Render'
      })
    }
  )

  router.get(
    '/health/ready',
    (req, res) => {
      const isReady =
        ready() === true

      return res
        .status(
          isReady ? 200 : 503
        )
        .json({
          ok: isReady,
          ready: isReady
        })
    }
  )

  return router
}
