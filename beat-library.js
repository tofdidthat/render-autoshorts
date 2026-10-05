import crypto from 'node:crypto'
import fs from 'node:fs'
const chunkSize=1024*1024
export async function setupBeatLibrary(db){
 await db.query(`CREATE TABLE IF NOT EXISTS account_beats(id UUID PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,title TEXT NOT NULL,audio_hash TEXT NOT NULL,audio_size INTEGER NOT NULL,duration DOUBLE PRECISION,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,audio_hash))`)
 await db.query(`CREATE TABLE IF NOT EXISTS account_beat_audio(beat_id UUID NOT NULL REFERENCES account_beats(id) ON DELETE CASCADE,chunk_index INTEGER NOT NULL,data BYTEA NOT NULL,PRIMARY KEY(beat_id,chunk_index))`)
 await db.query('CREATE INDEX IF NOT EXISTS account_beats_user_date_idx ON account_beats(user_id,created_at DESC)')
}
export async function saveDesktopBeat(db,userId,file,duration){
 const digest=crypto.createHash('sha256')
 for await(const chunk of fs.createReadStream(file.path))digest.update(chunk)
 const audioHash=digest.digest('hex')
 const title=String(file.originalname || 'Untitled beat').split(/[\\/]/).pop().replace(/\.mp3$/i,'').trim().slice(0,100) || 'Untitled beat'
 const client=await db.connect()
 try{
  await client.query('BEGIN')
  const row=await client.query(`INSERT INTO account_beats(id,user_id,title,audio_hash,audio_size,duration) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,audio_hash) DO NOTHING RETURNING id,title,created_at,duration`,[crypto.randomUUID(),userId,title,audioHash,fs.statSync(file.path).size,Number.isFinite(Number(duration))?Number(duration):null])
  if(row.rowCount){let index=0;for await(const chunk of fs.createReadStream(file.path,{highWaterMark:chunkSize}))await client.query('INSERT INTO account_beat_audio(beat_id,chunk_index,data) VALUES($1,$2,$3)',[row.rows[0].id,index++,chunk])}
  else {const existing=await client.query('SELECT id,title,created_at,duration FROM account_beats WHERE user_id=$1 AND audio_hash=$2',[userId,audioHash]);row.rows=existing.rows}
  await client.query('COMMIT');return row.rows[0]
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
export function audioRange(header,size){
 if(!header)return {start:0,end:size-1,partial:false}
 const match=/^bytes=(\d*)-(\d*)$/.exec(header)
 if(!match || (!match[1] && !match[2]))return null
 const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]))
 const end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1
 return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start?{start,end,partial:true}:null
}
export function registerBeatLibrary(router,{db,account}){
 router.get('/beats',account,async(req,res,next)=>{try{const result=await db.query('SELECT id,title,created_at,duration,audio_size FROM account_beats WHERE user_id=$1 ORDER BY created_at DESC,id',[req.account.id]);res.json({beats:result.rows})}catch(error){next(error)}})
 router.patch('/beats/:id',account,async(req,res,next)=>{
  try{
   if(!/^[a-f0-9-]{36}$/i.test(req.params.id))return res.sendStatus(404)
   const title=typeof req.body?.title==='string'?req.body.title.trim():''
   if(!title || title.length>100)return res.status(400).json({error:'A title between 1 and 100 characters is required.'})
   const result=await db.query('UPDATE account_beats SET title=$1 WHERE id=$2 AND user_id=$3 RETURNING id,title,created_at,duration',[title,req.params.id,req.account.id])
   if(!result.rowCount)return res.sendStatus(404)
   res.json({beat:result.rows[0]})
  }catch(error){next(error)}
 })
 router.get('/beats/:id/audio',account,async(req,res,next)=>{
  try{
   if(!/^[a-f0-9-]{36}$/i.test(req.params.id))return res.sendStatus(404)
   const result=await db.query('SELECT audio_size FROM account_beats WHERE id=$1 AND user_id=$2',[req.params.id,req.account.id])
   if(!result.rowCount)return res.sendStatus(404)
   const size=result.rows[0].audio_size,range=audioRange(req.headers.range,size)
   res.setHeader('Accept-Ranges','bytes')
   if(!range){res.setHeader('Content-Range','bytes */'+size);return res.sendStatus(416)}
   const {start,end,partial}=range
   res.status(partial?206:200);res.setHeader('Content-Type','audio/mpeg');res.setHeader('Content-Length',end-start+1)
   if(partial)res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`)
   for(let index=Math.floor(start/chunkSize);index<=Math.floor(end/chunkSize);index++){
    if(res.destroyed)return
    const chunk=await db.query('SELECT data FROM account_beat_audio WHERE beat_id=$1 AND chunk_index=$2',[req.params.id,index])
    if(!chunk.rowCount)throw Error('Missing audio chunk')
    const bytes=Buffer.from(chunk.rows[0].data),offset=index*chunkSize
    if(!res.write(bytes.subarray(Math.max(0,start-offset),Math.min(bytes.length,end-offset+1))))await new Promise(resolve=>{
     const done=()=>{res.off('drain',done);res.off('close',done);resolve()}
     res.once('drain',done);res.once('close',done)
    })
   }
   res.end()
  }catch(error){if(res.headersSent)res.destroy(error);else next(error)}
 })
}
