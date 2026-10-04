import express from 'express'
import multer from 'multer'
import crypto from 'node:crypto'
import fs from 'node:fs'

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const secret = () => crypto.randomBytes(32).toString('base64url')
const validSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
export const normalizeUserCode = value => String(value || '').replace(/-/g, '').toUpperCase()
const validUserCode = value => /^[A-F0-9]{8}$/.test(value)
const ttl = 600

export async function setupDesktopDatabase(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS desktop_authorizations (
    device_code_hash TEXT PRIMARY KEY,
    user_code TEXT UNIQUE NOT NULL,
    code_challenge TEXT NOT NULL,
    device_name TEXT NOT NULL,
    user_id INTEGER REFERENCES account_users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
    last_poll_at TIMESTAMPTZ
  )`)
  await db.query(`CREATE TABLE IF NOT EXISTS desktop_credentials (
    id UUID PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    device_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days',
    revoked_at TIMESTAMPTZ
  )`)
  await db.query(`CREATE INDEX IF NOT EXISTS desktop_credentials_user_idx ON desktop_credentials(user_id)`)
  await db.query(`CREATE TABLE IF NOT EXISTS desktop_google_states (
    state_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    user_code TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
  )`)
}

// These states are separate from platform OAuth tokens and cannot select arbitrary redirects.
export async function startDesktopGoogle(req, res, db) {
  const code = normalizeUserCode(req.query.desktop_user_code)
  if (!validUserCode(code)) throw new Error('Invalid desktop code')
  const pending = await db.query(`SELECT user_code FROM desktop_authorizations
    WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()`, [code])
  if (!pending.rowCount) throw new Error('Desktop request expired')
  const state = `desktop_${secret()}`
  const browser = secret()
  await db.query(`INSERT INTO desktop_google_states (state_hash, browser_hash, user_code)
    VALUES ($1,$2,$3)`, [hash(state), hash(browser), code])
  res.cookie('desktop_oauth', browser, { httpOnly: true, secure: true, sameSite: 'lax',
    path: '/account/google/callback', maxAge: ttl * 1000 })
  return state
}

export async function consumeDesktopGoogle(req, res, db) {
  const state = String(req.query.state || '')
  const browser = String(req.headers.cookie || '').split(';').map(v => v.trim())
    .find(v => v.startsWith('desktop_oauth='))?.slice('desktop_oauth='.length)
  if (!validSecret(browser)) throw new Error('Invalid desktop browser')
  const result = await db.query(`DELETE FROM desktop_google_states
    WHERE state_hash = $1 AND browser_hash = $2 AND expires_at > NOW() RETURNING user_code`,
  [hash(state), hash(browser)])
  res.clearCookie('desktop_oauth', { httpOnly: true, secure: true, sameSite: 'lax', path: '/account/google/callback' })
  if (!result.rowCount) throw new Error('Invalid desktop OAuth state')
  return result.rows[0].user_code
}

export function createDesktopRouter({ db, getAccountFromRequest, renderAudio, renders,
  deleteRender, deleteFile, ready = () => true, publicUrl, execFileAsync }) {
  const router = express.Router()
  const attempts = new Map()
  const activeUploads = new Set()
  const multipart = multer({
    storage: multer.diskStorage({}), limits: { fileSize: 200 * 1024 * 1024, files: 2, fields: 0, parts: 2 }
  }).fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }])
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (!ready()) return res.status(503).json({ error: 'Desktop storage unavailable.' })
    next()
  })
  function limited(req, res, next) {
    const now = Date.now()
    for (const [key, item] of attempts) if (item.until < now) attempts.delete(key)
    const item = attempts.get(req.ip) || { count: 0, until: now + 60000 }
    if (attempts.size >= 10000 && !attempts.has(req.ip)) return res.sendStatus(429)
    attempts.set(req.ip, item)
    if (++item.count > 40) return res.status(429).json({ error: 'Too many requests.' })
    next()
  }
  async function account(req, res, next) {
    const user = await getAccountFromRequest(req)
    if (!user) return res.status(401).json({ error: 'Invalid 1CE session.' })
    req.account = user
    next()
  }
  async function desktop(req, res, next) {
    const token = req.headers.authorization?.match(/^Bearer (1ce_desktop_[A-Za-z0-9_-]{43})$/)?.[1]
    if (!token) return res.status(401).json({ error: 'Invalid desktop credential.' })
    const result = await db.query(`SELECT c.id, c.user_id FROM desktop_credentials c
      JOIN account_users u ON u.id = c.user_id
      WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND c.expires_at > NOW()`, [hash(token)])
    if (!result.rowCount) return res.status(401).json({ error: 'Invalid desktop credential.' })
    req.desktop = result.rows[0]
    next()
  }
  router.post('/authorize', limited, async (req, res) => {
    if (!validSecret(req.body?.code_challenge) || req.body?.code_challenge_method !== 'S256') {
      return res.status(400).json({ error: 'S256 code_challenge required.' })
    }
    const name = req.body?.device_name || 'Export / Upload 1ce'
    if (typeof name !== 'string' || name.length > 100 || /[\x00-\x1f]/.test(name)) {
      return res.status(400).json({ error: 'Invalid device_name.' })
    }
    let origin
    try { origin = new URL(publicUrl()).origin } catch {}
    if (!origin || !origin.startsWith('https://')) return res.status(503).json({ error: 'BACKEND_PUBLIC_URL must use HTTPS.' })
    await db.query(`DELETE FROM desktop_authorizations WHERE expires_at < NOW()`)
    await db.query(`DELETE FROM desktop_google_states WHERE expires_at < NOW()`)
    const deviceCode = secret()
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase()
    await db.query(`INSERT INTO desktop_authorizations
      (device_code_hash, user_code, code_challenge, device_name) VALUES ($1,$2,$3,$4)`,
    [hash(deviceCode), userCode, req.body.code_challenge, name])
    res.status(201).json({ device_code: deviceCode, user_code: userCode,
      verification_uri: `${origin}/api/desktop/connect`,
      verification_uri_complete: `${origin}/api/desktop/connect?user_code=${userCode}`,
      expires_in: ttl, interval: 5 })
  })
  router.get('/request/:code', limited, async (req, res) => {
    const code = normalizeUserCode(req.params.code)
    if (!validUserCode(code)) return res.sendStatus(400)
    const result = await db.query(`SELECT device_name FROM desktop_authorizations
      WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()`, [code])
    if (!result.rowCount) return res.sendStatus(404)
    res.json({ device_name: result.rows[0].device_name, user_code: code, scope: 'render:write' })
  })
  router.post('/approve', limited, account, async (req, res) => {
    const code = normalizeUserCode(req.body?.user_code)
    if (!validUserCode(code) || typeof req.body?.approve !== 'boolean') return res.sendStatus(400)
    const result = await db.query(`UPDATE desktop_authorizations SET user_id = $1, status = $2
      WHERE user_code = $3 AND status = 'pending' AND expires_at > NOW() RETURNING user_code`,
    [req.account.id, req.body.approve ? 'approved' : 'denied', code])
    if (!result.rowCount) return res.status(409).json({ error: 'Request expired or already decided.' })
    res.json({ ok: true })
  })
  router.post('/token', limited, async (req, res) => {
    const { device_code: code, code_verifier: verifier } = req.body || {}
    if (!validSecret(code) || typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return res.sendStatus(400)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(`SELECT *, expires_at > NOW() AS live,
        (last_poll_at IS NULL OR last_poll_at < NOW() - INTERVAL '5 seconds') AS can_poll
        FROM desktop_authorizations WHERE device_code_hash = $1 FOR UPDATE`, [hash(code)])
      const request = result.rows[0]
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
      if (!request || !request.live || request.status === 'consumed' || request.code_challenge !== challenge) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'invalid_grant' })
      }
      if (!request.can_poll) {
        await client.query('ROLLBACK')
        return res.status(429).json({ error: 'slow_down', interval: 5 })
      }
      await client.query(`UPDATE desktop_authorizations SET last_poll_at = NOW() WHERE device_code_hash = $1`, [hash(code)])
      if (request.status !== 'approved') {
        await client.query('COMMIT')
        return res.status(400).json({ error: request.status === 'denied' ? 'access_denied' : 'authorization_pending' })
      }
      const token = `1ce_desktop_${secret()}`
      const id = crypto.randomUUID()
      const inserted = await client.query(`INSERT INTO desktop_credentials (id,user_id,token_hash,device_name)
        VALUES ($1,$2,$3,$4) RETURNING expires_at`, [id, request.user_id, hash(token), request.device_name])
      await client.query(`UPDATE desktop_authorizations SET status = 'consumed' WHERE device_code_hash = $1`, [hash(code)])
      await client.query('COMMIT')
      res.json({ access_token: token, token_type: 'Bearer', credential_id: id,
        scope: 'render:write', expires_at: inserted.rows[0].expires_at })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  })
  router.get('/credentials', account, async (req, res) => {
    const result = await db.query(`SELECT id, device_name, created_at, expires_at, revoked_at
      FROM desktop_credentials WHERE user_id = $1 ORDER BY created_at DESC`, [req.account.id])
    res.json({ credentials: result.rows })
  })
  router.delete('/credentials/:id', account, async (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.sendStatus(400)
    const result = await db.query(`UPDATE desktop_credentials SET revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.account.id])
    res.sendStatus(result.rowCount ? 204 : 404)
  })
  router.post('/revoke', desktop, async (req, res) => {
    await db.query(`UPDATE desktop_credentials SET revoked_at = NOW() WHERE id = $1`, [req.desktop.id])
    res.sendStatus(204)
  })
  router.post('/upload', desktop, (req, res, next) => {
    if (activeUploads.has(req.desktop.user_id)) return res.status(429).json({ error: 'Upload already in progress.' })
    activeUploads.add(req.desktop.user_id)
    const release = () => activeUploads.delete(req.desktop.user_id)
    const cleanup = () => { for (const files of Object.values(req.files || {})) for (const file of files) deleteFile(file.path) }
    multipart(req, res, async error => {
      if (error) { cleanup(); release(); return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Invalid upload.' }) }
      try {
        const audio = req.files?.audio?.[0]
        const cover = req.files?.cover?.[0]
        if (!audio) return res.status(400).json({ error: 'MP3 audio is required.' })
        // Inspect actual media rather than trusting filename or MIME supplied by the desktop.
        const probe = async file => JSON.parse((await execFileAsync('ffprobe', [
          '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-show_streams', '-show_format', '-of', 'json', file.path
        ], { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout)
        const audioInfo = await probe(audio)
        if (audioInfo.format?.format_name !== 'mp3' || !audioInfo.streams?.some(s => s.codec_name === 'mp3' && s.codec_type === 'audio')) {
          return res.status(400).json({ error: 'Audio must be MP3.' })
        }
        if (cover) {
          const imageInfo = await probe(cover)
          if (!['image2', 'jpeg_pipe', 'png_pipe', 'webp_pipe'].includes(imageInfo.format?.format_name) ||
            !imageInfo.streams?.some(s => ['mjpeg', 'png', 'webp'].includes(s.codec_name))) {
            return res.status(400).json({ error: 'Cover must be JPG, PNG or WEBP.' })
          }
        }
        const render = await renderAudio({ audio, cover, ownerUserId: req.desktop.user_id })
        res.status(201).json({ ok: true, renderId: render.id, size: render.size,
          mimeType: render.mimeType, expiresInSeconds: ttl, published: false })
      } catch (error) {
        if (error instanceof SyntaxError || error.cmd?.includes('ffprobe')) {
          res.status(400).json({ error: 'Invalid media.' })
        } else { next(error) }
      } finally { cleanup(); release() }
    })
  })
  router.get('/renders/:id', desktop, (req, res) => {
    const render = renders.get(req.params.id)
    if (!render || render.ownerUserId !== req.desktop.user_id || !fs.existsSync(render.path)) return res.sendStatus(404)
    res.type('video/mp4').sendFile(render.path)
  })
  router.delete('/renders/:id', desktop, (req, res) => {
    const render = renders.get(req.params.id)
    if (!render || render.ownerUserId !== req.desktop.user_id) return res.sendStatus(404)
    deleteRender(render.id)
    res.sendStatus(204)
  })
  router.get('/connect', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    res.type('html').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <title>Conectar Export / Upload 1ce</title><link rel="stylesheet" href="/api/desktop/connect.css">
      <main><h1>Conectar Export / Upload 1ce</h1><p>Autorize apenas se iniciou esta conexão no seu computador.</p>
      <form id="lookup"><label>Código exibido no computador <input id="code" required maxlength="9"></label><button>Ver solicitação</button></form>
      <p id="request"></p><section id="login" hidden><a id="google">Entrar com Google</a>
      <form id="signin"><label>E-mail <input id="email" type="email" autocomplete="username" required></label>
      <label>Senha <input id="password" type="password" autocomplete="current-password" required></label><button>Entrar na 1CE</button></form></section>
      <section id="consent" hidden><p id="identity"></p><p>Permitir gerar vídeos temporários a partir de MP3 e capa. Nenhuma publicação será feita.</p>
      <button id="approve">Autorizar este computador</button><button id="deny">Recusar</button></section><p id="message" role="status"></p></main>
      <script src="/api/desktop/connect.js"></script></html>`)
  })
  router.get('/connect.css', (req, res) => res.type('css').send('body{font:18px system-ui;background:#111;color:#fff;margin:40px auto;max-width:600px;padding:20px}label,input{display:block}input,button{font:inherit;padding:10px;margin:10px 0}a{color:#9af}button{cursor:pointer}'))
  router.get('/connect.js', (req, res) => res.type('js').send(`
    const el = id => document.getElementById(id);
    let session = new URLSearchParams(location.hash.slice(1)).get('session');
    history.replaceState(null, '', location.pathname + location.search);
    let code;
    async function api(url, body, authenticated = false) {
      const response = await fetch(url, {method: body ? 'POST' : 'GET', headers: {
        ...(body ? {'Content-Type':'application/json'} : {}), ...(authenticated ? {Authorization:'Bearer '+session} : {})
      }, ...(body ? {body:JSON.stringify(body)} : {})});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Solicitação inválida ou expirada.');
      return data;
    }
    const report = error => {el('message').textContent = error.message;};
    async function load() {
      code = el('code').value.replace(/-/g,'').toUpperCase();
      const data = await api('/api/desktop/request/'+encodeURIComponent(code));
      el('request').textContent = data.device_name+' — código '+code;
      el('google').href = '/account/google?desktop_user_code='+encodeURIComponent(code);
      el('login').hidden = Boolean(session); el('consent').hidden = true;
      if (session) {
        const me = await api('/account/me', null, true);
        el('identity').textContent = 'Conta: '+(me.user?.email || me.email || '1CE');
        el('consent').hidden = false;
      }
    }
    el('lookup').onsubmit = event => {event.preventDefault(); load().catch(report);};
    el('signin').onsubmit = async event => {
      event.preventDefault();
      try {const data = await api('/account/email/login', {email:el('email').value,password:el('password').value});
        session = data.session; el('password').value=''; await load();} catch(error) {report(error);}
    };
    async function decide(approve) {
      el('approve').disabled=true; el('deny').disabled=true;
      try {await api('/api/desktop/approve', {user_code:code,approve}, true);
        session=null; el('consent').hidden=true; el('message').textContent=approve?'Conectado. Volte ao computador.':'Conexão recusada.';
      } catch(error) {report(error);el('approve').disabled=false;el('deny').disabled=false;}
    }
    el('approve').onclick=()=>decide(true); el('deny').onclick=()=>decide(false);
    el('code').value=new URLSearchParams(location.search).get('user_code') || '';
    if(el('code').value) load().catch(report);
  `))
  router.use((error, req, res, next) => {
    console.error('Desktop request failed:', error.message)
    if (res.headersSent) return next(error)
    res.status(500).json({ error: 'Desktop operation failed.' })
  })
  return router
}
