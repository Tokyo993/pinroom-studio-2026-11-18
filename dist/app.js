import {searchPins,safeImageUrl,safeSourceUrl} from './api.js';
import {readLibrary,writeLibrary,boardName,addToBoard,removeFromBoard} from './storage.js';
import {initialEdit,sanitizeEdit,cropRect,outputSize,canvasFilter,createHistory} from './editor-core.js';

const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const categories=[['Для вас','incategory:"Featured pictures on Wikimedia Commons" landscape'],['Природа','incategory:"Featured pictures on Wikimedia Commons" mountains'],['Архитектура','incategory:"Featured pictures on Wikimedia Commons" architecture'],['Интерьеры','interior design'],['Цветы','incategory:"Featured pictures on Wikimedia Commons" flowers'],['Путешествия','incategory:"Featured pictures on Wikimedia Commons" Italy'],['Искусство','abstract painting']];
let library={boards:[],pins:{}},storageError='',feed=[],query=categories[0][1],category='Для вас',nextOffset=null,loading=false,feedError='',request=null,viewToken=0;
let editor=null,editTab='adjust',pendingPin=null,toastTimer,saveBusy=false;
const transient=new Map();
const drafts=new Map();
const allPins=()=>new Map([...feed.map(p=>[p.id,p]),...Object.entries(library.pins),...transient]);
const findPin=id=>allPins().get(id);
const isSaved=id=>library.boards.some(b=>b.pins.includes(id));
const imageUrl=p=>p?.local&&/^data:image\/(png|jpeg|webp);base64,/.test(p.image)?p.image:safeImageUrl(p?.image);
const route=()=>location.hash.slice(1)||'/';
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4000);}
function setTitle(text){document.title=`${text} · Pinroom`;}
function nav(){document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===(route().startsWith('/board')?'boards':'feed')));}
function empty(title,description,action=''){return `<section class="empty"><span class="empty-icon">✧</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</section>`;}
function card(pin,boardId=''){
  return `<article class="pin-card"><div class="pin-picture"><a href="#/pin/${encodeURIComponent(pin.id)}" aria-label="Открыть: ${esc(pin.title)}"><img src="${esc(imageUrl(pin))}" alt="${esc(pin.title)}" loading="lazy" style="aspect-ratio:${Math.min(1.7,Math.max(.55,pin.width/pin.height))}" data-pin-image></a><button class="pin-save ${isSaved(pin.id)?'saved':''}" data-action="save" data-id="${esc(pin.id)}" aria-label="Сохранить: ${esc(pin.title)}">${isSaved(pin.id)?'✓':'＋'}</button><a class="pin-edit" href="#/edit/${encodeURIComponent(pin.id)}">✧ В студию</a>${pin.edited?'<span class="edit-tag">ВАША ВЕРСИЯ</span>':''}</div><a href="#/pin/${encodeURIComponent(pin.id)}"><h3>${esc(pin.title)}</h3></a><div class="board-pin-actions"><div class="pin-author"><span class="author-dot">${esc((pin.author||'P')[0])}</span>${esc(pin.author||'Ваше изображение')}</div>${boardId?`<button class="remove-pin" data-action="remove" data-id="${esc(pin.id)}" data-board="${esc(boardId)}" aria-label="Убрать ${esc(pin.title)} с доски">Убрать</button>`:''}</div></article>`;
}
function feedMarkup(){
  const heading=category==='Поиск'?`Идеи по запросу <em>«${esc(query)}»</em>`:'Найди своё <em>вдохновение.</em>';
  return `<section class="intro"><div><div class="eyebrow"><i></i> СОБИРАЙ. ПЕРЕОСМЫСЛИВАЙ. СОЗДАВАЙ.</div><h1>${heading}</h1><p>Маленькая находка сегодня. Большая идея завтра.</p></div><button class="studio-promo" data-action="upload"><span class="promo-icon">✳</span><span><span class="tag">НОВОЕ В PINROOM</span><strong>Твоя маленькая фотостудия</strong><small>Добавь идее свой характер.<br>Прямо здесь.</small></span><span class="arrow">↗</span></button></section><section class="feed-tools" aria-label="Категории"><div class="chips">${categories.map(([label,q])=>`<button class="chip ${category===label?'active':''}" data-action="category" data-query="${esc(q)}" data-label="${label}">${label}</button>`).join('')}</div><span class="feed-caption"><i></i> Находки из Wikimedia Commons</span></section><div id="feed-results">${feedResults()}</div>`;
}
function feedResults(){
  if(loading&&!feed.length)return `<div class="loading-grid" aria-label="Загружаем изображения" role="status">${Array.from({length:15},()=>'<div class="skeleton"></div>').join('')}</div>`;
  const error=feedError?`<div class="error-banner" role="alert">${esc(feedError)} <button class="btn secondary" data-action="retry">Повторить</button></div>`:'';
  if(!feed.length&&!loading)return error+empty('Пока ничего не нашлось','Попробуйте более простой запрос — например, mountains, flowers или architecture. Поиск лучше понимает английский.');
  return `${error}<div class="masonry">${feed.map(p=>card(p)).join('')}</div>${nextOffset!==null?`<div class="load-more"><button class="btn ghost" data-action="more" ${loading?'disabled':''}>${loading?'Загружаем…':'Ещё немного вдохновения ↓'}</button></div>`:''}`;
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
  setTitle('Мои доски');
  return `<section class="board-header"><div><div class="eyebrow"><i></i> ЛИЧНАЯ КОЛЛЕКЦИЯ</div><h1>Твои идеи. Твои доски.</h1><p>Всё, что хочется сохранить на потом.</p></div><button class="btn" data-action="new-board">＋ Новая доска</button></section><p class="local-note">◉ Только в этом браузере. Доски и загруженные фотографии не отправляются на сервер.</p>${storageError?`<p class="error-banner">${esc(storageError)}</p>`:''}<div class="board-grid">${library.boards.map(b=>{const pins=b.pins.map(id=>library.pins[id]).filter(Boolean).slice(0,3);return `<a class="board-card" href="#/board/${encodeURIComponent(b.id)}"><div class="board-cover ${pins.length?'':'blank'}">${pins.length?pins.map(p=>`<img src="${esc(imageUrl(p))}" alt="" loading="lazy">`).join(''):'＋'}</div><h3>${esc(b.name)}</h3><p>${b.pins.length} сохранённых пинов · личная доска</p></a>`;}).join('')}</div>`;
}
function renderBoard(id){
  const board=library.boards.find(b=>b.id===id);if(!board)return empty('Доска не найдена','Возможно, она была удалена.', '<a class="btn" href="#/boards">К доскам</a>');
  setTitle(board.name);
  return `<div class="backline"><a href="#/boards" aria-label="Назад к доскам">←</a> Мои доски</div><section class="board-header"><div><div class="eyebrow"><i></i> ЛИЧНАЯ ДОСКА · ${board.pins.length} ПИНОВ</div><h1>${esc(board.name)}</h1></div><button class="btn ghost" data-action="rename-board" data-board="${esc(id)}">Переименовать</button></section>${board.pins.length?`<div class="masonry">${board.pins.map(pid=>library.pins[pid]).filter(Boolean).map(p=>card(p,id)).join('')}</div>`:empty('Здесь начнётся твоя коллекция','Нажмите «＋» на понравившемся пине или создайте собственный в студии.','<a class="btn" href="#/">Найти вдохновение</a>')}`;
}
function renderPin(pin){
  setTitle(pin.title);
  return `<div class="backline"><a href="#/" aria-label="К ленте">←</a> К вдохновению</div><article class="detail"><div class="detail-image"><img src="${esc(imageUrl(pin))}" alt="${esc(pin.title)}" data-pin-image></div><div class="detail-content"><div class="detail-actions"><span class="badge">${pin.edited?'Создано в Pinroom':pin.local?'Ваше фото':'Находка дня'}</span><button class="btn" data-action="save" data-id="${esc(pin.id)}">${isSaved(pin.id)?'✓ Сохранено · ещё':'Сохранить'}</button></div><h1>${esc(pin.title)}</h1><div class="credit"><span class="author-dot">${esc((pin.author||'Я')[0])}</span><div>${esc(pin.author)}<p class="detail-description">${esc(pin.license||'Личное изображение')}</p></div></div><p class="detail-description">${pin.edited?'Ваша версия изображения. Оригинал остаётся без изменений.':'Сохраните идею в свою коллекцию или добавьте ей собственное настроение в студии.'}</p>${safeSourceUrl(pin.source)?`<a class="source-link" href="${esc(safeSourceUrl(pin.source))}" target="_blank" rel="noopener noreferrer">Открыть оригинал и условия использования ↗</a>`:''}<section class="editor-invite"><div class="eyebrow">✧ ВСТРОЕННАЯ ФОТОСТУДИЯ</div><h3>А если сделать по-своему?</h3><p>Новый ракурс, немного цвета, пара слов.<br>Превратите вдохновение в собственную работу.</p><a class="btn secondary" href="#/edit/${encodeURIComponent(pin.id)}">Открыть в студии ↗</a></section></div></article>`;
}
function slider(key,label,min,max,step=1){const value=editor.state[key];return `<div class="control"><label for="edit-${key}">${label}<output id="out-${key}">${value}</output></label><input type="range" id="edit-${key}" data-edit="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;}
function panel(){
  const state=editor.state;
  let contents='';
  if(editTab==='adjust')contents=`<div class="filter-grid">${[['none','Оригинал','◌'],['warm','Тепло','☀'],['cool','Прохлада','❋'],['mono','Ч/б','◐'],['sepia','Плёнка','◉']].map(([key,label,symbol])=>`<button data-action="filter" data-value="${key}" class="${state.filter===key?'active':''}"><span>${symbol}</span>${label}</button>`).join('')}</div>${slider('brightness','Яркость',0,200)}${slider('contrast','Контраст',0,200)}${slider('saturation','Насыщенность',0,200)}`;
  if(editTab==='crop')contents=`<div class="control"><label for="edit-ratio">Формат кадра</label><select id="edit-ratio" data-edit="ratio">${[['original','Оригинальный'],['1:1','Квадрат · 1:1'],['4:5','Портрет · 4:5'],['9:16','История · 9:16'],['16:9','Широкий · 16:9']].map(([v,l])=>`<option value="${v}" ${state.ratio===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="tool-row"><button data-action="rotate">↻ Повернуть</button><button data-action="flip">↔ Отразить</button></div>${slider('zoom','Масштаб',1,3,.05)}${slider('panX','Кадр по горизонтали',0,100)}${slider('panY','Кадр по вертикали',0,100)}<p class="panel-note">Сначала выберите формат. Масштаб и смещение помогают оставить в кадре главное. Поворот применяется после кадрирования.</p>`;
  if(editTab==='text')contents=`<div class="control"><label for="edit-text">Твои слова</label><textarea id="edit-text" data-edit="text" maxlength="120" placeholder="Пусть это будет начало…">${esc(state.text)}</textarea></div>${slider('textSize','Размер текста',3,18)}${slider('textX','По горизонтали',0,100)}${slider('textY','По вертикали',0,100)}<div class="control"><label for="edit-textColor">Цвет текста</label><input type="color" id="edit-textColor" data-edit="textColor" value="${state.textColor}"></div><p class="panel-note">До 120 символов. Переносы строк сохраняются. Позиция задаётся относительно центра текста.</p>`;
  return `<h2>Своё настроение</h2><div class="edit-tabs" aria-label="Инструменты">${[['adjust','Цвет'],['crop','Кадр'],['text','Текст']].map(([key,label])=>`<button data-action="edit-tab" data-value="${key}" class="${editTab===key?'active':''}" aria-pressed="${editTab===key}">${label}</button>`).join('')}</div>${contents}<button class="reset-btn" data-action="reset">Вернуть оригинальные настройки</button>`;
}
async function renderEditor(pin,token){
  setTitle('Фотостудия');
  const draft=drafts.get(pin.id);
  editor={pin,state:draft?.state||initialEdit(),history:draft?.history||createHistory(initialEdit()),image:null,ready:false};editTab='adjust';
  $('#main').innerHTML=`<section class="editor-top"><div class="editor-heading"><a href="#/pin/${encodeURIComponent(pin.id)}" aria-label="Назад к пину">←</a><div><h1>Маленькая фотостудия <span class="badge">✧</span></h1><small>Немного тебя в каждом кадре</small></div></div><div class="editor-buttons"><button class="btn ghost" data-action="export" disabled>↓ PNG</button><button class="btn" data-action="save-edit" disabled>Сохранить</button></div></section><section class="editor-layout"><div class="canvas-workspace"><div class="canvas-top"><span id="canvas-size">Загрузка оригинала…</span><div class="history"><button data-action="undo" aria-label="Отменить изменение" disabled>↶</button><button data-action="redo" aria-label="Повторить изменение" disabled>↷</button><button data-action="compare-start" aria-label="Удерживайте, чтобы увидеть оригинал" title="Удерживайте: оригинал">◐</button></div></div><div class="canvas-frame"><canvas id="canvas" aria-label="Предпросмотр отредактированного изображения" hidden></canvas><p id="editor-loading" class="editor-loading" role="status">Готовим холст…</p></div><p class="canvas-caption">Оригинал всегда остаётся нетронутым · до 1600 px</p></div><aside class="editor-panel">${panel()}</aside></section><p class="editor-source">${pin.local?'Фотография обрабатывается на вашем устройстве.':`Источник: ${esc(pin.author)} · ${esc(pin.license)}. ${safeSourceUrl(pin.source)?`<a href="${esc(safeSourceUrl(pin.source))}" target="_blank" rel="noopener noreferrer">Оригинал и лицензия ↗</a>`:''} При экспорте авторство и источник добавляются подписью под изображением.`}</p>`;
  try{
    const img=await loadImage(imageUrl(pin));if(token!==viewToken)return;
    editor.image=img;editor.ready=true;$('#editor-loading').remove();$('#canvas').hidden=false;
    $('[data-action="export"]').disabled=false;$('[data-action="save-edit"]').disabled=false;draw();
  }catch(error){if(token!==viewToken)return;$('#editor-loading').innerHTML=`Не удалось открыть изображение для редактирования.<br>Источник может временно ограничивать загрузку.<br><button class="btn secondary" data-action="retry-editor">Повторить</button> <button class="btn ghost" data-action="upload">Выбрать своё фото</button>`;}
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
  if(canvas===$('#canvas')){$('#canvas-size').textContent=`${size.width} × ${size.height} px · предпросмотр`;updateHistory();}
  return canvas;
}
function updateHistory(){const undo=$('[data-action="undo"]'),redo=$('[data-action="redo"]');if(undo)undo.disabled=!editor.history.canUndo;if(redo)redo.disabled=!editor.history.canRedo;}
function commitEdit(patch){if(!editor?.ready)return;editor.state=sanitizeEdit({...editor.state,...patch});editor.history.push(editor.state);draw();}
function refreshPanel(){$('.editor-panel').innerHTML=panel();}
function exportCanvas(){
  const source=document.createElement('canvas');draw(null,source);const pin=editor.pin;
  if(pin.local&&!pin.source)return source;
  const out=document.createElement('canvas');out.width=source.width;const fontSize=Math.max(10,Math.round(source.width/85));const lines=[`${pin.author} · ${pin.license}`,`Изменено в Pinroom · commons.wikimedia.org/?curid=${String(pin.originalId||pin.id).replace(/[^0-9]/g,'')}`];out.height=source.height+fontSize*4;
  const ctx=out.getContext('2d');ctx.fillStyle='#faf9f6';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(source,0,0);ctx.fillStyle='#45483f';ctx.font=`${fontSize}px Arial`;lines.forEach((line,i)=>ctx.fillText(line,12,source.height+fontSize*(1.5+i*1.4),out.width-24));return out;
}
function download(data,name){const a=document.createElement('a');a.href=data;a.download=name;document.body.append(a);a.click();a.remove();}
async function saveEdited(){if(!editor?.ready)return;try{const canvas=exportCanvas();const pin={...editor.pin,id:`local-${crypto.randomUUID()}`,originalId:editor.pin.originalId||editor.pin.id,title:`${editor.pin.title} — моя версия`,image:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height,local:true,edited:true,author:editor.pin.author||'Вы',createdAt:Date.now()};transient.set(pin.id,pin);showSave(pin);}catch{toast('Не удалось экспортировать изображение. Попробуйте другое фото.');}}
function dialog(content){const d=$('#dialog');d.innerHTML=content;if(!d.open)d.showModal();}
const dialogTop=title=>`<div class="dialog-top"><h2 id="dialog-title">${esc(title)}</h2><button class="dialog-close" data-action="close-dialog" aria-label="Закрыть">×</button></div>`;
function boardForm(label='Новая доска',value=''){return `<form id="board-form"><label for="board-name">${label}</label><input id="board-name" name="name" maxlength="60" required placeholder="Например, Тихое утро" value="${esc(value)}"><button type="submit" class="btn">${value?'Сохранить название':'Создать доску'}</button><p class="dialog-error" role="alert"></p></form>`;}
function showSave(pin){
  if(storageError){toast(storageError);return;}
  pendingPin=pin;
  dialog(dialogTop('Сохранить на доску')+`<p class="dialog-copy">${esc(pin.title)}</p><div class="dialog-scroll">${library.boards.map(b=>`<button class="board-option" data-action="choose-board" data-board="${esc(b.id)}"><span class="board-icon">▦</span><span><strong>${esc(b.name)}</strong><small>${b.pins.length} пинов${b.pins.includes(pin.id)?' · уже сохранён':''}</small></span><span class="arrow">${b.pins.includes(pin.id)?'✓':'→'}</span></button>`).join('')}</div>`+boardForm('Или создайте новую доску'));
}
async function persist(next){await writeLibrary(next);library=next;}
async function chooseBoard(id){if(saveBusy||!pendingPin)return;saveBusy=true;try{const pin=pendingPin;await persist(addToBoard(library,id,pin));$('#dialog').close();pendingPin=null;toast(`Сохранено: ${library.boards.find(b=>b.id===id).name}`);if(!route().startsWith('/edit/'))render();else updateSaveButtons();}catch(e){toast(e.message);}finally{saveBusy=false;}}
function updateSaveButtons(){document.querySelectorAll('.pin-save').forEach(b=>{const saved=isSaved(b.dataset.id);b.classList.toggle('saved',saved);b.textContent=saved?'✓':'＋';});}
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
    if(!pin)$('#main').innerHTML=empty('Пин недоступен','Он не сохранён в этом браузере или источник временно не отвечает.','<a href="#/" class="btn">Вернуться к ленте</a>');
    else if(type==='pin')$('#main').innerHTML=renderPin(pin);else await renderEditor(pin,token);
  }else{setTitle('Вдохновение');$('#main').innerHTML=feedMarkup();if(!feed.length&&!loading&&!feedError)loadFeed();}
}
async function upload(file){
  if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('Подойдут JPG, PNG и WebP.');return;}if(file.size>15*1024*1024){toast('Выберите изображение до 15 МБ.');return;}
  toast('Открываем фотографию…');const objectUrl=URL.createObjectURL(file);
  try{const img=await loadImage(objectUrl);const {width,height}=outputSize(img.naturalWidth,img.naturalHeight,0);const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(img,0,0,width,height);const pin={id:`local-${crypto.randomUUID()}`,title:file.name.replace(/\.[^.]+$/,''),author:'Вы',license:'Личное изображение',source:'',image:canvas.toDataURL('image/png'),width,height,local:true};transient.set(pin.id,pin);location.hash=`/edit/${pin.id}`;}catch{toast('Этот файл не удалось прочитать как изображение.');}finally{URL.revokeObjectURL(objectUrl);$('#upload').value='';}
}
document.addEventListener('click',async event=>{
  if(event.target.closest('.skip')){event.preventDefault();$('#main').focus();return;}
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  const {action,id,board,value}=button.dataset;
  try{
    if(action==='upload')$('#upload').click();
    else if(action==='focus-search'){$('#search').scrollIntoView({behavior:'smooth',block:'center'});$('#search').focus();}
    else if(action==='category'){query=button.dataset.query;category=button.dataset.label;$('#search').value='';if(route()!=='/')location.hash='/';else $('#main').innerHTML=feedMarkup();loadFeed();}
    else if(action==='retry')loadFeed(false);
    else if(action==='more')loadFeed(true);
    else if(action==='save'){const pin=findPin(id);if(pin)showSave(pin);}
    else if(action==='choose-board')await chooseBoard(board);
    else if(action==='close-dialog'){$('#dialog').close();pendingPin=null;}
    else if(action==='new-board'){pendingPin=null;dialog(dialogTop('Новая доска')+boardForm());}
    else if(action==='rename-board'){pendingPin=null;dialog(dialogTop('Название доски')+boardForm('Название',library.boards.find(b=>b.id===board).name));$('#board-form').dataset.rename=board;}
    else if(action==='remove'){if(saveBusy)return;saveBusy=true;try{await persist(removeFromBoard(library,board,id));render();toast('Пин убран с доски');}finally{saveBusy=false;}}
    else if(action==='edit-tab'){editTab=value;refreshPanel();}
    else if(action==='filter'){commitEdit({filter:value});refreshPanel();}
    else if(action==='rotate'){commitEdit({rotation:(editor.state.rotation+90)%360});refreshPanel();}
    else if(action==='flip'){commitEdit({flip:!editor.state.flip});refreshPanel();}
    else if(action==='undo'||action==='redo'){editor.state=editor.history[action]();draw();refreshPanel();}
    else if(action==='reset'){commitEdit(initialEdit());refreshPanel();}
    else if(action==='save-edit')await saveEdited();
    else if(action==='export'){download(exportCanvas().toDataURL('image/png'),'pinroom-studio.png');toast('PNG подготовлен для скачивания');}
    else if(action==='retry-editor')render();
    else if(action==='about'){dialog(dialogTop('Пространство для идей')+'<p class="dialog-copy">Pinroom — учебная интерпретация сценариев Pinterest со встроенной фотостудией. Проект не связан с Pinterest или Adobe.</p><p class="dialog-copy">Изображения ленты поступают из Wikimedia Commons. Сохраняются авторство, источник и лицензия. Поисковый запрос и IP-адрес видны Wikimedia при обращении к API.</p><p class="dialog-copy">Доски, загруженные фото и результаты редактирования хранятся в IndexedDB только в этом браузере. Они не отправляются на сервер. Это не зашифрованное хранилище: другие пользователи этого профиля браузера могут получить доступ. Очистка данных сайта удалит коллекцию. Скачивайте важные работы в PNG.</p><p class="dialog-copy">Пять экранов · API · локальные доски · фотостудия. Нет аккаунтов, облачной синхронизации и совместных досок.</p>');}
  }catch(error){toast(error.message||'Не получилось выполнить действие. Попробуйте снова.');}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='search-form'){event.preventDefault();const text=$('#search').value.trim();if(!text)return;query=text;category='Поиск';if(route()!=='/')location.hash='/';else $('#main').innerHTML=feedMarkup();loadFeed();}
  if(event.target.id==='board-form'){
    event.preventDefault();if(saveBusy)return;saveBusy=true;const form=event.target;const submit=form.querySelector('button');submit.disabled=true;
    try{const name=boardName(new FormData(form).get('name'));let next=structuredClone(library);const rename=form.dataset.rename;
      if(rename)next.boards.find(b=>b.id===rename).name=name;
      else{const id=crypto.randomUUID();next.boards.unshift({id,name,pins:[],createdAt:Date.now()});if(pendingPin)next=addToBoard(next,id,pendingPin);}
      await persist(next);$('#dialog').close();pendingPin=null;toast(rename?'Название обновлено':'Доска создана');if(!route().startsWith('/edit/'))render();
    }catch(error){form.querySelector('.dialog-error').textContent=error.message;}finally{saveBusy=false;submit.disabled=false;}
  }
});
document.addEventListener('input',event=>{const key=event.target.dataset.edit;if(!key||!editor?.ready)return;const value=event.target.type==='range'?Number(event.target.value):event.target.value;editor.state=sanitizeEdit({...editor.state,[key]:value});const output=$(`#out-${key}`);if(output)output.textContent=value;draw();});
document.addEventListener('change',event=>{if(event.target.dataset.edit&&editor?.ready){editor.history.push(editor.state);updateHistory();}if(event.target.id==='upload')upload(event.target.files[0]);});
document.addEventListener('pointerdown',event=>{const button=event.target.closest('[data-action="compare-start"]');if(button&&editor?.ready){button.setPointerCapture(event.pointerId);draw(initialEdit());}});
document.addEventListener('pointerup',()=>{if(editor?.ready)draw();});
document.addEventListener('pointercancel',()=>{if(editor?.ready)draw();});
document.addEventListener('keydown',event=>{if(!editor?.ready||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();editor.state=editor.history[event.shiftKey?'redo':'undo']();draw();refreshPanel();}});
document.addEventListener('error',event=>{const img=event.target;if(img?.matches?.('[data-pin-image]')&&!img.parentElement.querySelector('.img-failed')){const msg=document.createElement('span');msg.className='img-failed';msg.textContent='Источник временно не отдаёт изображение';img.parentElement.style.position='relative';img.parentElement.append(msg);}},true);
window.addEventListener('hashchange',()=>{render();window.scrollTo(0,0);});
window.addEventListener('beforeunload',event=>{if(editor?.history.canUndo){event.preventDefault();event.returnValue='';}});
$('#dialog').addEventListener('click',event=>{if(event.target===$('#dialog')){const rect=$('#dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('#dialog').close();}});
try{library=await readLibrary();}catch(error){storageError=error.message;toast(storageError);}
render();
