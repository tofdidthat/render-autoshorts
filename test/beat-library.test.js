import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import {PGlite} from '@electric-sql/pglite'
import {setupBeatLibrary,saveDesktopBeat,registerBeatLibrary,audioRange} from '../beat-library.js'
test('durable audio: ownership, deduplication, ranges and rollback',async()=>{
 const pg=new PGlite()
 const query=async(sql,params)=>{const result=await pg.query(sql,params);return {...result,rowCount:result.affectedRows || result.rows.length}}
 const db={query,connect:async()=>({query,release(){}})}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'1ce-beats-')),file=path.join(dir,'beat.mp3')
 const bytes=Buffer.alloc(2*1024*1024+123);for(let n=0;n<bytes.length;n++)bytes[n]=n%251
 let server
 try{
  await query('CREATE TABLE account_users(id INTEGER PRIMARY KEY)')
  await query('INSERT INTO account_users VALUES(1),(2)')
  await setupBeatLibrary(db)
  await fs.writeFile(file,bytes)
  const beat=await saveDesktopBeat(db,1,{path:file,originalname:'Friday.mp3'},120)
  assert.equal(beat.title,'Friday')
  assert.equal((await saveDesktopBeat(db,1,{path:file,originalname:'Again.mp3'},120)).id,beat.id)
  assert.notEqual((await saveDesktopBeat(db,2,{path:file,originalname:'Friday.mp3'},120)).id,beat.id)
  await fs.unlink(file)
  const app=express();app.use(express.json())
  registerBeatLibrary(app,{db,account:(req,res,next)=>{const id=Number(req.headers.authorization);if(![1,2].includes(id))return res.sendStatus(401);req.account={id};next()}})
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  const get=(route,owner=1,range)=>fetch(origin+route,{headers:{Authorization:String(owner),...(range?{Range:range}:{})}})
  assert.equal((await get('/beats',0)).status,401)
  assert.equal((await (await get('/beats')).json()).beats.length,1)
  assert.equal((await get('/beats/'+beat.id+'/audio',2)).status,404)
  const full=await get('/beats/'+beat.id+'/audio')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes)
  for(const range of ['bytes=1048570-1048580','bytes=-123','bytes=2097152-']){
   const result=await get('/beats/'+beat.id+'/audio',1,range),expected=audioRange(range,bytes.length)
   assert.equal(result.status,206);assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes.subarray(expected.start,expected.end+1))
  }
  assert.equal((await get('/beats/'+beat.id+'/audio',1,'bytes=999999999-')).status,416)
  assert.equal(audioRange('bytes=-0',bytes.length),null)
  await fs.writeFile(file,Buffer.from('different'))
  const failing={...db,connect:async()=>({release(){},query:async(sql,params)=>{if(sql.startsWith('INSERT INTO account_beat_audio'))throw Error('disk failure');return query(sql,params)}})}
  await assert.rejects(saveDesktopBeat(failing,1,{path:file,originalname:'Fail.mp3'},1),/disk failure/)
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_beats WHERE user_id=1')).rows[0].count,1)
  await query('INSERT INTO account_beat_stems(beat_id,chunk_index,data) VALUES($1,0,$2)',[beat.id,Buffer.from('private ZIP')])
  const remove=owner=>fetch(origin+'/beats/'+beat.id,{method:'DELETE',headers:{Authorization:String(owner)}})
  assert.equal((await remove(0)).status,401)
  assert.equal((await remove(2)).status,404)
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM account_beat_audio WHERE beat_id=$1',[beat.id])).rows[0].count,3)
  assert.equal((await remove(1)).status,204)
  for(const table of ['account_beat_audio','account_beat_stems'])assert.equal((await query('SELECT COUNT(*)::int AS count FROM '+table+' WHERE beat_id=$1',[beat.id])).rows[0].count,0)
  assert.equal((await get('/beats/'+beat.id+'/audio')).status,404)
  assert.equal((await remove(1)).status,404)
  assert.equal((await (await get('/beats',2)).json()).beats.length,1)
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve))
  await pg.close();await fs.rm(file,{force:true});await fs.rmdir(dir)
 }
})

