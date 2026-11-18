const DB_NAME='pinroom-local-v1';
let db;
export async function openStore(){
  if(db)return db;
  db=await new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>r.result.createObjectStore('library');
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(new Error('Браузер не разрешил доступ к хранилищу. Проверьте режим приватности.'));
  });
  return db;
}
export async function readLibrary(){
  const d=await openStore();
  const value=await new Promise((resolve,reject)=>{
    const req=d.transaction('library').objectStore('library').get('state');
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  return value||{boards:[{id:'inspiration',name:'Моё вдохновение',pins:[],createdAt:Date.now()}],pins:{}};
}
export async function writeLibrary(value){
  const d=await openStore();
  return new Promise((resolve,reject)=>{
    const tx=d.transaction('library','readwrite');
    tx.objectStore('library').put(value,'state');
    tx.oncomplete=resolve;
    tx.onabort=tx.onerror=()=>reject(new Error('Не удалось сохранить. Возможно, память браузера заполнена. Экспортируйте изображение в PNG.'));
  });
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
