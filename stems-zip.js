import fs from 'node:fs'
import zlib from 'node:zlib'
import yauzl from 'yauzl'
const maxZip=500*1024*1024
const maxExpanded=2*1024*1024*1024
export async function validateStemsZip(file){
 const size=fs.statSync(file.path).size
 if(!size || size>maxZip)throw Error('Stems ZIP must be between 1 byte and 500 MB.')
 const zip=await yauzl.openPromise(file.path,{lazyEntries:true,autoClose:false,validateEntrySizes:true})
 let count=0,total=0,wavs=0
 const names=new Set(),deadline=Date.now()+120000
 try{
  for await(const entry of zip.eachEntry()){
   if(++count>2048 || Date.now()>deadline)throw Error('Stems archive exceeds validation limits.')
   if(entry.generalPurposeBitFlag&1)throw Error('Encrypted stems archives are not supported.')
   const mode=(entry.externalFileAttributes>>>16)&0xf000
   if(mode===0xa000)throw Error('Links are not allowed in stems archives.')
   if(names.has(entry.fileName))throw Error('Duplicate stems archive entry.')
   names.add(entry.fileName)
   total+=entry.uncompressedSize
   if(!Number.isSafeInteger(total) || total>maxExpanded)throw Error('Stems archive exceeds 2 GB of uncompressed audio.')
   if(entry.fileName.endsWith('/'))continue
   if(!/\.wav$/i.test(entry.fileName) || entry.uncompressedSize<=44)throw Error('Stems ZIP must contain WAV audio only.')
   const stream=await zip.openReadStreamPromise(entry)
   let header=Buffer.alloc(0),checksum=0
   for await(const chunk of stream){
    if(Date.now()>deadline){stream.destroy();throw Error('Stems validation timed out.')}
    if(header.length<12)header=Buffer.concat([header,chunk.subarray(0,12-header.length)])
    checksum=zlib.crc32(chunk,checksum)
   }
   if(checksum!==entry.crc32 || !['RIFF','RF64'].includes(header.subarray(0,4).toString()) || header.subarray(8,12).toString()!=='WAVE')throw Error('Invalid or damaged WAV in stems ZIP.')
   wavs++
  }
  if(!wavs)throw Error('Stems ZIP contains no WAV audio.')
  return {size,wavs}
 }finally{zip.close()}
}
