import { Router } from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function createDiscordRouter({
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

router.post('/discord/connect-code', async (req, res) => {
  try {
    const {
      clientId
    } = req.body || {}

    if (!clientId) {
      return res.status(400).json({
        error: 'clientId não informado.'
      })
    }

    const account = req.headers.authorization ? await getAccountFromRequest(req) : null
    if (req.headers.authorization && !account) return res.status(401).json({ error: 'Invalid 1CE session.' })
    const code =
      crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase()

    await db.query(
      `
        INSERT INTO discord_connect_codes (
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
        account?.id || null
      ]
    )

    return res.json({
      ok: true,
      code
    })

  } catch (error) {
    console.error(
      'Discord connect code error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to create Discord connection code.'
    })
  }
})

// ============================================================
// DISCORD CONNECTION STATUS
// Verifica se este navegador já conectou um Discord
// ============================================================

router.get('/discord/connect-status', async (req, res) => {
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
            guild_id,
            guild_name,
            channel_id,
            channel_name,
            created_at
          FROM discord_connections
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
        guildId:
          connection.guild_id,

        guildName:
          connection.guild_name,

        channelId:
          connection.channel_id,

        channelName:
          connection.channel_name,

        connectedAt:
          connection.created_at
      }
    })

  } catch (error) {
    console.error(
      'Discord connection status error:',
      error
    )

    return res.status(500).json({
      error:
        'Unable to check Discord connection.'
    })
  }
})

function verifyDiscordRequest(req) {
  try {
    const signature =
      req.headers['x-signature-ed25519']

    const timestamp =
      req.headers['x-signature-timestamp']

    const publicKey =
      process.env.DISCORD_PUBLIC_KEY

    if (
      !signature ||
      !timestamp ||
      !publicKey ||
      !req.rawBody
    ) {
      return false
    }

    const message =
      Buffer.concat([
        Buffer.from(timestamp),
        req.rawBody
      ])

    const publicKeyDer =
      Buffer.concat([
        Buffer.from(
          '302a300506032b6570032100',
          'hex'
        ),

        Buffer.from(
          publicKey,
          'hex'
        )
      ])

    return crypto.verify(
      null,
      message,
      {
        key: publicKeyDer,
        format: 'der',
        type: 'spki'
      },
      Buffer.from(signature, 'hex')
    )

  } catch (error) {
    console.error(
      'Discord signature verification error:',
      error
    )

    return false
  }
}

// ============================================================
// DISCORD INTERACTIONS
// Recebe o comando /connect
// ============================================================

router.post('/discord/interactions', async (req, res) => {
  try {

    if (!verifyDiscordRequest(req)) {
  return res
    .status(401)
    .send('Invalid request signature')
}
    const interaction = req.body || {}

    // Discord verifica o endpoint com um PING
    if (interaction.type === 1) {
      return res.json({
        type: 1
      })
    }

    // Slash command
    if (
      interaction.type === 2 &&
      interaction.data?.name === 'connect'
    ) {
      const code =
        String(
          interaction.data?.options?.find(
            option => option.name === 'code'
          )?.value || ''
        )
          .trim()
          .toUpperCase()

      const guildId =
        String(interaction.guild_id || '')

      const channelId =
        String(interaction.channel_id || '')

      const guildName =
        String(
          interaction.guild?.name ||
          'Discord'
        )

      const channelName =
        String(
          interaction.channel?.name ||
          'Discord Channel'
        )

      let memberPermissions = 0n

      try {
        memberPermissions =
          BigInt(
            String(
              interaction.member?.permissions ||
              '0'
            )
          )
      } catch {
        memberPermissions = 0n
      }

      const canManageServer =
        (memberPermissions & 0x8n) === 0x8n ||
        (memberPermissions & 0x20n) === 0x20n

      if (!canManageServer) {
        return res.json({
          type: 4,
          data: {
            content:
              '❌ Only a server administrator or member with Manage Server permission can connect this destination to 1CE.',
            flags: 64
          }
        })
      }

      if (!guildId || !channelId) {
        return res.json({
          type: 4,
          data: {
            content:
              '❌ This command must be used inside a server channel.',
            flags: 64
          }
        })
      }

      if (!code) {
        return res.json({
          type: 4,
          data: {
            content:
              '❌ Connection code missing.',
            flags: 64
          }
        })
      }

      const codeResult =
        await db.query(
          `
            SELECT
              code,
              client_id, user_id
            FROM discord_connect_codes
            WHERE code = $1
              AND used_at IS NULL
              AND expires_at > NOW()
            LIMIT 1
          `,
          [code]
        )

      if (!codeResult.rows.length) {
        return res.json({
          type: 4,
          data: {
            content:
              '❌ Invalid or expired connection code.',
            flags: 64
          }
        })
      }

      const claimed=await db.query(`UPDATE discord_connect_codes SET used_at=NOW()
        WHERE code=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING code`,[code])
      if (!claimed.rowCount) return res.json({type:4,data:{content:'Invalid or already used connection code.',flags:64}})
      const clientId =
        codeResult.rows[0].client_id

      await db.query(
        `
          INSERT INTO discord_connections (
            client_id,
            guild_id,
            guild_name,
            channel_id,
            channel_name, user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (
            client_id,
            guild_id,
            channel_id
          )
          DO UPDATE SET
            guild_name = EXCLUDED.guild_name,
            channel_name = EXCLUDED.channel_name,
            user_id = EXCLUDED.user_id
        `,
        [
          clientId,
          guildId,
          guildName,
          channelId,
          channelName,
          codeResult.rows[0].user_id
        ]
      )

      await db.query(
        `
          UPDATE discord_connect_codes
          SET used_at = NOW()
          WHERE code = $1
        `,
        [code]
      )

      console.log(
        'Discord conectado:',
        {
          clientId,
          guildId,
          channelId,
          channelName
        }
      )

      return res.json({
        type: 4,
        data: {
          content:
            '✅ Connected to 1CE!',
          flags: 64
        }
      })
    }

    return res.json({
      type: 4,
      data: {
        content: 'Unknown command.',
        flags: 64
      }
    })

  } catch (error) {
    console.error(
      'Discord interaction error:',
      error
    )

    return res.status(500).json({
      error:
        'Discord interaction error.'
    })
  }
})

// ============================================================
// DISCORD PUBLISH
// Envia capa + título/descrição + áudio
// ============================================================

const publishDiscord = async (req, res) => {
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

    const botToken =
      process.env.DISCORD_BOT_TOKEN

    if (!botToken) {
      return res.status(500).json({
        error:
          'Discord bot não configurado.'
      })
    }

    // -------------------------------------------------------
    // Busca o canal Discord conectado
    // -------------------------------------------------------

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
            guild_id,
            channel_id,
            channel_name
          FROM discord_connections
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
          'Discord não conectado.'
      })
    }

    const connection =
      connectionResult.rows[0]

    const channelId =
      connection.channel_id

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
      `${renderId}-discord.jpg`
    )

    audioPath = path.join(
      os.tmpdir(),
      `${renderId}-discord.mp3`
    )

    // -------------------------------------------------------
    // Extrai a capa do vídeo
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
    // Extrai MP3
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
        .slice(0, 1800)

    const originalAudioName =
      String(
        audioFileName ||
        `${safeTitle}.mp3`
      )
        .trim()
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\.[^.]+$/, '') +
      '.mp3'

    const discordMessage =
      safeDescription
        ? `🔥 ${safeTitle}\n\n${safeDescription}`
        : `🔥 ${safeTitle}`

   // -------------------------------------------------------
// Envia capa + áudio na MESMA mensagem
// -------------------------------------------------------

const imageBuffer =
  await fs.promises.readFile(
    imagePath
  )

const audioBuffer =
  await fs.promises.readFile(
    audioPath
  )

const discordForm =
  new FormData()

discordForm.append(
  'payload_json',
  JSON.stringify({
    content: discordMessage,

    attachments: [
      {
        id: 0,
        filename: 'cover.jpg'
      },
      {
        id: 1,
        filename: originalAudioName
      }
    ]
  })
)

discordForm.append(
  'files[0]',
  new Blob(
    [imageBuffer],
    {
      type: 'image/jpeg'
    }
  ),
  'cover.jpg'
)

discordForm.append(
  'files[1]',
  new Blob(
    [audioBuffer],
    {
      type: 'audio/mpeg'
    }
  ),
  originalAudioName
)

const discordResponse =
  await (req.publicationFetch || fetch)(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: 'POST',

      headers: {
        Authorization:
          `Bot ${botToken}`
      },

      body: discordForm
    }
  )

const discordData =
  await discordResponse
    .json()
    .catch(() => ({}))

if (!discordResponse.ok) {
  throw new Error(
    discordData?.message ||
    `Discord respondeu HTTP ${discordResponse.status}`
  )
}

    console.log(
      `Discord publicado: ${renderId} -> ${connection.channel_name}`
    )

    return res.json({
      ok: true,
      renderId
    })

  } catch (error) {
    console.error(
      'Erro Discord:',
      error
    )

    return res.status(500).json({
      error:
        'Falha ao publicar no Discord.',

      details:
        error?.message
    })

  } finally {
    deleteFile(imagePath)
    deleteFile(audioPath)
  }
}

desktopHandlers.discord = publishDiscord
router.post('/publish-discord', publishDiscord)


// ============================================================
// DISCORD
// Registra o comando /connect no servidor de teste
// ============================================================


router.delete(
  '/account/discord/connection',
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
        'DELETE FROM discord_connections WHERE user_id=$1',
        [account.id]
      )

      await db.query(
        'DELETE FROM discord_connect_codes WHERE user_id=$1',
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

export async function registerDiscordCommands(fetcher = (...args) => globalThis.fetch(...args)) {
  const fetch = (...args) => fetcher(...args)
  try {
    const botToken =
      process.env.DISCORD_BOT_TOKEN

    const applicationId =
      process.env.DISCORD_APPLICATION_ID

    const guildId =
      process.env.DISCORD_GUILD_ID

    if (
      !botToken ||
      !applicationId ||
      !guildId
    ) {
      console.log(
        'Discord variables not configured.'
      )
      return
    }

    const response = await fetch(
      `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bot ${botToken}`,

          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          name: 'connect',

          description:
            'Connect this Discord channel to 1CE',

          // MANAGE_GUILD (Manage Server). The handler also validates this
          // permission so an old command registration cannot bypass it.
          default_member_permissions: '32',

          dm_permission: false,

          options: [
            {
              name: 'code',

              description:
                'Connection code generated by 1CE',

              type: 3,

              required: true
            }
          ]
        })
      }
    )

    const data =
      await response
        .json()
        .catch(() => ({}))

    if (!response.ok) {
      throw new Error(
        data?.message ||
        `Discord HTTP ${response.status}`
      )
    }

    console.log(
      'Discord /connect command ready.'
    )

  } catch (error) {
    console.error(
      'Discord command registration error:',
      error
    )
  }
}
