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

const run = promisify(execFile)
const sha = value => crypto.createHash('sha256').update(value).digest('hex')

test('review cover integration',async t=>{
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

    await setupDatabase()
    await query("INSERT INTO account_users(email,name,email_verified) VALUES('first@example.com','First',TRUE),('second@example.com','Second',TRUE)")
    const session1=crypto.randomBytes(32).toString('hex'),session2=crypto.randomBytes(32).toString('hex')
    await query("INSERT INTO account_sessions(user_id,token_hash,expires_at) VALUES(1,$1,NOW()+INTERVAL '1 day'),(2,$2,NOW()+INTERVAL '1 day')",[sha(session1),sha(session2)])
    const credential={access_token:'1ce_desktop_'+crypto.randomBytes(32).toString('base64url')}
    await query("INSERT INTO desktop_credentials(id,user_id,token_hash,device_name) VALUES($1,1,$2,'Cover test')",[crypto.randomUUID(),sha(credential.access_token)])
    const audio=path.join(bin,'beat.mp3'),image=path.join(bin,'cover.png')
    await run(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=0.5','-c:a','libmp3lame',audio])
    await run(ffmpeg,['-y','-f','lavfi','-i','color=c=red:s=64x64','-frames:v','1','-threads','1',image])
    const form=()=>{const data=new FormData();data.append('audio',new Blob([fs.readFileSync(audio)]),'beat.mp3');return data}
    await t.test('pending review adds a cover privately, preserves audio and rejects invalid or locked changes', async () => {
      const uploaded=await api('/api/desktop/upload',{method:'POST',token:credential.access_token,form:form()})
      const id=uploaded.data.renderId
      const created=await post('/api/desktop/publication',{renderId:id,title:'Choose cover'},credential.access_token)
      const ticket=created.data.ticket
      const coverForm=(valid=true)=>{const data=new FormData();data.append('ticket',ticket);data.append('cover',new Blob([valid?fs.readFileSync(image):Buffer.from('invalid')],{type:'image/png'}),'cover.png');return data}
      const original=renders.get(id).path
      const before=(await run(ffmpeg,['-i',original,'-map','0:a:0','-c:a','copy','-f','adts','pipe:1'],{encoding:'buffer'})).stdout
      assert.equal((await post('/api/desktop/publish-review',{ticket},session1)).data.canChooseCover,true)
      assert.equal((await api('/api/desktop/publish-cover',{method:'POST',token:session2,form:coverForm()})).status,404)
      assert.equal((await api('/api/desktop/publish-cover',{method:'POST',token:credential.access_token,form:coverForm()})).status,401)
      assert.equal((await api('/api/desktop/publish-cover',{method:'POST',token:session1,form:coverForm(false)})).status,400)
      assert.equal(renders.get(id).path,original)
      renders.get(id).reviewConfirming=true
      assert.equal((await api('/api/desktop/publish-cover',{method:'POST',token:session1,form:coverForm()})).status,409)
      delete renders.get(id).reviewConfirming
      const result=await api('/api/desktop/publish-cover',{method:'POST',token:session1,form:coverForm()})
      assert.equal(result.status,200,JSON.stringify(result.data))
      const updated=renders.get(id)
      assert.equal(updated.hasCover,true);assert.equal(updated.reviewEditing,undefined)
      assert.equal(fs.existsSync(original),false)
      const after=(await run(ffmpeg,['-i',updated.path,'-map','0:a:0','-c:a','copy','-f','adts','pipe:1'],{encoding:'buffer'})).stdout
      assert.deepEqual(after,before)
      const pixel=(await run(ffmpeg,['-i',updated.path,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'})).stdout
      assert.ok(pixel[0]>200 && pixel[1]<20 && pixel[2]<20)
      assert.equal((await post('/api/desktop/publish-review',{ticket},session1)).data.hasCover,true)
      await query("UPDATE desktop_publications SET status='cancelled' WHERE id=$1",[created.data.requestId])
      assert.equal((await api('/api/desktop/publish-cover',{method:'POST',token:session1,form:coverForm()})).status,409)
      assert.equal(deleteRender(id),true)
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

