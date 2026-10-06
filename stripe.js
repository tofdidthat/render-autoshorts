const STRIPE_API_URL = 'https://api.stripe.com/v1'

export const STRIPE_PRICES = {
  br: 'price_1UM9h8RrR7Cqov4w3k2sykzF',
  global: 'price_1UM9h0RrR7Cqov4w77haiPgI'
}

function getStripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY

  if (!key) {
    throw new Error('STRIPE_SECRET_KEY não configurada no Railway.')
  }

  return key
}

async function stripePost(path, params, { idempotencyKey = null } = {}) {
  const response = await fetch(
    `${STRIPE_API_URL}${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getStripeSecretKey()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey
          ? { 'Idempotency-Key': idempotencyKey }
          : {})
      },
      body: params.toString()
    }
  )

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Stripe respondeu HTTP ${response.status}`
    )
  }

  return data
}

export async function createStripeCheckoutSession({
  market,
  customerEmail,
  customerId,
  userId,
  idempotencyKey
}) {
  const priceId = STRIPE_PRICES[market]

  if (!priceId) {
    throw new Error('Mercado inválido. Use br ou global.')
  }

  const frontendUrl = (
    process.env.ONECE_FRONTEND_URL ||
    'https://1ce.lol'
  ).replace(/\/$/, '')

  const params = new URLSearchParams()

  params.set('mode', 'subscription')
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('success_url', `${frontendUrl}/app?checkout=success&session_id={CHECKOUT_SESSION_ID}`)
  params.set('cancel_url', market === 'br' ? `${frontendUrl}/pt/pricing` : `${frontendUrl}/pricing`)
  params.set('allow_promotion_codes', 'true')

  if (customerId) {
    params.set('customer', String(customerId))
  } else if (customerEmail) {
    params.set('customer_email', customerEmail)
  }

  if (userId) {
    params.set('client_reference_id', String(userId))
    params.set('metadata[onece_user_id]', String(userId))
    params.set('subscription_data[metadata][onece_user_id]', String(userId))
  }

  params.set('metadata[onece_market]', market)
  params.set('subscription_data[metadata][onece_market]', market)

  return stripePost(
    '/checkout/sessions',
    params,
    { idempotencyKey }
  )
}

export async function createStripeBillingPortalSession({
  customerId
}) {
  if (!customerId) {
    throw new Error('Stripe customer não encontrado para esta conta.')
  }

  const frontendUrl = (
    process.env.ONECE_FRONTEND_URL ||
    'https://1ce.lol'
  ).replace(/\/$/, '')

  const params = new URLSearchParams()
  params.set('customer', String(customerId))
  params.set('return_url', `${frontendUrl}/account`)

  return stripePost('/billing_portal/sessions', params)
}
