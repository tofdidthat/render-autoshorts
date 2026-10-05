import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PGlite } from '@electric-sql/pglite'
import ffmpeg from 'ffmpeg-static'
import ffprobe from 'ffprobe-static'
import { app, db, renders, setupDatabase, deleteRender } from '../server.js'
import { startDesktopGoogle, consumeDesktopGoogle } from '../desktop.js'
import {publicationRedirectScript} from '../publication-page.js'
import vm from 'node:vm'

const run = promisify(execFile)
const sha = value => crypto.createHash('sha256').update(value).digest('hex')

test('backend: desktop authorization, private renders, revocation and legacy regression', async t => {
  const pg = new PGlite()
  // PGlite executes real PostgreSQL SQL; HTTP routes and media tools are not mocked.
  const query = async (sql, params) => {
    const result = await pg.query(sql, params)
    return { ...result, rowCount: result.affectedRows || result.rows.length }
  }
  db.query = query
  db.connect = async () => ({ query, release() {} })
  process.env.BACKEND_PUBLIC_URL = 'https://backend.example'
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), '1ce-test-'))
  const tools = process.platform === 'win32'
    ? [['ffmpeg.exe', ffmpeg], ['ffprobe.exe', ffprobe.path]]
    : [['ffmpeg', ffmpeg], ['ffprobe', ffprobe.path]]
  for (const [name, source] of tools) fs.copyFileSync(source, path.join(bin, name))
  process.env.PATH = bin + path.delimiter + process.env.PATH
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  async function api(route, { method = 'GET', body, token, form } = {}) {
    const response = await fetch(origin + route, { method, headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }, body: form || (body ? JSON.stringify(body) : undefined) })
    const bytes = Buffer.from(await response.arrayBuffer())
    let data
    try { data = JSON.parse(bytes.toString()) } catch { data = bytes }
    return { status: response.status, data, bytes, headers: response.headers }
  }
  const post = (route, body, token) => api(route, { method: 'POST', body, token })
  try {
    await t.test('desktop fails closed until schema is ready', async () => {
      assert.equal((await post('/api/desktop/authorize', {})).status, 503)
      await setupDatabase()
      assert.ok((await pg.query("SELECT to_regclass('desktop_credentials') AS name")).rows[0].name)
    })
    await t.test('existing desktop handoff redirects safely to the 1CE app',async()=>{
      const ticket='a'.repeat(43),id=crypto.randomUUID()
      let destination
      const location={hash:'#ticket='+ticket,search:'',pathname:'/api/desktop/publish',replace(value){destination=new URL(value)}}
      await vm.runInNewContext(publicationRedirectScript('https://1ce.lol'),{location,URL,URLSearchParams,
        history:{replaceState(){}},sessionStorage:{getItem(){return null},removeItem(){}},
        document:{getElementById(){return {}}},fetch:async()=>Response.json({requestId:id})})
      assert.equal(destination.origin,'https://1ce.lol');assert.equal(destination.pathname,'/app')
      assert.equal(destination.searchParams.get('desktopPublication'),id)
      assert.ok(!destination.search.includes(ticket));assert.equal(new URLSearchParams(destination.hash.slice(1)).get('ticket'),ticket)
    })
    await query(`INSERT INTO account_users (email,name,email_verified) VALUES
      ('first@example.com','First',TRUE),('second@example.com','Second',TRUE)`)
    const session1 = crypto.randomBytes(32).toString('hex')
    const session2 = crypto.randomBytes(32).toString('hex')
    await query(`INSERT INTO account_sessions (user_id, token_hash, expires_at)
      VALUES (1,$1,NOW()+INTERVAL '1 day'),(2,$2,NOW()+INTERVAL '1 day')`, [sha(session1), sha(session2)])
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    const authorize = () => post('/api/desktop/authorize', {
      code_challenge: challenge, code_challenge_method: 'S256', device_name: 'Studio PC'
    })
    const exchange = code => post('/api/desktop/token', { device_code: code, code_verifier: verifier })
    let request, credential
    await t.test('PKCE, consent, throttling and single use', async () => {
      assert.equal((await post('/api/desktop/authorize', { clientId: 'forged' })).status, 400)
      const response = await authorize()
      assert.equal(response.status, 201)
      request = response.data
      assert.equal((await exchange(request.device_code)).data.error, 'authorization_pending')
      assert.equal((await exchange(request.device_code)).data.error, 'slow_down')
      const approve = { user_code: request.user_code, approve: true }
      assert.equal((await post('/api/desktop/approve', approve, 'forged')).status, 401)
      assert.equal((await post('/api/desktop/approve', approve, session1)).status, 200)
      assert.equal((await post('/api/desktop/approve', approve, session2)).status, 409)
      await query(`UPDATE desktop_authorizations SET last_poll_at = NOW()-INTERVAL '6 seconds'`)
      assert.equal((await post('/api/desktop/token', { device_code: request.device_code,
        code_verifier: crypto.randomBytes(32).toString('base64url') })).data.error, 'invalid_grant')
      credential = (await exchange(request.device_code)).data
      assert.match(credential.access_token, /^1ce_desktop_/)
      assert.equal(credential.scope, 'render:write')
      assert.equal((await exchange(request.device_code)).data.error, 'invalid_grant')
      const stored = (await query('SELECT token_hash FROM desktop_credentials')).rows[0]
      assert.equal(stored.token_hash, sha(credential.access_token))
      assert.ok(!JSON.stringify(credential).includes('refresh_token'))
      assert.equal((await api('/account/me', { token: credential.access_token })).status, 401)
      assert.equal((await api('/account/youtube/connection', { token: credential.access_token })).status, 401)
    })
    await t.test('browser consent page and Google state are bound to browser and one use', async () => {
      const page = await api('/api/desktop/connect')
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
      const script = await api('/api/desktop/connect.js')
      assert.doesNotThrow(() => new Function(script.bytes.toString()))
      const pending = await authorize()
      assert.equal(pending.status, 201)
      const next = pending.data
      let cookie
      const response = { cookie(name, value, opts) { cookie = `${name}=${value}`; assert.ok(opts.httpOnly && opts.secure) }, clearCookie() {} }
      const state = await startDesktopGoogle({ query: { desktop_user_code: next.user_code } }, response, db)
      await assert.rejects(consumeDesktopGoogle({ query: { state }, headers: { cookie: 'desktop_oauth=wrong' } }, response, db))
      assert.equal(await consumeDesktopGoogle({ query: { state }, headers: { cookie } }, response, db), next.user_code)
      await assert.rejects(consumeDesktopGoogle({ query: { state }, headers: { cookie } }, response, db))
    })
    await t.test('refused and expired authorizations cannot issue credentials', async () => {
      const denied = (await authorize()).data
      assert.equal((await post('/api/desktop/approve', { user_code: denied.user_code, approve: false }, session1)).status, 200)
      assert.equal((await exchange(denied.device_code)).data.error, 'access_denied')
      const expired = (await authorize()).data
      await query(`UPDATE desktop_authorizations SET expires_at = NOW()-INTERVAL '1 second' WHERE user_code=$1`, [expired.user_code])
      assert.equal((await exchange(expired.device_code)).data.error, 'invalid_grant')
      assert.equal((await post('/api/desktop/approve', { user_code: expired.user_code, approve: true }, session1)).status, 409)
    })
    await t.test('Google desktop callback returns browser session to consent; legacy redirect remains', async () => {
      process.env.GOOGLE_ACCOUNT_CLIENT_ID = 'test-client'
      process.env.GOOGLE_ACCOUNT_CLIENT_SECRET = 'test-secret'
      const pending = (await authorize()).data
      const originalFetch = globalThis.fetch
      let providerCalls = 0
      globalThis.fetch = async (url, opts) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          providerCalls++
          return Response.json({ access_token: 'provider-token-never-sent-to-desktop' })
        }
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
          providerCalls++
          return Response.json({ sub: 'google-first-user', email: 'first@example.com', email_verified: true, name: 'First' })
        }
        return originalFetch(url, opts)
      }
      try {
        const start = await fetch(origin + '/account/google?desktop_user_code=' + pending.user_code, { redirect: 'manual' })
        assert.equal(start.status, 302)
        const state = new URL(start.headers.get('location')).searchParams.get('state')
        assert.match(state, /^desktop_/)
        const cookie = start.headers.get('set-cookie').split(';')[0]
        const callbackUrl = origin + '/account/google/callback?code=test-code&state=' + encodeURIComponent(state)
        const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie } })
        assert.equal(callback.status, 302)
        const destination = new URL(callback.headers.get('location'), origin)
        assert.equal(destination.pathname, '/api/desktop/connect')
        assert.equal(destination.searchParams.get('user_code'), pending.user_code)
        const browserSession = new URLSearchParams(destination.hash.slice(1)).get('session')
        assert.equal((await api('/account/me', { token: browserSession })).data.user.id, 1)
        assert.ok(!destination.toString().includes('provider-token'))
        const replay = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie } })
        assert.ok(!replay.headers.get('location').includes('#session='))
        assert.equal(providerCalls, 2)
        const legacy = await fetch(origin + '/account/google/callback?code=test-code', { redirect: 'manual' })
        assert.match(legacy.headers.get('location'), /^https:\/\/1ce.app\/app#session=/)
      } finally { globalThis.fetch = originalFetch }
    })
    const audio = path.join(bin, 'beat.mp3')
    const image = path.join(bin, 'cover.png')
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'libmp3lame', audio])
    await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-threads', '1', image])
    function form(cover = false, media = audio) {
      const data = new FormData()
      data.append('audio', new Blob([fs.readFileSync(media)], { type: 'audio/mpeg' }), 'beat.mp3')
      if (cover) data.append('cover', new Blob([fs.readFileSync(image)], { type: 'image/png' }), 'cover.png')
      return data
    }
    let desktopRender
    await t.test('MP3 without cover produces black 9:16 MP4 with audio', async () => {
      assert.equal((await api('/api/desktop/upload', { method: 'POST', token: session1, form: form() })).status, 401)
      assert.equal((await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: new FormData() })).status, 400)
      const response = await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: form() })
      assert.equal(response.status, 201, JSON.stringify(response.data))
      assert.equal(response.data.published, false)
      desktopRender = response.data.renderId
      const render = renders.get(desktopRender)
      assert.equal(render.ownerUserId, 1)
      const info = JSON.parse((await run(ffprobe.path, ['-v', 'error', '-show_streams', '-of', 'json', render.path])).stdout)
      assert.ok(info.streams.some(s => s.width === 720 && s.height === 1280 && s.codec_name === 'h264'))
      assert.ok(info.streams.some(s => s.codec_name === 'aac'))
      const pixel = (await run(ffmpeg, ['-i', render.path, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' })).stdout
      assert.ok([...pixel].every(value => value <= 2), `Not black: ${pixel.toString('hex')}`)
      assert.equal((await api(`/api/desktop/renders/${desktopRender}`, { token: credential.access_token })).status, 200)
      const otherToken = '1ce_desktop_' + crypto.randomBytes(32).toString('base64url')
      await query(`INSERT INTO desktop_credentials (id,user_id,token_hash,device_name) VALUES ($1,2,$2,'Other PC')`, [crypto.randomUUID(), sha(otherToken)])
      assert.equal((await api(`/api/desktop/renders/${desktopRender}`, { token: otherToken })).status, 404)
      assert.equal((await api(`/api/desktop/renders/${desktopRender}`, { method: 'DELETE', token: otherToken })).status, 404)
    })
    await t.test('desktop render cannot enter legacy publication, public download or delete routes', async () => {
      for (const route of [`/render/${desktopRender}`, `/render/%${desktopRender.charCodeAt(0).toString(16)}${desktopRender.slice(1)}`,
        `/public-render/${desktopRender}.mp4`, `/public-render/${desktopRender}%2Emp4`,
        `/RENDER/${desktopRender}/`, `/PUBLIC-RENDER/${desktopRender}.MP4`]) {
        assert.equal((await api(route)).status, 404, route)
      }
      for (const route of ['/upload-youtube', '/upload-tiktok', '/publish-telegram', '/publish-discord']) {
        assert.equal((await post(route, { renderId: desktopRender, uploadUrl: 'https://www.googleapis.com/invalid' })).status, 404, route)
      }
      assert.equal((await api(`/render/${desktopRender}`, { method: 'DELETE' })).status, 404)
    })
    await t.test('desktop MP3 is saved privately beyond the temporary render',async()=>{
      const list=await api('/api/desktop/beats',{token:session1})
      assert.equal(list.status,200)
      assert.equal(list.data.beats.length,1)
      const beat=list.data.beats[0]
      assert.equal((await api('/api/desktop/beats')).status,401)
      assert.equal((await api('/api/desktop/beats',{token:session2})).data.beats.length,0)
      assert.equal((await api('/api/desktop/beats/'+beat.id+'/audio',{token:session2})).status,404)
      const download=await api('/api/desktop/beats/'+beat.id+'/audio',{token:session1})
      assert.equal(download.status,200)
      assert.deepEqual(download.bytes,fs.readFileSync(audio))
      const rename=await api('/api/desktop/beats/'+beat.id,{method:'PATCH',token:session1,body:{title:'Saved Friday'}})
      assert.equal(rename.status,200)
      assert.equal((await api('/api/desktop/beats/'+beat.id,{method:'PATCH',token:session2,body:{title:'Stolen'}})).status,404)
      assert.equal((await api('/api/desktop/beats',{token:session1})).data.beats[0].title,'Saved Friday')
    })
    await t.test('cover works; malformed and mislabeled audio rejected without retaining render', async () => {
      const good = await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: form(true) })
      assert.equal(good.status, 201, JSON.stringify(good.data))
      const before = renders.size
      const bad = await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: form(false, image) })
      assert.equal(bad.status, 400)
      assert.equal(renders.size, before)
      const invalid = new FormData()
      invalid.append('audio', new Blob(['not mp3']), 'beat.mp3')
      assert.equal((await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: invalid })).status, 400)
      const unknown = form()
      unknown.append('unexpected', 'field')
      assert.equal((await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: unknown })).status, 400)
    })
    await t.test('embedded MP3 artwork cannot replace the black background', async () => {
      const largeImage = path.join(bin, 'large-cover.png')
      const taggedAudio = path.join(bin, 'tagged.mp3')
      await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=1600x1600', '-frames:v', '1', '-threads', '1', largeImage])
      await run(ffmpeg, ['-y', '-i', audio, '-i', largeImage, '-map', '0:a', '-map', '1:v',
        '-c:a', 'copy', '-c:v', 'png', '-disposition:v', 'attached_pic', '-id3v2_version', '3', taggedAudio])
      const response = await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: form(false, taggedAudio) })
      assert.equal(response.status, 201)
      const pixel = (await run(ffmpeg, ['-i', renders.get(response.data.renderId).path,
        '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' })).stdout
      assert.ok([...pixel].every(value => value <= 2))
    })
    await t.test('legacy /render and /prepare-video still return MP4 and render header', async () => {
      assert.equal((await api('/render', { method: 'POST', form: form() })).status, 400)
      const rendered = await api('/render', { method: 'POST', form: form(true) })
      assert.equal(rendered.status, 200)
      assert.match(rendered.headers.get('content-type'), /video\/mp4/)
      const legacyId = rendered.headers.get('x-render-id')
      assert.equal((await api(`/render/${legacyId}`)).status, 200)
      assert.equal((await api(`/public-render/${legacyId}.mp4`)).status, 200)
      for (const replaceAudio of [false, true]) {
        const data = new FormData()
        data.append('video', new Blob([rendered.bytes], { type: 'video/mp4' }), 'video.mp4')
        if (replaceAudio) data.append('audio', new Blob([fs.readFileSync(audio)]), 'beat.mp3')
        const prepared = await api('/prepare-video', { method: 'POST', form: data })
        assert.equal(prepared.status, 200, prepared.data.toString())
        assert.ok(prepared.headers.get('x-render-id'))
      }
      assert.equal((await api(`/render/${legacyId}`, { method: 'DELETE' })).status, 200)
    })
    await t.test('five-platform publication requires account consent, stays private and runs once', async () => {
      process.env.ONECE_INTERNAL_SECRET='internal-test'
      process.env.ONECE_FRONTEND_URL='https://1ce.lol'
      process.env.TELEGRAM_BOT_TOKEN='test-bot'
      process.env.DISCORD_BOT_TOKEN='test-bot'
      for(const provider of ['youtube','tiktok','instagram']) await query(`INSERT INTO ${provider}_connections (user_id,access_token) VALUES (1,'never-exposed-token')`)
      await query(`INSERT INTO telegram_connections (client_id,chat_id,chat_title,user_id) VALUES ('legacy','-123','Studio chat',1)`)
      await query(`INSERT INTO discord_connections (client_id,guild_id,channel_id,guild_name,channel_name,user_id) VALUES ('legacy','123','456','Studio','Beats',1)`)
      const longAudio=path.join(bin,'long.mp3')
      await run(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','libmp3lame',longAudio])
      const uploaded=await api('/api/desktop/upload',{method:'POST',token:credential.access_token,form:form(false,longAudio)})
      assert.equal(uploaded.status,201)
      const id=uploaded.data.renderId
      const created=await post('/api/desktop/publication',{renderId:id,title:'Review beat'},credential.access_token)
      assert.equal(created.status,201,JSON.stringify(created.data))
      const ticket=created.data.ticket
      const login=await post('/api/desktop/publication-login',{ticket})
      assert.equal(login.status,200)
      let oauthCookie
      const oauthRes={cookie(name,value){oauthCookie=name+'='+value},clearCookie(){}}
      const oauthState=await startDesktopGoogle({query:{desktop_publication:created.data.requestId}},oauthRes,db)
      assert.equal(await consumeDesktopGoogle({query:{state:oauthState},headers:{cookie:oauthCookie}},oauthRes,db),'publish:'+created.data.requestId)
      assert.ok(new URL(created.data.reviewUrl).hash.includes(ticket))
      assert.equal((await post('/api/desktop/publish-review',{ticket},credential.access_token)).status,401)
      assert.equal((await post('/api/desktop/publish-review',{ticket},session2)).status,404)
      assert.equal((await api(`/api/desktop/platform-render/${id}?grant=${ticket}`)).status,404)
      const originalFetch=globalThis.fetch
      const sends={youtube:0,tiktok:0,instagram:0,telegram:0,discord:0}
      let privateUrl
      globalThis.fetch=async (url,opts)=>{
        const address=String(url)
        if(address==='https://1ce.lol/api/desktop/publish'){
          assert.equal(opts.headers.Authorization,'Bearer '+session1)
          const body=JSON.parse(opts.body)
          if(body.action==='describe')return Response.json({connected:true,name:body.provider+' studio'})
          if(body.action==='init' && body.provider==='youtube')assert.equal(body.privacyStatus,'public','Desktop YouTube uploads must always be public')
          if(body.action==='init')return Response.json(body.provider==='youtube'?{uploadUrl:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test'}:{uploadUrl:'https://open-upload.tiktokapis.com/video/?upload_id=test',publishId:'draft-test'})
          assert.equal(body.provider,'instagram');sends.instagram++;privateUrl=body.videoUrl
          const media=await originalFetch(origin+new URL(privateUrl).pathname+new URL(privateUrl).search)
          assert.equal(media.status,200)
          assert.equal(deleteRender(id),false)
          return Response.json({ok:true,mediaId:'ig-test'})
        }
        if(address.startsWith('https://www.googleapis.com/upload/')){sends.youtube++;return Response.json({id:'yt-test'})}
        if(address.startsWith('https://open-upload.tiktokapis.com/')){sends.tiktok++;return new Response('',{status:201})}
        if(address.startsWith('https://api.telegram.org/')){sends.telegram++;return Response.json({ok:true,result:{message_id:1}})}
        if(address.startsWith('https://discord.com/api/')){sends.discord++;return Response.json({id:'message-test'})}
        if(address==='https://oauth2.googleapis.com/token')return Response.json({access_token:'google-platform-secret'})
        if(address==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'google-first-user',email:'first@example.com',email_verified:true,name:'First'})
        if(address.startsWith(origin))return originalFetch(url,opts)
        throw new Error('Unexpected network request '+address)
      }
      try {
        const google=await fetch(origin+'/account/google?desktop_publication='+created.data.requestId+'&desktop_ui=app',{redirect:'manual'})
        assert.equal(google.status,302)
        const state=new URL(google.headers.get('location')).searchParams.get('state')
        const callback=await fetch(origin+'/account/google/callback?code=test-code&state='+encodeURIComponent(state),{redirect:'manual',headers:{cookie:google.headers.get('set-cookie').split(';')[0]}})
        const returnTo=new URL(callback.headers.get('location'))
        assert.equal(returnTo.origin,'https://1ce.lol');assert.equal(returnTo.pathname,'/app')
        assert.equal(returnTo.searchParams.get('desktopPublication'),created.data.requestId)
        assert.match(returnTo.hash,/#session=/);assert.ok(!returnTo.toString().includes('google-platform-secret'))
        assert.equal((await api('/api/desktop/connections',{token:credential.access_token})).status,401)
        const normalConnections=await api('/api/desktop/connections',{token:session1})
        assert.equal(normalConnections.status,200)
        assert.equal(normalConnections.data.connections.length,5)
        assert.ok(normalConnections.data.connections.every(c=>c.ready && c.reasonCode==='ready'))
        assert.ok(!JSON.stringify(normalConnections.data).includes('access_token'))
        assert.ok((await api('/api/desktop/connections',{token:session2})).data.connections.every(c=>!c.ready && c.reasonCode==='not_connected'))
        const review=await post('/api/desktop/publish-review',{ticket},session1)
        assert.equal(review.status,200,JSON.stringify(review.data))
        assert.equal(review.data.connections.length,5)
        assert.ok(review.data.connections.every(c=>c.ready))
        assert.ok(!JSON.stringify(review.data).includes('never-exposed-token'))
        assert.deepEqual(Object.values(sends),[0,0,0,0,0])
        const metadata={ticket,title:'Confirmed beat',description:'Test',youtubePrivacy:'private',targets:review.data.connections.map(c=>({provider:c.provider,fingerprint:c.fingerprint}))}
        const stale=structuredClone(metadata);stale.targets[0].fingerprint='0'.repeat(64)
        assert.equal((await post('/api/desktop/publish-confirm',stale,session1)).status,409)
        assert.equal((await post('/api/desktop/publish-confirm',metadata,session1)).status,202)
        assert.equal((await post('/api/desktop/publish-confirm',metadata,session1)).status,409)
        let status
        for(let attempt=0;attempt<100;attempt++){
          status=(await api('/api/desktop/publications/'+created.data.requestId,{token:credential.access_token})).data
          if(status.status!=='processing')break
          await new Promise(resolve=>setTimeout(resolve,100))
        }
        assert.equal(status.status,'complete',JSON.stringify(status))
        assert.deepEqual(sends,{youtube:1,tiktok:1,instagram:1,telegram:2,discord:1})
        assert.ok(Object.values(status.results).every(r=>['published','uploaded'].includes(r.state)),JSON.stringify(status))
        assert.ok(status.results.tiktok.message.includes('aplicativo'))
        assert.equal((await api(new URL(privateUrl).pathname+new URL(privateUrl).search)).status,404)
        assert.equal((await api('/api/desktop/publications/'+created.data.requestId,{token:session1})).status,401)
        const script=await api('/api/desktop/publish.js');assert.doesNotThrow(()=>new Function(script.bytes.toString()))
        const cancelled=await post('/api/desktop/publication',{renderId:desktopRender,title:'Cancel me'},credential.access_token)
        assert.equal(cancelled.status,201)
        const cancelTicket=cancelled.data.ticket
        await query(`UPDATE desktop_credentials SET revoked_at=NOW() WHERE id=$1`,[credential.credential_id])
        assert.equal((await post('/api/desktop/publish-review',{ticket:cancelTicket},session1)).status,404)
        await query(`UPDATE desktop_credentials SET revoked_at=NULL WHERE id=$1`,[credential.credential_id])
        assert.equal((await post('/api/desktop/publish-cancel',{ticket:cancelTicket},session1)).status,204)
        assert.equal((await post('/api/desktop/publish-confirm',{...metadata,ticket:cancelTicket},session1)).status,409)
        await query(`UPDATE desktop_publications SET status='processing' WHERE id=$1`,[cancelled.data.requestId])
        assert.equal((await api('/api/desktop/publications/'+cancelled.data.requestId,{token:credential.access_token})).data.status,'uncertain')
        assert.deepEqual(sends,{youtube:1,tiktok:1,instagram:1,telegram:2,discord:1})
      } finally {globalThis.fetch=originalFetch}
    })
    await t.test('bot connections bind account codes, reject forged webhook and disconnect only the owner', async () => {
      assert.equal((await api('/api/desktop/connections/instagram',{method:'DELETE',token:credential.access_token})).status,401)
      assert.equal((await api('/api/desktop/connections/instagram',{method:'DELETE',token:session2})).status,200)
      assert.equal((await query('SELECT * FROM instagram_connections WHERE user_id=1')).rowCount,1)
      assert.equal((await api('/api/desktop/connections/instagram',{method:'DELETE',token:session1})).status,200)
      assert.equal((await query('SELECT * FROM instagram_connections WHERE user_id=1')).rowCount,0)
      assert.equal((await post('/telegram/connect-code',{clientId:'new-client'},session1)).status,503)
      process.env.TELEGRAM_WEBHOOK_SECRET='test-webhook'
      const issued=await post('/telegram/connect-code',{clientId:'new-client'},session1)
      assert.equal(issued.status,200,JSON.stringify(issued.data))
      const code=(await query(`SELECT code FROM telegram_connect_codes WHERE client_id='new-client'`)).rows[0].code
      assert.equal((await query(`SELECT user_id FROM telegram_connect_codes WHERE code=$1`,[code])).rows[0].user_id,1)
      const message={message:{text:'/connect '+code,chat:{id:-555,title:'Owner chat'}}}
      assert.equal((await post('/telegram/webhook',message)).status,401)
      const original=globalThis.fetch
      globalThis.fetch=async(url,opts)=>String(url).startsWith('https://api.telegram.org/')?Response.json({ok:true}):original(url,opts)
      try{
        const linked=await fetch(origin+'/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-telegram-bot-api-secret-token':'test-webhook'},body:JSON.stringify(message)})
        assert.equal(linked.status,200)
        assert.equal((await query(`SELECT user_id FROM telegram_connections WHERE chat_id='-555'`)).rows[0].user_id,1)
      }finally{globalThis.fetch=original}
      assert.equal((await api('/telegram/connect-status?clientId=legacy',{token:session2})).data.connected,false)
      assert.equal((await api('/account/telegram/connection',{method:'DELETE',token:session2})).status,200)
      assert.ok((await query('SELECT * FROM telegram_connections WHERE user_id=1')).rowCount)
      assert.equal((await api('/account/telegram/connection',{method:'DELETE',token:session1})).status,200)
      assert.equal((await query('SELECT * FROM telegram_connections WHERE user_id=1')).rowCount,0)
      const discord=await post('/discord/connect-code',{clientId:'new-discord'},session1)
      assert.equal(discord.status,200)
      assert.equal((await query(`SELECT user_id FROM discord_connect_codes WHERE client_id='new-discord'`)).rows[0].user_id,1)
      assert.equal((await api('/account/discord/connection',{method:'DELETE',token:session1})).status,200)
    })
    await t.test('account-scoped revocation and expiration are enforced immediately', async () => {
      const listing = await api('/api/desktop/credentials', { token: session1 })
      assert.equal(listing.status, 200)
      assert.ok(!JSON.stringify(listing.data).includes('token_hash'))
      assert.equal((await api(`/api/desktop/credentials/${credential.credential_id}`, { method: 'DELETE', token: session2 })).status, 404)
      await query(`UPDATE desktop_credentials SET expires_at = NOW()-INTERVAL '1 second' WHERE id=$1`, [credential.credential_id])
      assert.equal((await api(`/api/desktop/renders/${desktopRender}`, { token: credential.access_token })).status, 401)
      await query(`UPDATE desktop_credentials SET expires_at = NOW()+INTERVAL '1 day' WHERE id=$1`, [credential.credential_id])
      assert.equal((await api(`/api/desktop/credentials/${credential.credential_id}`, { method: 'DELETE', token: session1 })).status, 204)
      assert.equal((await api('/api/desktop/upload', { method: 'POST', token: credential.access_token, form: form() })).status, 401)
    })
  } finally {
    for (const id of renders.keys()) deleteRender(id)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await pg.close()
    // All files here were created by this test under a freshly allocated temp directory.
    assert.ok(path.resolve(bin).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(bin, { recursive: true, force: true })
  }
})
