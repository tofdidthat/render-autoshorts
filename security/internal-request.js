import crypto from 'crypto'

export function createInternalRequestValidator() {
  return function isValidInternalRequest(req) {
    const secret = req.headers['x-1ce-internal-secret']
    const expected = process.env.ONECE_INTERNAL_SECRET

    if (!secret || !expected) return false

    const left = Buffer.from(String(secret))
    const right = Buffer.from(String(expected))

    if (left.length !== right.length) return false

    return crypto.timingSafeEqual(left, right)
  }
}
