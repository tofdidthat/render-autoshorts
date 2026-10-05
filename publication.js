import crypto from 'node:crypto'
import fs from 'node:fs'

export const publicationProviders = ['youtube', 'tiktok', 'instagram', 'telegram', 'discord']
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
export const validPublicationTicket = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export async function setupPublicationDatabase(db) {
  for (const platform of ['telegram','discord']) {
    for (const table of [`${platform}_connections`,`${platform}_connect_codes`]) {
      await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES account_users(id) ON DELETE CASCADE`)
    }
    await db.query(`CREATE INDEX IF NOT EXISTS ${platform}_connections_account_idx ON ${platform}_connections(user_id)`)
  }
  await db.query(`CREATE TABLE IF NOT EXISTS desktop_publications (
    id UUID PRIMARY KEY,
    ticket_hash TEXT UNIQUE NOT NULL,
    render_id UUID UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
    credential_id UUID NOT NULL REFERENCES desktop_credentials(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    targets JSONB NOT NULL DEFAULT '[]',
    results JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','complete','cancelled','uncertain')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '10 minutes'
  )`)
}

export function createPublicationService({ db, renders, handlers, backendUrl, frontendUrl, fetcher = (...args) => fetch(...args) }) {
  const running = new Set()
  async function bridge(provider, action, body, accountToken) {
    const origin = new URL(frontendUrl())
    if (origin.protocol !== 'https:' || !process.env.ONECE_INTERNAL_SECRET) throw new Error('Publishing service unavailable')
    const response = await fetcher(new URL('/api/desktop/publish', origin).toString(), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(action === 'publish' ? 280000 : 90000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accountToken}`,
        'X-1CE-Internal-Secret': process.env.ONECE_INTERNAL_SECRET },
      body: JSON.stringify({ provider, action, ...body })
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error('Platform service could not complete the request')
    return data
  }
  async function getConnection(provider, userId) {
    const result = await db.query(`SELECT * FROM ${provider}_connections WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId])
    return result.rows[0] || null
  }
  function fingerprint(provider, connection) {
    const identity = provider === 'youtube' ? (connection.refresh_token || connection.access_token)
      : provider === 'tiktok' ? (connection.open_id || connection.refresh_token || connection.access_token)
      : provider === 'instagram' ? (connection.instagram_user_id || connection.access_token)
      : provider === 'telegram' ? `${connection.chat_id}:${connection.thread_id || ''}`
      : `${connection.guild_id}:${connection.channel_id}`
    return hash(`${provider}:${connection.id}:${identity}`)
  }
  async function connections(userId, accountToken) {
    const list = []
    for (const provider of publicationProviders) {
      const connection = await getConnection(provider, userId)
      if (!connection) { list.push({ provider, ready: false, reasonCode:'not_connected', reason: 'Conecte novamente esta plataforma em Connections para vincular a conta 1CE.' }); continue }
      const item = { provider, ready: true, fingerprint: fingerprint(provider, connection),
        reasonCode:'ready',
        name: provider === 'telegram' ? `${connection.chat_title || connection.chat_id}${connection.thread_id ? ' / tópico '+connection.thread_id : ''}`
          : provider === 'discord' ? `${connection.guild_name || connection.guild_id} / ${connection.channel_name || connection.channel_id}`
          : provider === 'instagram' ? connection.username || connection.instagram_user_id
          : provider === 'tiktok' ? connection.open_id : 'Canal YouTube conectado à conta 1CE',
        visibility: provider === 'tiktok' ? 'Caixa de entrada: concluir publicação no TikTok'
          : provider === 'instagram' ? 'Reel na conta selecionada'
          : provider === 'telegram' || provider === 'discord' ? 'Membros do chat/canal selecionado' : 'Público' }
      if (provider === 'telegram' && !process.env.TELEGRAM_BOT_TOKEN || provider === 'discord' && !process.env.DISCORD_BOT_TOKEN) {
        item.ready = false; item.reasonCode='bot_not_configured'; item.reason = 'Bot não configurado no Railway.'
      } else if (['youtube','tiktok','instagram'].includes(provider)) {
        try {
          const profile = await bridge(provider, 'describe', {}, accountToken)
          if (!profile.connected) { item.ready=false; item.reasonCode=profile.reasonCode || 'token_invalid'; item.reason=({
            instagram_expired:'A conexão do Instagram expirou. Reconecte em Connections.',
            instagram_token_invalid:'O Instagram recusou o token. Reconecte em Connections.',
            instagram_permission:'O Instagram não autorizou a consulta desta conta. Confira as permissões do aplicativo Meta.',
            instagram_profile_unavailable:'O Instagram não retornou o perfil. Tente novamente ou confira a configuração do aplicativo Meta.',
            instagram_identity_mismatch:'O identificador salvo do Instagram não corresponde ao perfil. Reconecte após a atualização da 1CE.'
          })[profile.reasonCode] || 'Reconecte esta plataforma em Connections.' }
          else { item.name = profile.name || item.name; item.note=profile.note || null }
        } catch { item.ready=false; item.reasonCode='service_unavailable'; item.reason='Conexão ou serviço de publicação indisponível. Confira Connections.' }
      }
      list.push(item)
    }
    return list
  }
  async function create({ renderId, title, userId, credentialId }) {
    const render = renders.get(renderId)
    if (!render || render.ownerUserId !== userId || !fs.existsSync(render.path) || Date.now()-render.createdAt >= 600000) return null
    const ticket = crypto.randomBytes(32).toString('base64url')
    const id = crypto.randomUUID()
    const result = await db.query(`INSERT INTO desktop_publications (id,ticket_hash,render_id,user_id,credential_id,title)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (render_id) DO NOTHING RETURNING id`,
    [id,hash(ticket),renderId,userId,credentialId,title])
    if (!result.rowCount) return null
    await db.query(`DELETE FROM desktop_publications WHERE created_at < NOW()-INTERVAL '7 days' AND status <> 'processing'`)
    return { requestId: id, ticket, reviewUrl: `${new URL(backendUrl()).origin}/api/desktop/publish#ticket=${ticket}`, expiresInSeconds: 600 }
  }
  async function lookup(ticket, userId) {
    if (!validPublicationTicket(ticket)) return null
    const result = await db.query(`SELECT p.*, c.revoked_at, c.expires_at > NOW() AS credential_live,
      p.expires_at > NOW() AS live FROM desktop_publications p JOIN desktop_credentials c ON c.id=p.credential_id
      WHERE p.ticket_hash=$1 AND p.user_id=$2`,[hash(ticket),userId])
    const row = result.rows[0]
    if (!row || row.revoked_at || !row.credential_live) return null
    if (row.status === 'pending' && (!row.live || !renders.has(row.render_id))) return null
    // A process restart cannot safely replay requests whose provider side effect is unknown.
    if (row.status === 'processing' && !running.has(row.id)) {
      await db.query(`UPDATE desktop_publications SET status='uncertain' WHERE id=$1 AND status='processing'`,[row.id])
      row.status='uncertain'
    }
    return row
  }
  async function byId(id, userId) {
    const result=await db.query(`SELECT id,title,status,results FROM desktop_publications WHERE id=$1 AND user_id=$2`,[id,userId])
    const row=result.rows[0]
    if (row?.status==='processing' && !running.has(row.id)) {
      await db.query(`UPDATE desktop_publications SET status='uncertain' WHERE id=$1 AND status='processing'`,[row.id])
      row.status='uncertain'
    }
    return row || null
  }
  async function legacy(provider, body, connection) {
    let status=200, output
    const response = { status(code) {status=code;return this}, json(data) {output=data;return data} }
    const publicationFetch = (url, options={}) => fetcher(url, { ...options, redirect:'error', signal:AbortSignal.timeout(120000) })
    await handlers[provider]({ body, publicationConnection: connection, publicationFetch }, response)
    if (status >= 400 || !output?.ok) throw new Error('Platform transfer failed')
    return output
  }
  async function execute(provider, row, metadata, accountToken, expectedFingerprint) {
    const connection=await getConnection(provider,row.user_id)
    if (!connection || fingerprint(provider,connection)!==expectedFingerprint) throw new Error('Connection changed')
    const render=renders.get(row.render_id)
    if (!render || render.ownerUserId !== row.user_id) throw new Error('Render expired')
    const body={renderId:row.render_id,title:metadata.title,description:metadata.description,audioFileName:metadata.title+'.mp3'}
    if (provider==='telegram'||provider==='discord') {
      await legacy(provider,body,connection)
      return {state:'published',message:'Enviado ao chat/canal confirmado.'}
    }
    if (provider==='instagram') {
      const grant=crypto.randomBytes(32).toString('base64url')
      render.platformGrantHash=hash(grant)
      try {
        const videoUrl=`${new URL(backendUrl()).origin}/api/desktop/platform-render/${row.render_id}?grant=${grant}`
        const result=await bridge(provider,'publish',{renderId:row.render_id,videoUrl,caption:[metadata.title,metadata.description].filter(Boolean).join('\n\n')},accountToken)
        if (!result.ok || !result.mediaId) throw new Error('Instagram publication incomplete')
        return {state:'published',message:'Reel publicado.',id:String(result.mediaId)}
      } finally {delete render.platformGrantHash}
    }
    const start=await bridge(provider,'init',{title:metadata.title,description:metadata.description,
      privacyStatus:metadata.youtubePrivacy,fileSize:render.size,mimeType:render.mimeType},accountToken)
    const sent=await legacy(provider,{...body,...start},null)
    if (provider==='youtube') {
      if (!sent.video?.id) throw new Error('YouTube result unknown')
      return {state:'uploaded',message:`Vídeo enviado ao YouTube (${metadata.youtubePrivacy}). Processamento da plataforma pode continuar.`,
        id:String(sent.video.id),url:'https://www.youtube.com/watch?v='+encodeURIComponent(sent.video.id)}
    }
    return {state:'uploaded',message:'Enviado à caixa de entrada do TikTok. Abra o aplicativo para concluir a publicação.',id:String(start.publishId)}
  }
  async function confirm(row, metadata, accountToken) {
    metadata={...metadata,youtubePrivacy:'public'}
    const available=await connections(row.user_id,accountToken)
    const selected=metadata.targets.map(target=>available.find(item=>item.provider===target.provider && item.ready && item.fingerprint===target.fingerprint))
    if (selected.some(item=>!item)) return false
    const render=renders.get(row.render_id)
    if (!render || render.reviewEditing || render.reviewConfirming || render.ownerUserId!==row.user_id || Date.now()-render.createdAt>=600000 || !fs.existsSync(render.path)) return false
    render.reviewConfirming=true
    let claimed
    try { claimed=await db.query(`UPDATE desktop_publications SET status='processing',title=$1,description=$2,targets=$3
      WHERE id=$4 AND user_id=$5 AND status='pending' AND expires_at>NOW()
      AND EXISTS (SELECT 1 FROM desktop_credentials c WHERE c.id=desktop_publications.credential_id
        AND c.revoked_at IS NULL AND c.expires_at>NOW()) RETURNING id`,
    [metadata.title,metadata.description,JSON.stringify(metadata.targets),row.id,row.user_id])
    } finally {delete render.reviewConfirming}
    if (!claimed.rowCount) return false
    running.add(row.id)
    render.publicationBusyUntil=Date.now()+30*60000
    // The HTTP confirmation is acknowledged before transfers; the ledger outlives the browser tab.
    void (async()=> {
      const results={}
      try {
        for (const target of metadata.targets) {
          results[target.provider]={state:'processing',message:'Envio em andamento.'}
          await db.query(`UPDATE desktop_publications SET results=$1 WHERE id=$2`,[JSON.stringify(results),row.id])
          try {results[target.provider]=await execute(target.provider,row,metadata,accountToken,target.fingerprint)}
          catch {results[target.provider]={state:'uncertain',message:'Não foi possível confirmar o resultado. Confira a plataforma antes de tentar novamente.'}}
          await db.query(`UPDATE desktop_publications SET results=$1 WHERE id=$2`,[JSON.stringify(results),row.id])
        }
        await db.query(`UPDATE desktop_publications SET status='complete',results=$1 WHERE id=$2`,[JSON.stringify(results),row.id])
      } catch {
        await db.query(`UPDATE desktop_publications SET status='uncertain' WHERE id=$1`,[row.id]).catch(()=>{})
      } finally {running.delete(row.id);delete render.publicationBusyUntil}
    })()
    return true
  }
  function checkGrant(render,grant) {
    return render && render.publicationBusyUntil>Date.now() && validPublicationTicket(grant) && render.platformGrantHash===hash(grant)
  }
  function reviewOrigin() {
    const url=new URL(frontendUrl())
    if(url.protocol!=='https:')throw new Error('Review origin must use HTTPS')
    return url.origin
  }
  return {create,lookup,byId,connections,confirm,checkGrant,reviewOrigin}
}
