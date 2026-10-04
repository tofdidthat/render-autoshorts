export const publicationHtml = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Confirmar publicação — 1CE</title><link rel="stylesheet" href="/api/desktop/publish.css">
<main><h1>Confirmar publicação</h1><p>Confira o vídeo, o título, as contas e a visibilidade antes de enviar.</p>
<section id="login"><h2>Entrar na conta 1CE</h2><a id="google">Entrar com Google</a>
<form id="signin"><label>E-mail <input id="email" type="email" autocomplete="username" required></label>
<label>Senha <input id="password" type="password" autocomplete="current-password" required></label><button>Entrar</button></form></section>
<section id="review" hidden><p id="account"></p><video id="preview" controls playsinline></video>
<form id="confirmation"><label>Título <input id="title" maxlength="100" required></label>
<label>Descrição <textarea id="description" maxlength="900" rows="4"></textarea></label>
<h2>Destinos</h2><div id="destinations"></div>
<label>Visibilidade no YouTube <select id="privacy"><option value="private">Privado</option><option value="unlisted">Não listado</option><option value="public">Público</option></select></label>
<p>Instagram: Reel conforme o acesso da conta. Telegram e Discord: capa + MP3 para os membros do chat/canal mostrado.
TikTok: envio à caixa de entrada; você conclui a publicação no aplicativo.</p>
<p>O envio começa somente após confirmar. Se houver erro ou resultado incerto, confira a plataforma antes de repetir.</p>
<button id="publish" type="submit">Confirmar e enviar aos destinos selecionados</button><button id="cancel" type="button">Cancelar</button></form>
</section><div id="results" aria-live="polite"></div><p id="message" role="status"></p></main>
<script src="/api/desktop/publish.js"></script></html>`

export const publicationCss = `body{font:17px system-ui;background:#111;color:#eee;max-width:740px;margin:24px auto;padding:24px}h1{font-size:30px}h2{font-size:21px}label{display:block;margin:18px 0}input:not([type=checkbox]),textarea,select{display:block;box-sizing:border-box;width:100%;font:inherit;padding:10px;background:#222;color:white;border:1px solid #555;border-radius:6px}button{font:inherit;padding:12px 16px;margin:12px 8px 12px 0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}a{color:#9af}video{max-width:100%;max-height:430px;width:100%;background:black}.destination{background:#222;padding:14px;border-radius:6px;margin:12px 0}.destination label{margin:0}.detail{font-size:14px;color:#bbb;margin:8px 0 0}#message{color:#fda}#results p{padding:12px;background:#222;border-radius:6px}`

export const publicationScript = `
const el=id=>document.getElementById(id);
const fragment=new URLSearchParams(location.hash.slice(1));
let ticket=fragment.get('ticket') || sessionStorage.getItem('onece_publication_ticket');
let session=fragment.get('session');
let requestId=new URLSearchParams(location.search).get('request');
let destinations=[],previewUrl;
if(ticket) sessionStorage.setItem('onece_publication_ticket',ticket);
history.replaceState(null,'',location.pathname+location.search);
async function api(route,body) {
 const response=await fetch('/api/desktop/'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session},body:JSON.stringify({ticket,...body})});
 const data=await response.json().catch(()=>({}));
 if(!response.ok) throw new Error(data.error || 'Não foi possível concluir a solicitação.');
 return data;
}
function error(err){el('message').textContent=err.message;}
function showResults(data) {
 el('results').replaceChildren();
 for(const [provider,result] of Object.entries(data.results || {})) {
   const p=document.createElement('p');p.textContent=provider.toUpperCase()+': '+result.message;
   if(result.url && result.url.startsWith('https://www.youtube.com/watch?v=')) {
     const a=document.createElement('a');a.href=result.url;a.textContent=' Abrir vídeo';a.target='_blank';a.rel='noopener';p.append(a);
   }
   el('results').append(p);
 }
 if(data.status==='complete') {el('message').textContent='Envios concluídos. Confira os resultados de cada destino.';sessionStorage.removeItem('onece_publication_ticket');}
 if(data.status==='uncertain') el('message').textContent='A execução foi interrompida. Confira as plataformas antes de tentar novamente.';
 if(data.status==='cancelled') el('message').textContent='Publicação cancelada.';
}
async function poll(){
 try {const data=await api('publish-review',{});showResults(data);if(data.status==='processing')setTimeout(poll,5000);}
 catch(err){error(err);}
}
async function load(){
 const data=await api('publish-review',{});requestId=data.requestId;
 el('login').hidden=true;el('account').textContent='Conta 1CE: '+data.account.email;
 el('google').href='/account/google?desktop_publication='+encodeURIComponent(requestId);
 if(data.status!=='pending'){el('review').hidden=true;showResults(data);if(data.status==='processing')setTimeout(poll,5000);return;}
 el('review').hidden=false;el('title').value=data.title;destinations=data.connections;
 el('destinations').replaceChildren();
 for(const destination of destinations){
   const box=document.createElement('div');box.className='destination';
   const label=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';
   checkbox.dataset.provider=destination.provider;checkbox.checked=destination.ready;checkbox.disabled=!destination.ready;
   label.append(checkbox,document.createTextNode(' '+destination.provider.toUpperCase()+' — '+(destination.name || 'Não disponível')));
   const detail=document.createElement('p');detail.className='detail';detail.textContent=destination.ready?destination.visibility:destination.reason;
   box.append(label,detail);
   if(destination.note){const note=document.createElement('p');note.className='detail';note.textContent=destination.note;box.append(note);}
   el('destinations').append(box);
 }
 const preview=await fetch('/api/desktop/publish-preview',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session},body:JSON.stringify({ticket})});
 if(preview.ok){previewUrl=URL.createObjectURL(await preview.blob());el('preview').src=previewUrl;}
}
el('signin').onsubmit=async event=>{
 event.preventDefault();
 try {const response=await fetch('/account/email/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:el('email').value,password:el('password').value})});
 const data=await response.json();if(!response.ok)throw new Error('Não foi possível entrar na conta 1CE.');session=data.session;el('password').value='';await load();}catch(err){error(err);}
};
el('confirmation').onsubmit=async event=>{
 event.preventDefault();
 const selected=[...el('destinations').querySelectorAll('input:checked')].map(input=>destinations.find(d=>d.provider===input.dataset.provider));
 if(!selected.length){error(new Error('Selecione pelo menos um destino disponível.'));return;}
 el('publish').disabled=true;el('cancel').disabled=true;
 try {await api('publish-confirm',{title:el('title').value,description:el('description').value,youtubePrivacy:el('privacy').value,targets:selected.map(d=>({provider:d.provider,fingerprint:d.fingerprint}))});
 el('confirmation').hidden=true;el('message').textContent='Envios em andamento. Você pode acompanhar nesta página.';poll();}
 catch(err){error(err);el('publish').disabled=false;el('cancel').disabled=false;}
};
el('cancel').onclick=async()=>{try{await api('publish-cancel',{});el('confirmation').hidden=true;el('message').textContent='Cancelado. Nenhuma publicação foi iniciada.';sessionStorage.removeItem('onece_publication_ticket');}catch(err){error(err);}};
window.addEventListener('beforeunload',()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);});
if(!ticket){error(new Error('Abra esta página pelo Upload 1ce no seu computador.'));el('login').hidden=true;}
else if(session) load().catch(error);
else if(requestId) el('google').href='/account/google?desktop_publication='+encodeURIComponent(requestId);
else {
 fetch('/api/desktop/publication-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})})
 .then(async response=>{const data=await response.json();if(!response.ok)throw new Error('Solicitação expirada. Tente Upload 1ce novamente.');requestId=data.requestId;el('google').href='/account/google?desktop_publication='+encodeURIComponent(requestId);})
 .catch(error);
}
`
