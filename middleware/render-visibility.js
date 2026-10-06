export function createLegacyRenderVisibilityMiddleware({ renders }) {
  return function legacyRenderVisibility(req, res, next) {
    if (req.path.toLowerCase().startsWith('/api/desktop/')) return next()

    let decodedPath

    try {
      decodedPath = decodeURIComponent(req.path)
    } catch {
      return res.sendStatus(400)
    }

    const pathId =
      decodedPath
        .match(/^\/(?:render|public-render)\/([^/]+?)\/?$/i)?.[1]
        ?.replace(/\.mp4$/i, '')

    const id = req.body?.renderId || pathId

    if (
      typeof id === 'string' &&
      renders.get(id)?.ownerUserId != null
    ) {
      return res.status(404).json({
        error: 'Render não encontrado.'
      })
    }

    next()
  }
}
