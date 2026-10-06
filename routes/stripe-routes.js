import express from 'express'
import crypto from 'crypto'
import {
  createStripeCheckoutSession,
  createStripeBillingPortalSession,
  retrieveStripeSubscription
} from '../stripe.js'

export function stripePlanFromStatus(status) {
  return ['active', 'trialing'].includes(String(status || '').toLowerCase())
    ? 'pro'
    : 'free'
}

export function createStripeRouter({
  db,
  getAccountFromRequest
}) {
  const router = express.Router()

function verifyStripeWebhookSignature(req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const header = String(req.headers['stripe-signature'] || '')

  if (!secret || !header || !req.rawBody) return false

  const parts = header.split(',')
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2)
  const signatures = parts
    .filter(part => part.startsWith('v1='))
    .map(part => part.slice(3))

  if (!timestamp || !signatures.length) return false

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${req.rawBody.toString('utf8')}`)
    .digest('hex')

  return signatures.some(signature => {
    try {
      const a = Buffer.from(signature, 'hex')
      const b = Buffer.from(expected, 'hex')
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    } catch {
      return false
    }
  })
}


async function upsertStripeSubscription({
  userId,
  customerId,
  subscriptionId,
  status,
  priceId,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  queryClient = db
}) {
  if (!userId) return { updated: false }

  const existingResult =
    await queryClient.query(
      `
        SELECT
          stripe_customer_id,
          stripe_subscription_id,
          status,
          price_id,
          current_period_end,
          cancel_at_period_end
        FROM stripe_subscriptions
        WHERE user_id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [Number(userId)]
    )

  const existing =
    existingResult.rows[0] || null

  if (
    existing?.stripe_subscription_id &&
    subscriptionId &&
    existing.stripe_subscription_id !== String(subscriptionId)
  ) {
    const existingStatus =
      String(existing.status || '').toLowerCase()

    const terminal =
      ['canceled', 'incomplete_expired'].includes(existingStatus)

    if (!terminal) {
      console.warn(
        'Ignoring Stripe event for non-canonical subscription',
        {
          userId: Number(userId),
          currentSubscription:
            existing.stripe_subscription_id,
          incomingSubscription:
            String(subscriptionId)
        }
      )

      return {
        updated: false,
        ignoredDifferentSubscription: true
      }
    }
  }

  const nextCustomerId =
    customerId != null
      ? String(customerId)
      : existing?.stripe_customer_id || null

  const nextSubscriptionId =
    subscriptionId != null
      ? String(subscriptionId)
      : existing?.stripe_subscription_id || null

  const nextStatus =
    status != null
      ? String(status)
      : existing?.status || 'inactive'

  const nextPriceId =
    priceId !== undefined && priceId !== null
      ? String(priceId)
      : existing?.price_id || null

  const nextCurrentPeriodEnd =
    currentPeriodEnd !== undefined
      ? (
          currentPeriodEnd
            ? new Date(Number(currentPeriodEnd) * 1000)
            : null
        )
      : existing?.current_period_end || null

  const nextCancelAtPeriodEnd =
    typeof cancelAtPeriodEnd === 'boolean'
      ? cancelAtPeriodEnd
      : Boolean(existing?.cancel_at_period_end)

  await queryClient.query(
    `
      INSERT INTO stripe_subscriptions (
        user_id,
        stripe_customer_id,
        stripe_subscription_id,
        status,
        price_id,
        current_period_end,
        cancel_at_period_end,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        status = EXCLUDED.status,
        price_id = EXCLUDED.price_id,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = NOW()
    `,
    [
      Number(userId),
      nextCustomerId,
      nextSubscriptionId,
      nextStatus,
      nextPriceId,
      nextCurrentPeriodEnd,
      nextCancelAtPeriodEnd
    ]
  )

  return { updated: true }
}

async function syncStripeSubscription({
  userId,
  subscriptionId,
  queryClient = db
}) {
  if (!userId || !subscriptionId) {
    return { updated: false }
  }

  const subscription =
    await retrieveStripeSubscription(
      subscriptionId
    )

  return upsertStripeSubscription({
    userId,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status: subscription.status,
    priceId:
      subscription.items?.data?.[0]?.price?.id,
    currentPeriodEnd:
      subscription.current_period_end,
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end,
    queryClient
  })
}

async function findStripeUserIdBySubscription(subscriptionId, queryClient = db) {
  if (!subscriptionId) return null

  const result = await queryClient.query(
    `SELECT user_id FROM stripe_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
    [String(subscriptionId)]
  )

  return result.rows[0]?.user_id || null
}

router.post('/stripe/webhook', async (req, res) => {
  if (!verifyStripeWebhookSignature(req)) {
    return res.status(400).send('Invalid Stripe signature')
  }

  const event = req.body || {}
  const eventId = String(event.id || '')

  if (!eventId) {
    return res.status(400).send('Invalid Stripe event')
  }

  const client = await db.connect()

  try {
    await client.query('BEGIN')

    const inserted = await client.query(
      `
        INSERT INTO stripe_webhook_events (event_id, event_type)
        VALUES ($1, $2)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `,
      [eventId, String(event.type || '')]
    )

    if (!inserted.rows.length) {
      await client.query('COMMIT')
      return res.json({ received: true, duplicate: true })
    }

    const object = event.data?.object || {}

    if (event.type === 'checkout.session.completed') {
      const userId =
        object.client_reference_id ||
        object.metadata?.onece_user_id

      if (userId && object.subscription) {
        await syncStripeSubscription({
          userId,
          subscriptionId: object.subscription,
          queryClient: client
        })
      }
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const userId =
        object.metadata?.onece_user_id ||
        await findStripeUserIdBySubscription(
          object.id,
          client
        )

      if (userId) {
        await syncStripeSubscription({
          userId,
          subscriptionId: object.id,
          queryClient: client
        })
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const subscriptionId =
        typeof object.subscription === 'string'
          ? object.subscription
          : object.subscription?.id

      const userId =
        await findStripeUserIdBySubscription(
          subscriptionId,
          client
        )

      if (userId) {
        await syncStripeSubscription({
          userId,
          subscriptionId,
          queryClient: client
        })
      }
    }

    await client.query('COMMIT')
    return res.json({ received: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Stripe webhook error:', error)
    return res.status(500).json({ error: 'Stripe webhook failed.' })
  } finally {
    client.release()
  }
})

// ------------------------------------------------------------
// USUÁRIO LOGADO
// ------------------------------------------------------------

// ------------------------------------------------------------
// LOGOUT
// ------------------------------------------------------------

// ============================================================
// 1CE - STRIPE CUSTOMER PORTAL
// ============================================================

router.post(
  '/stripe/create-portal-session',

  async (req, res) => {
    try {
      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const subscriptionResult =
        await db.query(
          `
            SELECT stripe_customer_id
            FROM stripe_subscriptions
            WHERE user_id = $1
            LIMIT 1
          `,
          [user.id]
        )

      const customerId =
        subscriptionResult.rows[0]?.stripe_customer_id

      if (!customerId) {
        return res.status(404).json({
          error: 'Stripe customer not found for this account.'
        })
      }

      const session =
        await createStripeBillingPortalSession({
          customerId
        })

      if (!session?.url) {
        throw new Error(
          'Stripe Billing Portal session returned without URL.'
        )
      }

      return res.json({
        url: session.url
      })

    } catch (error) {
      console.error(
        'Stripe billing portal session error:',
        error
      )

      return res.status(500).json({
        error:
          error?.message ||
          'Failed to create Stripe Billing Portal session.'
      })
    }
  }
)

// ============================================================
// 1CE - STRIPE CHECKOUT
// ============================================================

router.post(
  '/stripe/create-checkout-session',

  async (req, res) => {
    try {
      const user =
        await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      const market =
        String(req.body?.market || '')
          .trim()
          .toLowerCase()

      if (
        market !== 'br' &&
        market !== 'global'
      ) {
        return res.status(400).json({
          error: 'Invalid market. Use br or global.'
        })
      }

      const subscriptionResult =
        await db.query(
          `
            SELECT
              stripe_customer_id,
              stripe_subscription_id,
              status
            FROM stripe_subscriptions
            WHERE user_id = $1
            LIMIT 1
          `,
          [user.id]
        )

      const existingSubscription =
        subscriptionResult.rows[0] || null

      const existingStatus =
        String(existingSubscription?.status || '')
          .toLowerCase()

      const hasExistingSubscription =
        Boolean(
          existingSubscription?.stripe_subscription_id &&
          ![
            'canceled',
            'incomplete_expired'
          ].includes(existingStatus)
        )

      if (hasExistingSubscription) {
        const customerId =
          existingSubscription?.stripe_customer_id

        if (!customerId) {
          return res.status(409).json({
            error:
              'An existing subscription was found, but its Stripe customer is unavailable.'
          })
        }

        const portalSession =
          await createStripeBillingPortalSession({
            customerId
          })

        if (!portalSession?.url) {
          throw new Error(
            'Stripe Billing Portal session returned without URL.'
          )
        }

        return res.json({
          url: portalSession.url,
          portal: true
        })
      }

      const customerId =
        existingSubscription?.stripe_customer_id || null

      const idempotencyKey =
        crypto
          .createHash('sha256')
          .update(
            [
              'onece-checkout',
              user.id,
              market,
              customerId || user.email || '',
              existingSubscription?.stripe_subscription_id || 'none',
              existingStatus || 'none'
            ].join(':')
          )
          .digest('hex')

      const session =
        await createStripeCheckoutSession({
          market,
          customerEmail: user.email,
          customerId,
          userId: user.id,
          idempotencyKey
        })

      if (!session?.url) {
        throw new Error(
          'Stripe Checkout session returned without URL.'
        )
      }

      return res.json({
        url: session.url,
        sessionId: session.id
      })

    } catch (error) {
      console.error(
        'Stripe checkout session error:',
        error
      )

      return res.status(500).json({
        error:
          error?.message ||
          'Failed to create Stripe Checkout session.'
      })
    }
  }
)



  return router
}
