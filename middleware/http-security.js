const OFFICIAL_ORIGIN = 'https://1ce.lol'

function normalizeOrigin(value) {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function allowedOrigins() {
  const origins = new Set([OFFICIAL_ORIGIN])

  const configured =
    normalizeOrigin(process.env.ONECE_FRONTEND_URL)

  if (configured) {
    origins.add(configured)
  }

  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000')
    origins.add('http://localhost:5173')
    origins.add('http://127.0.0.1:3000')
    origins.add('http://127.0.0.1:5173')
  }

  return origins
}

const RATE_LIMIT_RULES = [
  {
    name: 'account-register',
    method: 'POST',
    path: '/account/email/register',
    max: 10,
    windowMs: 15 * 60 * 1000
  },
  {
    name: 'account-login',
    method: 'POST',
    path: '/account/email/login',
    max: 40,
    windowMs: 15 * 60 * 1000
  },
  {
    name: 'account-email-code',
    method: 'POST',
    paths: [
      '/account/email/verify',
      '/account/email/resend',
      '/account/password/forgot',
      '/account/password/verify',
      '/account/password/reset'
    ],
    max: 30,
    windowMs: 15 * 60 * 1000
  },
  {
    name: 'connection-code',
    method: 'POST',
    paths: [
      '/telegram/connect-code',
      '/discord/connect-code'
    ],
    max: 30,
    windowMs: 15 * 60 * 1000
  },
  {
    name: 'render-create',
    method: 'POST',
    paths: [
      '/render',
      '/prepare-video'
    ],
    max: 60,
    windowMs: 60 * 60 * 1000
  },
  {
    name: 'platform-upload',
    method: 'POST',
    paths: [
      '/upload-tiktok',
      '/upload-youtube',
      '/publish-telegram',
      '/publish-discord'
    ],
    max: 120,
    windowMs: 60 * 60 * 1000
  }
]

function matchesRule(rule, req) {
  if (req.method !== rule.method) return false

  if (rule.path) {
    return req.path === rule.path
  }

  return rule.paths?.includes(req.path) || false
}

export function createHttpSecurityMiddleware() {
  const buckets = new Map()

  const cleanup = setInterval(() => {
    const now = Date.now()

    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key)
      }
    }
  }, 5 * 60 * 1000)

  cleanup.unref?.()

  return function httpSecurity(req, res, next) {
    res.setHeader(
      'X-Content-Type-Options',
      'nosniff'
    )
    res.setHeader(
      'X-Frame-Options',
      'DENY'
    )
    res.setHeader(
      'Referrer-Policy',
      'no-referrer'
    )
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()'
    )

    if (req.secure) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      )
    }

    const origin = req.headers.origin
    const origins = allowedOrigins()

    if (origin) {
      const normalized =
        normalizeOrigin(origin)

      if (!normalized || !origins.has(normalized)) {
        return res.status(403).json({
          error: 'Origin not allowed.'
        })
      }

      res.setHeader(
        'Access-Control-Allow-Origin',
        normalized
      )
      res.setHeader('Vary', 'Origin')
    }

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, DELETE, OPTIONS'
    )
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-1CE-Internal-Secret'
    )
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-Render-Id, Retry-After'
    )

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204)
    }

    const rule =
      RATE_LIMIT_RULES.find(candidate =>
        matchesRule(candidate, req)
      )

    if (!rule) {
      return next()
    }

    const now = Date.now()
    const clientKey =
      String(
        req.ip ||
        req.socket?.remoteAddress ||
        'unknown'
      )

    const key =
      `${rule.name}:${clientKey}`

    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + rule.windowMs
      }
      buckets.set(key, bucket)
    }

    bucket.count += 1

    if (bucket.count > rule.max) {
      const retryAfter =
        Math.max(
          1,
          Math.ceil(
            (bucket.resetAt - now) / 1000
          )
        )

      res.setHeader(
        'Retry-After',
        String(retryAfter)
      )

      return res.status(429).json({
        error: 'Too many requests. Please try again later.'
      })
    }

    next()
  }
}
