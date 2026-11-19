import {searchPins,safeImageUrl,safeSourceUrl} from './api.js';
import {readLibrary,writeLibrary,getSession,readLegacyLibrary,clearLegacyLibrary,boardName,addToBoard,removeFromBoard} from './storage.js';
import {initialEdit,sanitizeEdit,cropRect,outputSize,canvasFilter,createHistory} from './editor-core.js';
import {icon} from './icons.js';

const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const categories=[['Для вас','incategory:"Featured pictures on Wikimedia Commons" landscape'],['Природа','incategory:"Featured pictures on Wikimedia Commons" mountains'],['Архитектура','incategory:"Featured pictures on Wikimedia Commons" architecture'],['Интерьеры','interior design'],['Цветы','incategory:"Featured pictures on Wikimedia Commons" flowers'],['Путешествия','incategory:"Featured pictures on Wikimedia Commons" Italy'],['Искусство','abstract painting']];
let accountSession={authenticated:false,user:null};
let library={boards:[],pins:{}},storageError='',feed=[],query=categories[0][1],category='Для вас',nextOffset=null,loading=false,feedError='',request=null,viewToken=0;
let editor=null,editTab='crop',pendingPin=null,toastTimer,saveBusy=false,searchOpen=false;
const transient=new Map();
const drafts=new Map();
const allPins=()=>new Map([...feed.map(p=>[p.id,p]),...Object.entries(library.pins),...transient]);
const findPin=id=>allPins().get(id);
const isSaved=id=>library.boards.some(b=>b.pins.includes(id));
const imageUrl=p=>p?.local&&(/^data:image\/(png|jpeg|webp);base64,/.test(p.image)||/^\/api\/assets\/[a-f0-9-]{36}$/.test(p.image))?p.image:safeImageUrl(p?.image);
const route=()=>location.hash.slice(1)||'/';
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4000);}
function setTitle(text){document.title=`${text} · PinStudio`;}
function nav(){const page=route().split('/')[1]||'feed';document.body.dataset.page=page;document.body.classList.toggle('search-mode',searchOpen&&page==='feed');const active=page.startsWith('board')?'boards':searchOpen?'search':'feed';document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===active));}
function empty(title,description,action=''){return `<section class="empty"><span class="empty-icon">✧</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</section>`;}
function card(pin,boardId=''){
  return `<article class="pin-card"><div class="pin-picture"><a href="#/pin/${encodeURIComponent(pin.id)}" aria-label="Открыть: ${esc(pin.title)}"><img src="${esc(imageUrl(pin))}" alt="${esc(pin.title)}" loading="lazy" style="aspect-ratio:${Math.min(1,Math.max(.6,pin.width/pin.height))}" data-pin-image></a><button class="pin-save ${isSaved(pin.id)?'saved':''}" data-action="save" data-id="${esc(pin.id)}" aria-pressed="${isSaved(pin.id)}" aria-label="Сохранить: ${esc(pin.title)}">${icon('bookmark')}</button><a class="pin-edit" href="#/edit/${encodeURIComponent(pin.id)}">${icon('edit')} Редактировать</a>${pin.edited?'<span class="edit-tag">ВАША ВЕРСИЯ</span>':''}</div><a class="pin-caption" href="#/pin/${encodeURIComponent(pin.id)}"><h3>${esc(pin.title)}</h3></a>${boardId?`<button class="remove-pin" data-action="remove" data-id="${esc(pin.id)}" data-board="${esc(boardId)}" aria-label="Убрать ${esc(pin.title)} из коллекции">Убрать</button>`:''}</article>`;
}
function feedMarkup(){
  const heading=category==='Поиск'?`Результаты: ${esc(query)}`:'Вдохновение начинается здесь';
  return `<section class="intro ${category==='Поиск'?'search-intro':''}"><div><h1>${heading}</h1><p>Находи идеи. Собирай коллекции. Создавай своё.</p></div><button class="studio-promo" data-action="upload">${icon('edit')} Открыть фотостудию</button></section><section class="feed-tools" aria-label="Категории"><div class="chips">${categories.map(([label,q])=>`<button class="chip ${category===label?'active':''}" data-action="category" data-query="${esc(q)}" data-label="${label}">${label}</button>`).join('')}</div><span class="feed-caption">Избранное из Wikimedia Commons</span></section><div id="feed-results">${feedResults()}</div>`;
}
function feedResults(){
  if(loading&&!feed.length)return `<div class="loading-grid" aria-label="Загружаем изображения" role="status">${Array.from({length:15},()=>'<div class="skeleton"></div>').join('')}</div>`;
  const error=feedError?`<div class="error-banner" role="alert">${esc(feedError)} <button class="btn secondary" data-action="retry">Повторить</button></div>`:'';
  if(!feed.length&&!loading)return error+empty('Пока ничего не нашлось','Попробуйте более простой запрос — например, mountains, flowers или architecture. Поиск лучше понимает английский.');
  return `${error}<div class="masonry">${feed.map(p=>card(p)).join('')}</div>${nextOffset!==null?`<div class="load-more"><button class="btn ghost" data-action="more" ${loading?'disabled':''}>${loading?'Загружаем…':'Больше вдохновения'}</button></div>`:''}`;
}
async function loadFeed(append=false){
  request?.abort();const controller=new AbortController();request=controller;
  loading=true;feedError='';if(!append)feed=[];
  if(route()==='/' && $('#feed-results'))$('#feed-results').innerHTML=feedResults();
  try{const result=await searchPins(query,{offset:append?nextOffset:0,signal:controller.signal});if(request!==controller)return;const unique=new Map((append?feed:[]).map(p=>[p.id,p]));result.pins.forEach(p=>unique.set(p.id,p));feed=[...unique.values()];nextOffset=result.nextOffset;}
  catch(error){if(error.name!=='AbortError'&&request===controller)feedError=error.message;}
  finally{if(request===controller){loading=false;if(route()==='/' && $('#feed-results'))$('#feed-results').innerHTML=feedResults();}}
}
function renderBoards(){
  setTitle('Коллекции');
  if(!accountSession.authenticated)return empty('Твои личные коллекции','Войди, чтобы сохранять идеи и открывать свои коллекции на других устройствах.',`<button class="btn" data-action="account">${icon('user')} Войти в аккаунт</button>`);
  return `<section class="board-header"><div><h1>Коллекции</h1><p>Твои идеи, собранные вместе.</p></div><button class="icon-button add-board" data-action="new-board" aria-label="Новая коллекция">${icon('plus')}</button></section>${storageError?`<p class="error-banner">${esc(storageError)}</p>`:''}<div class="board-grid">${library.boards.map(b=>{const pins=b.pins.map(id=>library.pins[id]).filter(Boolean).slice(0,3);return `<a class="board-card" href="#/board/${encodeURIComponent(b.id)}"><div class="board-cover ${pins.length?'':'blank'} ${pins.length===1?'single':''}">${pins.length?pins.map(p=>`<img src="${esc(imageUrl(p))}" alt="" loading="lazy">`).join(''):`<span>${icon('collections')}</span>`}</div><div class="board-label"><h3>${esc(b.name)}</h3><span class="collection-dot">${icon('collections')}</span><p>${b.pins.length} пинов</p></div></a>`;}).join('')}<button class="board-card new-collection" data-action="new-board"><span>${icon('plus')}</span><strong>Новая коллекция</strong><small>Собери что-то своё</small></button></div><p class="local-note">${icon('lock')} Коллекции доступны только в вашем аккаунте.</p>`;
}
function renderBoard(id){
  const board=library.boards.find(b=>b.id===id);if(!board)return empty('Коллекция не найдена','Возможно, она была удалена.', '<a class="btn" href="#/boards">К коллекциям</a>');
  setTitle(board.name);
  return `<div class="backline"><a href="#/boards" aria-label="Назад к коллекциям">${icon('back')}</a> Коллекции</div><section class="board-header"><div><h1>${esc(board.name)}</h1><p>${board.pins.length} пинов · личная коллекция</p></div><button class="btn ghost" data-action="rename-board" data-board="${esc(id)}">Переименовать</button></section>${board.pins.length?`<div class="masonry">${board.pins.map(pid=>library.pins[pid]).filter(Boolean).map(p=>card(p,id)).join('')}</div>`:empty('Здесь начнётся твоя коллекция','Сохраните понравившийся пин значком закладки или создайте собственный в студии.','<a href="#/" class="btn">Найти вдохновение</a>')}`;
}
function renderPin(pin){
  setTitle(pin.title);
  return `<div class="backline"><a href="#/" aria-label="К ленте">${icon('back')}</a><span>К ленте</span><button class="icon-button pin-top-save" data-action="save" data-id="${esc(pin.id)}" aria-label="Сохранить пин">${icon('bookmark')}</button></div><article class="detail"><div class="detail-image"><img src="${esc(imageUrl(pin))}" alt="${esc(pin.title)}" data-pin-image></div><div class="detail-content"><div class="credit"><span class="author-dot">${esc((pin.author||'Я')[0])}</span><span>${esc(pin.author)}</span>${safeSourceUrl(pin.source)?`<a class="source-pill" href="${esc(safeSourceUrl(pin.source))}" target="_blank" rel="noopener noreferrer">Источник ${icon('external')}</a>`:''}</div><h1>${esc(pin.title)}</h1><div class="detail-tags"><span>${pin.edited?'Создано в PinStudio':pin.local?'Ваше фото':'Wikimedia Commons'}</span><span>${esc(pin.license||'Личное изображение')}</span></div><p class="detail-description">${pin.edited?'Ваша версия изображения. Оригинал остаётся без изменений.':'Сохрани вдохновение. Добавь свой взгляд.'}</p><section class="editor-invite"><a class="btn" href="#/edit/${encodeURIComponent(pin.id)}">${icon('edit')} Редактировать изображение</a><button class="btn secondary" data-action="save" data-id="${esc(pin.id)}">${icon('bookmark')} ${isSaved(pin.id)?'Сохранено · выбрать коллекцию':'Сохранить в коллекцию'}</button></section></div></article>`;
}
function slider(key,label,min,max,step=1){const value=editor.state[key];return `<div class="control"><label for="edit-${key}">${label}<output id="out-${key}">${value}</output></label><input type="range" id="edit-${key}" data-edit="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;}
function panel(){
  const state=editor.state;let contents='';
  if(editTab==='filters')contents=`<div class="filter-grid">${[['none','Оригинал'],['warm','Тепло'],['cool','Прохлада'],['mono','Ч/б'],['sepia','Плёнка']].map(([key,label])=>`<button data-action="filter" data-value="${key}" class="${state.filter===key?'active':''}" aria-pressed="${state.filter===key}"><span class="filter-preview ${key}">${icon('image')}</span>${label}</button>`).join('')}</div><p class="panel-note">Выбери настроение для своего изображения.</p>`;
  if(editTab==='adjust')contents=`${slider('brightness','Яркость',0,200)}${slider('contrast','Контраст',0,200)}${slider('saturation','Насыщенность',0,200)}`;
  if(editTab==='crop')contents=`<div class="ratio-grid" aria-label="Формат кадра">${[['original','Свободно','free'],['1:1','1:1','square'],['4:5','4:5','portrait'],['16:9','16:9','wide'],['9:16','9:16','tall']].map(([v,label,shape])=>`<button data-action="ratio" data-value="${v}" class="${state.ratio===v?'active':''}" aria-pressed="${state.ratio===v}"><span class="ratio-shape ${shape}"></span><span>${label}</span></button>`).join('')}</div><div class="tool-row"><button data-action="rotate">${icon('rotate')} Повернуть <output>${state.rotation}°</output></button><button data-action="flip" aria-pressed="${state.flip}">${icon('flip')} Отразить</button></div>${slider('zoom','Масштаб',1,3,.05)}<details class="crop-position"><summary>Положение кадра</summary>${slider('panX','По горизонтали',0,100)}${slider('panY','По вертикали',0,100)}</details>`;
  if(editTab==='text')contents=`<div class="control"><label for="edit-text">Твои слова</label><textarea id="edit-text" data-edit="text" maxlength="120" placeholder="Добавь свою историю…">${esc(state.text)}</textarea></div>${slider('textSize','Размер текста',3,18)}${slider('textX','По горизонтали',0,100)}${slider('textY','По вертикали',0,100)}<div class="control"><label for="edit-textColor">Цвет текста</label><input type="color" id="edit-textColor" data-edit="textColor" value="${state.textColor}"></div>`;
  return `<div class="edit-tabs" aria-label="Инструменты">${[['crop','Кадр','crop'],['adjust','Настройки','adjust'],['filters','Фильтры','filters'],['text','Текст','text']].map(([key,label,symbol])=>`<button data-action="edit-tab" data-value="${key}" class="${editTab===key?'active':''}" aria-pressed="${editTab===key}">${icon(symbol)}<span>${label}</span></button>`).join('')}</div><div class="panel-content">${contents}<button class="reset-btn" data-action="reset">Сбросить изменения</button></div>`;
}
async function renderEditor(pin,token){
  setTitle('Фотостудия');
  const draft=drafts.get(pin.id);
  editor={pin,state:draft?.state||initialEdit(),history:draft?.history||createHistory(initialEdit()),image:null,ready:false};editTab='crop';
  $('#main').innerHTML=`<section class="editor-top"><div class="editor-heading"><a href="#/pin/${encodeURIComponent(pin.id)}" aria-label="Назад к пину">${icon('back')}</a><h1>Фотостудия</h1></div><div class="history"><button data-action="undo" aria-label="Отменить изменение" disabled>${icon('undo')}</button><button data-action="redo" aria-label="Повторить изменение" disabled>${icon('redo')}</button></div><div class="editor-buttons"><button class="btn ghost" data-action="export" disabled aria-label="Скачать PNG">${icon('download')}<span>PNG</span></button><button class="btn" data-action="save-edit" disabled>Сохранить</button></div></section><section class="editor-layout"><div class="canvas-workspace"><div class="canvas-frame crop-active"><div class="canvas-stage"><canvas id="canvas" aria-label="Предпросмотр отредактированного изображения" hidden></canvas><div class="crop-guide" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div><p id="editor-loading" class="editor-loading" role="status">Готовим изображение…</p></div><div class="canvas-meta"><span id="canvas-size">Загрузка…</span><button data-action="compare-start" aria-label="Удерживайте, чтобы увидеть оригинал">${icon('compare')}<span>Оригинал</span></button></div></div><aside class="editor-panel">${panel()}</aside></section><p class="editor-source">${pin.local?'Изображение обрабатывается только на вашем устройстве.':`${esc(pin.author)} · ${esc(pin.license)}. ${safeSourceUrl(pin.source)?`<a href="${esc(safeSourceUrl(pin.source))}" target="_blank" rel="noopener noreferrer">Источник и лицензия</a>`:''} При экспорте добавляется подпись с авторством.`}</p>`;
  try{
    const img=await loadImage(imageUrl(pin));if(token!==viewToken)return;
    editor.image=img;editor.ready=true;$('#editor-loading').remove();$('#canvas').hidden=false;
    $('[data-action="export"]').disabled=false;$('[data-action="save-edit"]').disabled=false;draw();
  }catch(error){if(token!==viewToken)return;$('#editor-loading').innerHTML=`Не удалось открыть изображение.<br>Источник может временно ограничивать загрузку.<br><button class="btn secondary" data-action="retry-editor">Повторить</button> <button class="btn ghost" data-action="upload">Выбрать своё фото</button>`;}
}
function loadImage(src){return new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';const timer=setTimeout(()=>{img.src='';reject(new Error('Image timeout'));},20000);img.onload=()=>{clearTimeout(timer);resolve(img);};img.onerror=()=>{clearTimeout(timer);reject(new Error('Image unavailable'));};img.src=src;});}
function draw(override,canvas=$('#canvas')){
  if(!editor?.ready||!canvas)return;
  const state=sanitizeEdit(override||editor.state),img=editor.image;
  const crop=cropRect(img.naturalWidth,img.naturalHeight,state),size=outputSize(crop.sw,crop.sh,state.rotation);
  canvas.width=size.width;canvas.height=size.height;
  const ctx=canvas.getContext('2d');ctx.save();ctx.translate(size.width/2,size.height/2);ctx.rotate(state.rotation*Math.PI/180);if(state.flip)ctx.scale(-1,1);ctx.filter=canvasFilter(state);
  const w=state.rotation%180?size.height:size.width,h=state.rotation%180?size.width:size.height;
  ctx.drawImage(img,crop.sx,crop.sy,crop.sw,crop.sh,-w/2,-h/2,w,h);ctx.restore();
  if(state.text){ctx.save();const fs=Math.max(12,size.width*state.textSize/100);ctx.font=`600 ${fs}px Arial, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=state.textColor;ctx.shadowColor='#0008';ctx.shadowBlur=Math.max(2,fs*.1);ctx.shadowOffsetY=1;const lines=state.text.split('\n');lines.forEach((line,i)=>ctx.fillText(line,size.width*state.textX/100,size.height*state.textY/100+(i-(lines.length-1)/2)*fs*1.2,size.width*.94));ctx.restore();}
  if(canvas===$('#canvas')){$('#canvas-size').textContent=`${size.width} × ${size.height} px`;updateHistory();}
  return canvas;
}
function updateHistory(){const undo=$('[data-action="undo"]'),redo=$('[data-action="redo"]');if(undo)undo.disabled=!editor.history.canUndo;if(redo)redo.disabled=!editor.history.canRedo;}
function commitEdit(patch){if(!editor?.ready)return;editor.state=sanitizeEdit({...editor.state,...patch});editor.history.push(editor.state);draw();}
function refreshPanel(){$('.editor-panel').innerHTML=panel();$('.canvas-frame').classList.toggle('crop-active',editTab==='crop');}
function exportCanvas(){
  const source=document.createElement('canvas');draw(null,source);const pin=editor.pin;
  if(pin.local&&!pin.source)return source;
  const out=document.createElement('canvas');out.width=source.width;const fontSize=Math.max(10,Math.round(source.width/85));const lines=[`${pin.author} · ${pin.license}`,`Изменено в PinStudio · commons.wikimedia.org/?curid=${String(pin.originalId||pin.id).replace(/[^0-9]/g,'')}`];out.height=source.height+fontSize*4;
  const ctx=out.getContext('2d');ctx.fillStyle='#faf9f6';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(source,0,0);ctx.fillStyle='#45483f';ctx.font=`${fontSize}px Arial`;lines.forEach((line,i)=>ctx.fillText(line,12,source.height+fontSize*(1.5+i*1.4),out.width-24));return out;
}
function download(data,name){const a=document.createElement('a');a.href=data;a.download=name;document.body.append(a);a.click();a.remove();}
async function saveEdited(){if(!editor?.ready)return;try{const canvas=exportCanvas();const pin={...editor.pin,id:`local-${crypto.randomUUID()}`,originalId:editor.pin.originalId||editor.pin.id,title:`${editor.pin.title} — моя версия`.slice(0,240),image:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height,local:true,edited:true,author:editor.pin.author||'Вы',createdAt:Date.now()};transient.set(pin.id,pin);showSave(pin);}catch{toast('Не удалось экспортировать изображение. Попробуйте другое фото.');}}
function dialog(content){const d=$('#dialog');d.innerHTML=content;if(!d.open)d.showModal();}
const dialogTop=title=>`<div class="dialog-top"><h2 id="dialog-title">${esc(title)}</h2><button class="dialog-close" data-action="close-dialog" aria-label="Закрыть">${icon('close')}</button></div>`;
function boardForm(label='Новая коллекция',value=''){return `<form id="board-form"><label for="board-name">${label}</label><input id="board-name" name="name" maxlength="60" required placeholder="Например, Тихое утро" value="${esc(value)}"><button type="submit" class="btn">${value?'Сохранить название':'Создать коллекцию'}</button><p class="dialog-error" role="alert"></p></form>`;}
function showSave(pin){
  if(storageError){toast(storageError);return;}
  pendingPin=pin;
  dialog(dialogTop('Сохранить в коллекцию')+`<p class="dialog-copy">${esc(pin.title)}</p><div class="dialog-scroll">${library.boards.map(b=>`<button class="board-option" data-action="choose-board" data-board="${esc(b.id)}"><span class="board-icon">${icon('collections')}</span><span><strong>${esc(b.name)}</strong><small>${b.pins.length} пинов${b.pins.includes(pin.id)?' · уже сохранён':''}</small></span><span class="board-status">${b.pins.includes(pin.id)?icon('check'):icon('plus')}</span></button>`).join('')}</div>`+boardForm('Или создайте новую коллекцию'));
}
async function persist(next){library=await writeLibrary(next);}
async function chooseBoard(id){if(saveBusy||!pendingPin)return;saveBusy=true;try{const pin=pendingPin;await persist(addToBoard(library,id,pin));$('#dialog').close();pendingPin=null;toast(`Сохранено: ${library.boards.find(b=>b.id===id).name}`);if(!route().startsWith('/edit/'))render();else updateSaveButtons();}catch(e){toast(e.message);}finally{saveBusy=false;}}
function updateSaveButtons(){document.querySelectorAll('.pin-save').forEach(b=>{const saved=isSaved(b.dataset.id);b.classList.toggle('saved',saved);b.innerHTML=icon('bookmark');b.setAttribute('aria-pressed',saved);});}
async function render(){
  if(editor?.ready)drafts.set(editor.pin.id,{state:editor.state,history:editor.history});
  const token=++viewToken;nav();const parts=route().split('/');const type=parts[1];let id='';try{id=decodeURIComponent(parts[2]||'');}catch{}
  if(type!=='edit')editor=null;
  if(type==='boards')$('#main').innerHTML=renderBoards();
  else if(type==='board')$('#main').innerHTML=renderBoard(id);
  else if(type==='pin'||type==='edit'){
    let pin=findPin(id);
    if(!pin&&/^\d+$/.test(id)){ // Resolve a bookmarked public pin without relying on feed state.
      $('#main').innerHTML=empty('Открываем пин…','Загружаем информацию из Wikimedia Commons.');
      try{const response=await fetch(`https://commons.wikimedia.org/w/api.php?action=query&pageids=${id}&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize&iiurlwidth=1000&format=json&origin=*`,{signal:AbortSignal.timeout(18000),credentials:'omit'});if(!response.ok)throw new Error();const data=await response.json();const {normalizePage}=await import('./api.js');pin=normalizePage(data.query?.pages?.[id]);if(pin)transient.set(id,pin);}catch{}
      if(token!==viewToken)return;
    }
    if(!pin)$('#main').innerHTML=empty('Пин недоступен','Войдите в нужный аккаунт или повторите попытку позже.','<a href="#/" class="btn">Вернуться к ленте</a>');
    else if(type==='pin')$('#main').innerHTML=renderPin(pin);else await renderEditor(pin,token);
  }else{setTitle('Вдохновение');$('#main').innerHTML=feedMarkup();if(!feed.length&&!loading&&!feedError)loadFeed();}
}
async function upload(file){
  if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('Подойдут JPG, PNG и WebP.');return;}if(file.size>15*1024*1024){toast('Выберите изображение до 15 МБ.');return;}
  toast('Открываем фотографию…');const objectUrl=URL.createObjectURL(file);
  try{const img=await loadImage(objectUrl);const {width,height}=outputSize(img.naturalWidth,img.naturalHeight,0);const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(img,0,0,width,height);const pin={id:`local-${crypto.randomUUID()}`,title:file.name.replace(/\.[^.]+$/,'').slice(0,240),author:'Вы',license:'Личное изображение',source:'',image:canvas.toDataURL('image/png'),width,height,local:true};transient.set(pin.id,pin);location.hash=`/edit/${pin.id}`;}catch{toast('Этот файл не удалось прочитать как изображение.');}finally{URL.revokeObjectURL(objectUrl);$('#upload').value='';}
}

function clearAccountMemory(){accountSession={authenticated:false,user:null};library={boards:[],pins:{}};pendingPin=null;editor=null;transient.clear();drafts.clear();updateAccountIndicator();}
function updateAccountIndicator(){const avatar=$('.avatar');if(!avatar)return;avatar.classList.toggle('signed-in',accountSession.authenticated);avatar.title=accountSession.authenticated?accountSession.user.displayName:'Войти в аккаунт';avatar.setAttribute('aria-label',accountSession.authenticated?'Мой профиль':'Войти в аккаунт');}
async function syncAccount(){const fresh=await getSession();if(accountSession.user?.id!==fresh.user?.id){clearAccountMemory();}accountSession=fresh;library=await readLibrary();storageError='';updateAccountIndicator();}
async function showAccount(){
  try{await syncAccount();}catch(error){dialog(dialogTop('Не удалось открыть профиль')+`<p class="dialog-copy">${esc(error.message)}</p><button class="btn" data-action="account">Повторить</button>`);return;}
  if(!accountSession.authenticated){
    dialog(dialogTop('Войти в PinStudio')+`<div class="auth-symbol">${icon('lock')}</div><p class="dialog-copy">Сохраняй идеи в личные коллекции и продолжай работу на другом устройстве.</p><a class="btn account-signin" href="/signin-with-chatgpt?return_to=%2F" target="_top">${icon('user')} Войти через ChatGPT</a><p class="auth-note">Доступ к коллекциям получает только владелец аккаунта.${route().startsWith('/edit/')?' Перед входом скачайте несохранённый результат в PNG.':''}</p>`);return;
  }
  const legacy=await readLegacyLibrary().catch(()=>null);
  dialog(dialogTop('Мой профиль')+`<div class="account-person"><span class="account-avatar">${esc((accountSession.user.displayName||'Я')[0])}</span><div><strong>${esc(accountSession.user.displayName)}</strong><p>${esc(accountSession.user.email)}</p></div></div><p class="dialog-copy">${icon('lock')} Личные коллекции доступны только вам.</p><div class="account-stats"><span><strong>${library.boards.length}</strong> коллекций</span><span><strong>${Object.keys(library.pins).length}</strong> пинов</span></div><button class="btn secondary account-wide" data-action="refresh-account">Обновить коллекции</button>${legacy?.boards?.length?'<button class="btn secondary account-wide" data-action="import-legacy">Импортировать старые коллекции</button>':''}<a class="btn ghost account-wide" data-action="sign-out" href="/signout-with-chatgpt?return_to=%2F" target="_top">Выйти из аккаунта</a>`);
}
async function confirmImport(){
  const legacy=await readLegacyLibrary();if(!legacy?.boards?.length){toast('Локальные коллекции не найдены');return;}
  dialog(dialogTop('Перенести коллекции')+`<p class="dialog-copy">В этом профиле браузера остались коллекции старой версии: ${legacy.boards.length}. Импортируйте их только если это ваши данные. Они будут сохранены в аккаунте ${esc(accountSession.user.email)}.</p><label class="import-choice"><input id="remove-legacy" type="checkbox" checked> Удалить локальную копию после успешного импорта</label><button class="btn account-wide" data-action="confirm-import">Импортировать в мой аккаунт</button>`);
}
async function importLegacy(){
  if(saveBusy)return;saveBusy=true;const button=$('[data-action="confirm-import"]');button.disabled=true;
  try{const legacy=await readLegacyLibrary();if(!legacy?.boards)throw new Error('Локальные коллекции не найдены.');const remove=$('#remove-legacy').checked;const next=structuredClone(library),ids=new Map();
    for(const [id,pin] of Object.entries(legacy.pins||{})){const newId=`local-${crypto.randomUUID()}`;ids.set(id,newId);next.pins[newId]={...pin,id:newId,originalId:pin.originalId||pin.id,title:String(pin.title||'Без названия').slice(0,240)};}
    for(const board of legacy.boards)next.boards.push({id:crypto.randomUUID(),name:boardName(board.name),createdAt:Date.now(),pins:[...new Set((board.pins||[]).map(id=>ids.get(id)).filter(Boolean))]});
    await persist(next);if(remove)await clearLegacyLibrary();$('#dialog').close();render();toast('Коллекции перенесены в ваш аккаунт');
  }catch(error){toast(error.message);}finally{saveBusy=false;button.disabled=false;}
}

document.addEventListener('click',async event=>{
  if(event.target.closest('.skip')){event.preventDefault();$('#main').focus();return;}
  if(event.target.closest('[data-nav="feed"],.brand')){event.preventDefault();searchOpen=false;query=categories[0][1];category=categories[0][0];$('#search').value='';if(route()!=='/')location.hash='/';else{nav();$('#main').innerHTML=feedMarkup();}loadFeed();return;}
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  const {action,id,board,value}=button.dataset;
  try{
    if(action==='upload'){if(!accountSession.authenticated){await showAccount();return;}$('#upload').click();}
    else if(action==='account')await showAccount();
    else if(action==='sign-out'){clearAccountMemory();}
    else if(action==='refresh-account'){await syncAccount();$('#dialog').close();render();toast('Коллекции обновлены');}
    else if(action==='import-legacy')await confirmImport();
    else if(action==='confirm-import')await importLegacy();
    else if(action==='focus-search'){searchOpen=true;if(route()!=='/')location.hash='/';nav();$('#search').scrollIntoView({block:'center'});$('#search').focus();}
    else if(action==='clear-search'){$('#search').value='';$('#search').focus();}
    else if(action==='category'){searchOpen=false;nav();query=button.dataset.query;category=button.dataset.label;$('#search').value='';if(route()!=='/')location.hash='/';else $('#main').innerHTML=feedMarkup();loadFeed();}
    else if(action==='retry')loadFeed(false);
    else if(action==='more')loadFeed(true);
    else if(action==='save'){if(!accountSession.authenticated){await showAccount();return;}const pin=findPin(id);if(pin)showSave(pin);}
    else if(action==='choose-board')await chooseBoard(board);
    else if(action==='close-dialog'){$('#dialog').close();pendingPin=null;}
    else if(action==='new-board'){if(!accountSession.authenticated){await showAccount();return;}pendingPin=null;dialog(dialogTop('Новая коллекция')+boardForm());}
    else if(action==='rename-board'){pendingPin=null;dialog(dialogTop('Название коллекции')+boardForm('Название',library.boards.find(b=>b.id===board).name));$('#board-form').dataset.rename=board;}
    else if(action==='remove'){if(saveBusy)return;saveBusy=true;try{await persist(removeFromBoard(library,board,id));render();toast('Пин убран с доски');}finally{saveBusy=false;}}
    else if(action==='edit-tab'){editTab=value;refreshPanel();}
    else if(action==='ratio'){commitEdit({ratio:value});refreshPanel();}
    else if(action==='filter'){commitEdit({filter:value});refreshPanel();}
    else if(action==='rotate'){commitEdit({rotation:(editor.state.rotation+90)%360});refreshPanel();}
    else if(action==='flip'){commitEdit({flip:!editor.state.flip});refreshPanel();}
    else if(action==='undo'||action==='redo'){editor.state=editor.history[action]();draw();refreshPanel();}
    else if(action==='reset'){commitEdit(initialEdit());refreshPanel();}
    else if(action==='save-edit'){if(!accountSession.authenticated){await showAccount();return;}await saveEdited();}
    else if(action==='export'){download(exportCanvas().toDataURL('image/png'),'pinroom-studio.png');toast('PNG подготовлен для скачивания');}
    else if(action==='retry-editor')render();
    else if(action==='about'){dialog(dialogTop('Пространство для идей')+'<p class="dialog-copy">PinStudio — учебная интерпретация сценариев Pinterest со встроенной фотостудией. Проект не связан с Pinterest или Adobe.</p><p class="dialog-copy">Изображения ленты поступают из Wikimedia Commons. Сохраняются авторство, источник и лицензия. Поисковый запрос и IP-адрес видны Wikimedia при обращении к API.</p><p class="dialog-copy">Вход выполняется через ChatGPT. Коллекции и сохранённые изображения находятся в закрытом серверном хранилище. Сервер проверяет владельца при каждом чтении и изменении. Несохранённые изменения редактора остаются в памяти вкладки. На общем устройстве выходите из аккаунта после работы.</p><p class="dialog-copy">Пять экранов · внешний API · личные коллекции · фотостудия. Коллекции синхронизируются при открытии и сохранении; автоматическое совместное редактирование не поддерживается.</p>');}
  }catch(error){toast(error.message||'Не получилось выполнить действие. Попробуйте снова.');}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='search-form'){event.preventDefault();const text=$('#search').value.trim();if(!text)return;query=text;category='Поиск';searchOpen=true;nav();if(route()!=='/')location.hash='/';else $('#main').innerHTML=feedMarkup();loadFeed();}
  if(event.target.id==='board-form'){
    event.preventDefault();if(saveBusy)return;saveBusy=true;const form=event.target;const submit=form.querySelector('button');submit.disabled=true;
    try{const name=boardName(new FormData(form).get('name'));let next=structuredClone(library);const rename=form.dataset.rename;
      if(rename)next.boards.find(b=>b.id===rename).name=name;
      else{const id=crypto.randomUUID();next.boards.unshift({id,name,pins:[],createdAt:Date.now()});if(pendingPin)next=addToBoard(next,id,pendingPin);}
      await persist(next);$('#dialog').close();pendingPin=null;toast(rename?'Название обновлено':'Коллекция создана');if(!route().startsWith('/edit/'))render();
    }catch(error){form.querySelector('.dialog-error').textContent=error.message;}finally{saveBusy=false;submit.disabled=false;}
  }
});
document.addEventListener('input',event=>{const key=event.target.dataset.edit;if(!key||!editor?.ready)return;const value=event.target.type==='range'?Number(event.target.value):event.target.value;editor.state=sanitizeEdit({...editor.state,[key]:value});const output=$(`#out-${key}`);if(output)output.textContent=value;draw();});
document.addEventListener('change',event=>{if(event.target.dataset.edit&&editor?.ready){editor.history.push(editor.state);updateHistory();}if(event.target.id==='upload')upload(event.target.files[0]);});
document.addEventListener('pointerdown',event=>{const button=event.target.closest('[data-action="compare-start"]');if(button&&editor?.ready){button.setPointerCapture(event.pointerId);draw(initialEdit());}});
document.addEventListener('pointerup',()=>{if(editor?.ready)draw();});
document.addEventListener('pointercancel',()=>{if(editor?.ready)draw();});
document.addEventListener('keydown',event=>{if(!editor?.ready||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();editor.state=editor.history[event.shiftKey?'redo':'undo']();draw();refreshPanel();}});
document.addEventListener('load',event=>{if(event.target?.matches?.('[data-pin-image]'))event.target.classList.add('is-loaded');},true);
document.addEventListener('error',event=>{const img=event.target;if(img?.matches?.('[data-pin-image]')&&!img.parentElement.querySelector('.img-failed')){const msg=document.createElement('span');msg.className='img-failed';msg.textContent='Источник временно не отдаёт изображение';img.parentElement.style.position='relative';img.parentElement.append(msg);}},true);
window.addEventListener('hashchange',()=>{render();window.scrollTo(0,0);});
window.addEventListener('beforeunload',event=>{if(editor?.history.canUndo){event.preventDefault();event.returnValue='';}});
$('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog')){const rect=$('#dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('#dialog').close();}});
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
window.addEventListener('auth-expired',event=>{clearAccountMemory();render();toast(event.detail?.message||'Сессия завершена. Войдите снова.');});
try{await syncAccount();}catch(error){storageError=error.message;toast(storageError);}
render();
