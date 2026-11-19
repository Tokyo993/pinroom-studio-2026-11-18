let revision=0;
let session={authenticated:false,user:null,signInUrl:'/signin-with-chatgpt?return_to=%2F',signOutUrl:'/signout-with-chatgpt?return_to=%2F'};
const ACCOUNT_CHANGED='Аккаунт изменился. Откройте профиль, чтобы загрузить актуальные коллекции.';
function expireSession(message){
  session={...session,authenticated:false,user:null};revision=0;
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('auth-expired',{detail:{message}}));
}
async function request(path,options={},expectedAccount=null){
  let response;
  const headers=new Headers(options.headers);
  if(expectedAccount!==null)headers.set('X-PinStudio-Account',expectedAccount);
  try{response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,headers});}
  catch{throw new Error('Не удалось связаться с сервером. Проверьте подключение.');}
  const body=await response.json().catch(()=>({}));
  if(!response.ok){
    const changed=body.code==='account_changed';
    if(response.status===401||changed)expireSession(changed?ACCOUNT_CHANGED:'Сессия завершена. Войдите снова.');
    const messages={401:'Войдите в аккаунт, чтобы сохранить коллекцию.',409:'Коллекция изменилась в другой вкладке. Обновите коллекции в профиле и повторите действие.',413:'Изображение или коллекция превышает допустимый размер.'};
    const error=new Error(changed?ACCOUNT_CHANGED:messages[response.status]||body.error||body.message||'Не удалось выполнить запрос. Попробуйте ещё раз.');error.status=response.status;throw error;
  }
  if(expectedAccount!==null&&session.user?.id!==expectedAccount){expireSession(ACCOUNT_CHANGED);throw new Error(ACCOUNT_CHANGED);}
  return body;
}
export async function getSession(){session=await request('/api/session');return session;}
export async function readLibrary(){
  if(!session.authenticated)return {boards:[],pins:{}};
  const expectedAccount=session.user.id;
  const result=await request('/api/library',{},expectedAccount);revision=result.revision;return result.library;
}
function imageBlob(data){
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if(!match)throw new Error('Некорректное изображение.');
  const binary=atob(match[2]);if(binary.length>10*1024*1024)throw new Error('Изображение для сохранения должно быть меньше 10 МБ. Скачайте результат в PNG.');
  return new Blob([Uint8Array.from(binary,c=>c.charCodeAt(0))],{type:match[1]});
}
export async function writeLibrary(value){
  if(!session.authenticated)throw new Error('Войдите в аккаунт, чтобы сохранить коллекцию.');
  const expectedAccount=session.user.id,expectedRevision=revision;
  const next=structuredClone(value);
  for(const pin of Object.values(next.pins)){
    pin.title=String(pin.title||'Без названия').slice(0,240);
    if(pin.local&&String(pin.image).startsWith('data:')){
      const blob=imageBlob(pin.image);
      const asset=await request('/api/assets',{method:'POST',headers:{'Content-Type':blob.type},body:blob},expectedAccount);
      pin.image=asset.image;pin.local=true;
    }
  }
  const result=await request('/api/library',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({library:next,revision:expectedRevision})},expectedAccount);
  revision=result.revision;return result.library||next;
}
export async function readLegacyLibrary(){
  if(typeof indexedDB==='undefined')return null;
  if(indexedDB.databases){const dbs=await indexedDB.databases();if(!dbs.some(d=>d.name==='pinroom-local-v1'))return null;}
  return new Promise((resolve,reject)=>{
    const open=indexedDB.open('pinroom-local-v1',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('library');
    open.onerror=()=>reject(new Error('Не удалось прочитать старые локальные коллекции.'));
    open.onsuccess=()=>{const db=open.result;if(!db.objectStoreNames.contains('library')){db.close();resolve(null);return;}const tx=db.transaction('library');const req=tx.objectStore('library').get('state');req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close();};
  });
}
export async function clearLegacyLibrary(){
  return new Promise((resolve,reject)=>{const open=indexedDB.open('pinroom-local-v1',1);open.onsuccess=()=>{const db=open.result;if(!db.objectStoreNames.contains('library')){db.close();resolve();return;}const tx=db.transaction('library','readwrite');tx.objectStore('library').delete('state');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(new Error('Импорт завершён, но локальную копию не удалось удалить.'));};};open.onerror=()=>reject(open.error);});
}
export function boardName(value){
  const name=String(value??'').trim().replace(/\s+/g,' ');
  if(!name||name.length>60)throw new Error('Название доски должно содержать от 1 до 60 символов.');
  return name;
}
export function addToBoard(library,boardId,pin){
  const next=structuredClone(library);
  const board=next.boards.find(b=>b.id===boardId);
  if(!board)throw new Error('Доска не найдена.');
  if(!pin?.id)throw new Error('Изображение не найдено.');
  if(!board.pins.includes(pin.id))board.pins.unshift(pin.id);
  next.pins[pin.id]=pin;
  return next;
}
export function removeFromBoard(library,boardId,pinId){
  const next=structuredClone(library);
  const board=next.boards.find(b=>b.id===boardId);
  if(!board)throw new Error('Доска не найдена.');
  board.pins=board.pins.filter(id=>id!==pinId);
  if(!next.boards.some(b=>b.pins.includes(pinId)))delete next.pins[pinId];
  return next;
}
