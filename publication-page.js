export const publicationHtml = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Upload 1ce</title><link rel="stylesheet" href="/api/desktop/publish.css"><main><h1>Upload 1ce</h1><p id="message" role="status">Abrindo seu upload na 1CE…</p><section id="login" hidden></section></main><script src="/api/desktop/publish.js"></script></html>`

export const publicationCss = `body{font:17px system-ui;background:#111;color:#eee;max-width:740px;margin:24px auto;padding:24px}h1{font-size:30px}h2{font-size:21px}label{display:block;margin:18px 0}input:not([type=checkbox]),textarea,select{display:block;box-sizing:border-box;width:100%;font:inherit;padding:10px;background:#222;color:white;border:1px solid #555;border-radius:6px}button{font:inherit;padding:12px 16px;margin:12px 8px 12px 0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}a{color:#9af}video{max-width:100%;max-height:430px;width:100%;background:black}.destination{background:#222;padding:14px;border-radius:6px;margin:12px 0}.destination label{margin:0}.detail{font-size:14px;color:#bbb;margin:8px 0 0}#message{color:#fda}#results p{padding:12px;background:#222;border-radius:6px}`

export function publicationRedirectScript(origin) {
 return `
 (async()=>{
  const fragment=new URLSearchParams(location.hash.slice(1));
  const ticket=fragment.get('ticket') || sessionStorage.getItem('onece_publication_ticket');
  const session=fragment.get('session');
  history.replaceState(null,'',location.pathname+location.search);
  const message=document.getElementById('message');
  document.getElementById('login').hidden=true;
  if(!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)){message.textContent='Abra esta página pelo Upload 1ce no seu computador.';return;}
  message.textContent='Abrindo seu upload na 1CE…';
  try{
   let id=new URLSearchParams(location.search).get('request');
   if(!id){const response=await fetch('/api/desktop/publication-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});
    const data=await response.json();if(!response.ok)throw Error('Solicitação expirada. Tente Upload 1ce novamente.');id=data.requestId;}
   const destination=new URL('/app',${JSON.stringify(origin)});destination.searchParams.set('desktopPublication',id);
   const hash=new URLSearchParams({ticket});if(session)hash.set('session',session);destination.hash=hash.toString();
   sessionStorage.removeItem('onece_publication_ticket');location.replace(destination.toString());
  }catch(error){message.textContent=error.message;}
 })();
 `
}
