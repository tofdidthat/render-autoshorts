import { Router } from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function createTelegramRouter({
  db,
  getAccountFromRequest,
  renders,
  execFileAsync,
  deleteFile,
  desktopHandlers,
  fetcher = (...args) =>
    globalThis.fetch(...args)
}) {
  const router = Router()
  const fetch = (...args) =>
    fetcher(...args)

async function sendTelegramFile({
  method,
  filePath,
  fieldName,
  fileName,
  mimeType,
  chatId,
  threadId = null,
  caption = ''
}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN

  if (!botToken || !chatId) {
    throw new Error(
      'Variáveis do Telegram não configuradas no Railway.'
    )
  }

  const fileBuffer =
    await fs.promises.readFile(filePath)

  const formData = new FormData()

  formData.append(
    'chat_id',
    String(chatId)
  )

 if (threadId) {
  formData.append(
    'message_thread_id',
    String(threadId)
  )
}

  if (caption) {
    formData.append(
      'caption',
      caption
    )
  }

  formData.append(
    fieldName,
    new Blob(
      [fileBuffer],
      { type: mimeType }
    ),
    fileName
  )

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: 'POST',
      body: formData, signal: AbortSignal.timeout(120000)
    }
  )

  const data =
    await response
      .json()
      .catch(() => ({}))

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.description ||
      `Telegram respondeu HTTP ${response.status}`
    )
  }

  return data
}

router.post('/telegram/connect-code', async (req, res) => {
  try {
    const {
      clientId
    } = req.body || {}

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
      })
    }

    const account = await getAccountFromRequest(req)

    if (!account) {
      return res.status(401).json({
        error: 'Invalid 1CE session.'
      })
    }

    if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(503).json({
        error:
          'Telegram account linking requires TELEGRAM_WEBHOOK_SECRET in Railway and secret_token in setWebhook.'
      })
    }
    const code =
      crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase()

    await db.query(
      `
        INSERT INTO telegram_connect_codes (
          code,
          client_id,
          user_id,
          expires_at
        )
        VALUES (
          $1,
          $2,
          $3,
          NOW() + INTERVAL '10 minutes'
        )
      `,
      [
        code,
        String(clientId),
        account.id
      ]
    )

    return res.json({
      ok: true,
      code,
      botUsername: 'oncetelegrambot'
    })

  } catch (error) {
    console.error(
      'Telegram connect code error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to create Telegram connection code.'
    })
  }
})

async function sendTelegramMessage(
  chatId,
  threadId,
  text
) {
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN

  if (!botToken || !chatId) {
    return
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          chat_id: chatId,

          ...(threadId
            ? {
                message_thread_id:
                  threadId
              }
            : {}),

          text
        })
      }
    )

  const data =
    await response
      .json()
      .catch(() => ({}))

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.description ||
      'Telegram message failed.'
    )
  }
}


async function telegramUserCanConnect(message) {
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN

  const chatId =
    message?.chat?.id

  const userId =
    message?.from?.id

  if (!botToken || !chatId || !userId) {
    return false
  }

  // Private chats are controlled by the account owner directly.
  if (message?.chat?.type === 'private') {
    return String(chatId) === String(userId)
  }

  const response =
    await fetch(
      `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(
        String(chatId)
      )}&user_id=${encodeURIComponent(
        String(userId)
      )}`
    )

  const data =
    await response
      .json()
      .catch(() => ({}))

  if (!response.ok || !data?.ok) {
    console.warn(
      'Telegram admin verification failed',
      {
        chatId,
        userId,
        description: data?.description
      }
    )

    return false
  }

  return [
    'creator',
    'administrator'
  ].includes(
    String(data?.result?.status || '')
  )
}

// ============================================================
// TELEGRAM CONNECTION STATUS
// Verifica se este navegador já conectou um Telegram
// ============================================================

router.get('/telegram/connect-status', async (req, res) => {
  try {
    const clientId =
      String(req.query.clientId || '').trim()

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
      })
    }

    const account = req.headers.authorization ? await getAccountFromRequest(req) : null
    if (req.headers.authorization && !account) return res.status(401).json({ error: 'Invalid 1CE session.' })
    const result =
      await db.query(
        `
          SELECT
            chat_title,
            thread_id,
            created_at
          FROM telegram_connections
          WHERE ${account ? 'user_id' : 'client_id'} = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [account ? account.id : clientId]
      )

    if (!result.rows.length) {
      return res.json({
        ok: true,
        connected: false
      })
    }

    const connection =
      result.rows[0]

    return res.json({
      ok: true,
      connected: true,

      connection: {
        chatTitle:
          connection.chat_title,

        threadId:
          connection.thread_id,

        connectedAt:
          connection.created_at
      }
    })

  } catch (error) {
    console.error(
      'Telegram connection status error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to check Telegram connection.'
    })
  }
})

// ============================================================
// TELEGRAM WEBHOOK
// Conecta grupo/tópico ao usuário da 1CE
// ============================================================

router.post('/telegram/webhook', async (req, res) => {
  try {
    const received =
      req.headers['x-telegram-bot-api-secret-token']

    const expected =
      process.env.TELEGRAM_WEBHOOK_SECRET

    if (
      !received ||
      !expected ||
      typeof received !== 'string' ||
      Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(
        Buffer.from(received),
        Buffer.from(expected)
      )
    ) {
      return res.sendStatus(401)
    }

    const update = req.body || {}

    const message =
      update.message ||
      update.channel_post

    if (!message) {
      return res.json({ ok: true })
    }

    const text =
      String(message.text || '').trim()

    if (!text.startsWith('/connect')) {
      return res.json({ ok: true })
    }

    const parts =
      text.split(/\s+/)

    const code =
      String(parts[1] || '')
        .trim()
        .toUpperCase()

    const chatId =
      message.chat?.id

    const chatTitle =
      message.chat?.title ||
      message.chat?.username ||
      'Telegram'

    const threadId =
      message.message_thread_id || null

    if (!code) {
      await sendTelegramMessage(
        chatId,
        threadId,
        '❌ Connection code missing. Use /connect CODE'
      )

      return res.json({ ok: true })
    }

    if (!chatId) {
      return res.json({ ok: true })
    }

    const authorized =
      await telegramUserCanConnect(message)

    if (!authorized) {
      await sendTelegramMessage(
        chatId,
        threadId,
        '❌ Only a chat administrator can connect this destination to 1CE.'
      ).catch(() => {})

      return res.json({ ok: true })
    }

    const codeResult =
      await db.query(
        `
          SELECT
            code,
            client_id, user_id
          FROM telegram_connect_codes
          WHERE code = $1
            AND used_at IS NULL
            AND expires_at > NOW()
          LIMIT 1
        `,
        [code]
      )

    if (!codeResult.rows.length) {
      await sendTelegramMessage(
        chatId,
        threadId,
        '❌ Invalid or expired connection code.'
      )

      return res.json({ ok: true })
    }

    const claimed=await db.query(`UPDATE telegram_connect_codes SET used_at=NOW()
      WHERE code=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING code`,[code])
    if (!claimed.rowCount) return res.json({ok:true})

    const clientId =
      codeResult.rows[0].client_id

    await db.query(
      `
        INSERT INTO telegram_connections (
          client_id,
          chat_id,
          chat_title,
          thread_id, user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (
          client_id,
          chat_id,
          thread_id
        )
        DO UPDATE SET
          chat_title = EXCLUDED.chat_title,
          user_id = EXCLUDED.user_id
      `,
      [
        clientId,
        String(chatId),
        String(chatTitle),
        threadId
          ? String(threadId)
          : null,
        codeResult.rows[0].user_id
      ]
    )

    await db.query(
      `
        UPDATE telegram_connect_codes
        SET used_at = NOW()
        WHERE code = $1
      `,
      [code]
    )

    console.log(
      'Telegram conectado:',
      {
        clientId,
        chatId,
        chatTitle,
        threadId
      }
    )

    await sendTelegramMessage(
      chatId,
      threadId,
      '✅ Connected to 1CE!'
    )

    return res.json({
      ok: true
    })

  } catch (error) {
    console.error(
      'Telegram webhook error:',
      error
    )

    return res
      .status(500)
      .json({
        error:
          'Telegram webhook error.'
      })
  }
})
// ============================================================
// TELEGRAM
// Envia imagem + áudio para o tópico NEW BEATS
// ============================================================

const publishTelegram = async (req, res) => {
    const {
  renderId,
  title,
  description,
  audioFileName
} = req.body || {}
    let imagePath = null
    let audioPath = null

    try {
      if (!renderId) {
        return res.status(400).json({
          error: 'renderId não informado.'
        })
      }

      let connectionResult

      if (req.publicationConnection) {
        connectionResult = {
          rows: [req.publicationConnection]
        }
      } else {
        const account = await getAccountFromRequest(req)

        if (!account) {
          return res.status(401).json({
            error: 'Invalid 1CE session.'
          })
        }

        connectionResult = await db.query(
          `
            SELECT
              chat_id,
              thread_id,
              chat_title
            FROM telegram_connections
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [account.id]
        )
      }

      if (!connectionResult.rows.length) {
        return res.status(404).json({
          error:
            'Telegram não conectado.'
        })
      }

      const connection =
        connectionResult.rows[0]

      const chatId =
        connection.chat_id

      const threadId =
        connection.thread_id || null

      const render =
        renders.get(renderId)

      if (
        !render ||
        !fs.existsSync(render.path)
      ) {
        return res.status(404).json({
          error:
            'Render não encontrado ou expirado.'
        })
      }

      imagePath = path.join(
        os.tmpdir(),
        `${renderId}-telegram.jpg`
      )

      audioPath = path.join(
        os.tmpdir(),
        `${renderId}-telegram.mp3`
      )

      // -------------------------------------------------------
      // Extrai um frame do vídeo
      // -------------------------------------------------------

      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-ss', '1',
            '-i', render.path,
            '-frames:v', '1',
            '-q:v', '2',
            imagePath
          ]
        )
      } catch {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i', render.path,
            '-frames:v', '1',
            '-q:v', '2',
            imagePath
          ]
        )
      }

      // -------------------------------------------------------
      // Extrai o áudio do vídeo
      // -------------------------------------------------------

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i', render.path,
          '-vn',
          '-c:a', 'libmp3lame',
          '-b:a', '192k',
          audioPath
        ]
      )

      const safeTitle =
        String(title || 'New Beat')
          .trim()
          .slice(0, 100)

      const safeDescription =
  String(description || '')
    .trim()
    .slice(0, 900)

const originalAudioName =
  String(
    audioFileName ||
    `${safeTitle}.mp3`
  )
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.[^.]+$/, '') + '.mp3'

const telegramCaption =
  safeDescription
    ? `🔥 ${safeTitle}\n\n${safeDescription}`
    : `🔥 ${safeTitle}`

      // -------------------------------------------------------
      // 1. Envia a imagem
      // -------------------------------------------------------

      await sendTelegramFile({
        method: 'sendPhoto',
        filePath: imagePath,
        fieldName: 'photo',
        fileName: 'cover.jpg',
        mimeType: 'image/jpeg',
        chatId,
        threadId,
        caption: telegramCaption
      })

      // -------------------------------------------------------
      // 2. Envia o áudio
      // -------------------------------------------------------

      await sendTelegramFile({
        method: 'sendAudio',
        filePath: audioPath,
        fieldName: 'audio',
       fileName: originalAudioName,
        mimeType: 'audio/mpeg',
        chatId,
        threadId,
        caption: ''
      })

      console.log(
        `Telegram publicado: ${renderId} -> ${connection.chat_title}`
      )

      return res.json({
        ok: true,
        renderId
      })

    } catch (error) {
      console.error(
        'Erro Telegram:',
        error
      )

      return res.status(500).json({
        error:
          'Falha ao publicar no Telegram.',

        details:
          error?.message
      })

    } finally {
      deleteFile(imagePath)
      deleteFile(audioPath)
    }
  }

desktopHandlers.telegram = publishTelegram
router.post('/publish-telegram', publishTelegram)


router.delete(
  '/account/telegram/connection',
  async (req, res) => {
    try {
      const account =
        await getAccountFromRequest(req)

      if (!account) {
        return res.status(401).json({
          error: 'Invalid 1CE session.'
        })
      }

      await db.query(
        'DELETE FROM telegram_connections WHERE user_id=$1',
        [account.id]
      )

      await db.query(
        'DELETE FROM telegram_connect_codes WHERE user_id=$1',
        [account.id]
      )

      return res.json({
        disconnected: true
      })
    } catch {
      return res.status(500).json({
        error: 'Could not disconnect platform.'
      })
    }
  }
)


  return router
}
