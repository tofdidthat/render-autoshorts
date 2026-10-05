import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {validateStemsZip} from '../stems-zip.js'
import {zipFixture,wav} from './stems-fixtures.js'
test('stems ZIP validates WAVs, integrity and archive paths without extraction',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'1ce-zip-')),file=path.join(dir,'stems.zip')
 const check=async bytes=>{await fs.writeFile(file,bytes);return validateStemsZip({path:file})}
 try{
  const valid=zipFixture([['stems - Friday/Kick.wav',wav()],['stems - Friday/Bass.wav',wav()]])
  assert.equal((await check(valid)).wavs,2)
  for(const bytes of [Buffer.from('not zip'),zipFixture([]),zipFixture([['../Kick.wav',wav()]]),zipFixture([['tool.exe',wav()]]),zipFixture([['Kick.wav',Buffer.alloc(128)]]),zipFixture([['Kick.wav',wav()],['Kick.wav',wav()]])])await assert.rejects(check(bytes))
  const damaged=Buffer.from(valid),central=damaged.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));damaged.writeUInt32LE(123,central+16)
  await assert.rejects(check(damaged),/damaged/)
  const oversized=Buffer.from(valid);oversized.writeUInt32LE(0x90000000,central+24)
  await assert.rejects(check(oversized),/2 GB/)
 }finally{await fs.rm(file,{force:true});await fs.rmdir(dir)}
})
