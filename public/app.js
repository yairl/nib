(function(){
'use strict';

var $ = function(id){ return document.getElementById(id); };
var each = function(sel, fn){
  var n = document.querySelectorAll(sel);
  for (var i = 0; i < n.length; i++) fn(n[i], i);
};

var toastT;
function toast(msg){
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(function(){ t.classList.remove('on'); }, 2600);
}

if (typeof window.pdfjsLib === 'undefined' || typeof window.PDFLib === 'undefined'){
  var dz = $('drop');
  if (dz) dz.innerHTML = '<h1>Blocked</h1><p>The PDF engine could not load. Something is blocking cdnjs.cloudflare.com. Allow it and reload.</p>';
  return;
}

var PDFLIB = window.PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

var DPR = Math.min(window.devicePixelRatio || 1, 2);

var S = {
  bytes:null, name:'document.pdf', doc:null, pages:[],
  zoom:1, zmode:'fitw', cont:true, cur:1,
  tool:'text', ink:'#16325c',
  anns:[], els:{}, sel:null, sig:null, hist:[], seq:0,
  find:{ q:'', hits:[], i:-1, indexed:false }
};

var CHECK_PATH = 'M 12 54 L 40 82 L 88 16';
var CROSS_PATH = 'M 16 16 L 84 84 M 84 16 L 16 84';

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function snapshot(){ S.hist.push(JSON.stringify(S.anns)); if (S.hist.length > 80) S.hist.shift(); }
function undo(){
  if (!S.hist.length) return;
  S.anns = JSON.parse(S.hist.pop());
  S.sel = null;
  rebuildAnns();
}
function hexToRgb(hex){
  var n = parseInt(hex.slice(1), 16);
  return PDFLIB.rgb(((n >> 16) & 255)/255, ((n >> 8) & 255)/255, (n & 255)/255);
}

/* ================= open ================= */
function openFile(file){
  if (!file) return;
  var isPdf = (file.type && file.type.indexOf('pdf') !== -1) || /\.pdf$/i.test(file.name || '');
  if (!isPdf){ toast('Not a PDF.'); return; }
  var fr = new FileReader();
  fr.onload = function(){
    var buf = fr.result;
    S.bytes = new Uint8Array(buf);
    S.name = file.name || 'document.pdf';
    S.anns = []; S.els = {}; S.sel = null; S.hist = [];
    S.find = { q:'', hits:[], i:-1, indexed:false };
    $('findbox').value = '';
    $('findcount').textContent = '';
    load(new Uint8Array(buf.slice(0)));
  };
  fr.onerror = function(){ toast('Could not read that file.'); };
  fr.readAsArrayBuffer(file);
}

function load(data){
  document.title = 'Opening\u2026';
  pdfjsLib.getDocument({ data:data }).promise.then(function(doc){
    S.doc = doc;
    var jobs = [];
    for (var i = 1; i <= doc.numPages; i++) jobs.push(doc.getPage(i));
    return Promise.all(jobs);
  }).then(function(pages){
    S.pages = pages.map(function(p){
      var vp = p.getViewport({ scale:1 });
      return { pdf:p, vw:vp.width, vh:vp.height, el:null, canvas:null, layer:null, find:null, scale:0, busy:false, items:null };
    });
    buildDoc();
    document.title = S.name + ' - Inkwell';
    $('empty').hidden = true;
    $('dl').disabled = false;
    $('pagecount').textContent = 'of ' + S.pages.length;
    S.cur = 1;
    $('pagebox').value = '1';
    applyZoomMode();
    loadOutline();
    toast('Click the page to type. Press H to pan.');
  }).catch(function(err){
    console.error(err);
    document.title = 'Inkwell';
    toast('That PDF could not be opened.');
  });
}

/* ================= render ================= */
var io = new IntersectionObserver(function(entries){
  entries.forEach(function(e){ if (e.isIntersecting) renderPage(+e.target.dataset.p); });
}, { root:$('viewer'), rootMargin:'800px 0px' });

function buildDoc(){
  var doc = $('doc');
  doc.innerHTML = '';
  io.disconnect();
  S.pages.forEach(function(p, i){
    var el = document.createElement('div');
    el.className = 'page';
    el.dataset.p = i;
    var c = document.createElement('canvas');
    var fl = document.createElement('div');
    fl.className = 'findlayer';
    var layer = document.createElement('div');
    layer.className = 'layer';
    el.appendChild(c); el.appendChild(fl); el.appendChild(layer);
    doc.appendChild(el);
    p.el = el; p.canvas = c; p.layer = layer; p.find = fl; p.scale = 0;
    layer.addEventListener('pointerdown', onLayerDown);
    io.observe(el);
  });
  setMode(S.cont);
}

function renderPage(i){
  var p = S.pages[i];
  if (!p) return;
  var target = S.zoom * DPR;
  if (p.busy || Math.abs(p.scale - target) < 0.001) return;
  p.busy = true;
  var vp = p.pdf.getViewport({ scale:target });
  p.canvas.width = Math.floor(vp.width);
  p.canvas.height = Math.floor(vp.height);
  var ctx = p.canvas.getContext('2d', { alpha:false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, p.canvas.width, p.canvas.height);
  p.pdf.render({ canvasContext:ctx, viewport:vp }).promise.then(function(){
    p.scale = target; p.busy = false;
  }).catch(function(){ p.busy = false; });
}

function applyZoom(){
  S.pages.forEach(function(p){
    p.el.style.width = Math.round(p.vw * S.zoom) + 'px';
    p.el.style.height = Math.round(p.vh * S.zoom) + 'px';
  });
  syncAnns();
  S.pages.forEach(function(p, i){
    var r = p.el.getBoundingClientRect();
    if (r.bottom > -800 && r.top < window.innerHeight + 800) renderPage(i);
  });
}

function applyZoomMode(){
  if (!S.pages.length) return;
  var v = $('viewer');
  var p = S.pages[S.cur - 1] || S.pages[0];
  if (S.zmode === 'fitw'){
    var maxw = 0;
    S.pages.forEach(function(q){ if (q.vw > maxw) maxw = q.vw; });
    S.zoom = clamp((v.clientWidth - 32) / maxw, 0.1, 8);
  } else if (S.zmode === 'fitp'){
    S.zoom = clamp(Math.min((v.clientHeight - 26) / p.vh, (v.clientWidth - 32) / p.vw), 0.1, 8);
  } else {
    S.zoom = clamp(parseFloat(S.zmode) || 1, 0.1, 8);
  }
  applyZoom();
}

function setZoomMode(m){
  S.zmode = m;
  $('zoomsel').value = (m === 'fitw' || m === 'fitp') ? m : String(m);
  applyZoomMode();
}

function nudgeZoom(k){
  S.zmode = String(clamp(S.zoom * k, 0.1, 8));
  var sel = $('zoomsel');
  sel.value = S.zmode;
  if (sel.value !== S.zmode) sel.selectedIndex = -1;
  applyZoomMode();
}

/* ================= navigation ================= */
function setMode(cont){
  S.cont = cont;
  $('doc').classList.toggle('single', !cont);
  $('vcont').classList.toggle('on', cont);
  $('vsingle').classList.toggle('on', !cont);
  markCurrent();
  if (!cont) $('viewer').scrollTop = 0;
  applyZoomMode();
}

function markCurrent(){
  S.pages.forEach(function(p, i){ p.el.classList.toggle('cur', i === S.cur - 1); });
  $('pagebox').value = String(S.cur);
  if (!S.cont) renderPage(S.cur - 1);
  highlightHits();
}

function gotoPage(n, opts){
  if (!S.pages.length) return;
  S.cur = clamp(Math.round(n), 1, S.pages.length);
  markCurrent();
  if (S.cont){
    var el = S.pages[S.cur - 1].el;
    var v = $('viewer');
    v.scrollTop += el.getBoundingClientRect().top - v.getBoundingClientRect().top - 8;
  }
  if (opts && opts.render) renderPage(S.cur - 1);
}

function pageStep(d){
  if (!S.cont){ gotoPage(S.cur + d); return; }
  gotoPage(S.cur + d);
}

function scrollBy(dy){
  var v = $('viewer');
  if (!S.cont){
    var atEnd = v.scrollTop + v.clientHeight >= v.scrollHeight - 2;
    var atTop = v.scrollTop <= 0;
    if (dy > 0 && atEnd){ pageStep(1); v.scrollTop = 0; return; }
    if (dy < 0 && atTop){ pageStep(-1); v.scrollTop = v.scrollHeight; return; }
  }
  v.scrollTop += dy;
}

/* ================= outline ================= */
function loadOutline(){
  var tree = $('tree');
  tree.innerHTML = '';
  $('toc').disabled = true;
  if (!S.doc.getOutline) return;
  S.doc.getOutline().then(function(items){
    if (!items || !items.length) return;
    $('toc').disabled = false;
    tree.appendChild(buildTree(items));
  }).catch(function(){});
}

function buildTree(items){
  var box = document.createElement('div');
  items.forEach(function(it){
    var b = document.createElement('button');
    b.className = 'node';
    b.textContent = it.title || '(untitled)';
    b.addEventListener('click', function(){
      each('.node', function(n){ n.classList.remove('on'); });
      b.classList.add('on');
      goDest(it.dest);
    });
    box.appendChild(b);
    if (it.items && it.items.length){
      var kids = buildTree(it.items);
      kids.className = 'kids';
      box.appendChild(kids);
    }
  });
  return box;
}

function goDest(dest){
  if (!dest) return;
  var p = (typeof dest === 'string') ? S.doc.getDestination(dest) : Promise.resolve(dest);
  p.then(function(d){
    if (!d || !d[0]) return;
    return S.doc.getPageIndex(d[0]);
  }).then(function(idx){
    if (typeof idx === 'number') gotoPage(idx + 1, { render:true });
  }).catch(function(){});
}

function toggleSide(force){
  var side = $('side');
  var open = (typeof force === 'boolean') ? force : side.hidden;
  if (open && $('toc').disabled) { toast('This PDF has no bookmarks.'); return; }
  side.hidden = !open;
  $('splitter').hidden = !open;
  $('toc').classList.toggle('on', open);
  setTimeout(applyZoomMode, 0);
}

/* ================= find ================= */
function indexText(){
  if (S.find.indexed) return Promise.resolve();
  var jobs = S.pages.map(function(p){
    return p.pdf.getTextContent().then(function(tc){
      var vp = p.pdf.getViewport({ scale:1 });
      p.items = tc.items.map(function(it){
        var m = pdfjsLib.Util.transform(vp.transform, it.transform);
        var h = Math.abs(m[3]) || it.height || 10;
        return { s:it.str, x:m[4], y:m[5], w:it.width, h:h };
      }).filter(function(it){ return it.s && it.s.trim().length; });
    });
  });
  return Promise.all(jobs).then(function(){ S.find.indexed = true; });
}

function runFind(q, jump){
  q = (q || '').trim();
  var box = $('findbox');
  if (!q || !S.pages.length){
    S.find.q = ''; S.find.hits = []; S.find.i = -1;
    box.classList.remove('miss');
    $('findcount').textContent = '';
    highlightHits();
    return;
  }
  $('findcount').textContent = '\u2026';
  indexText().then(function(){
    var needle = q.toLowerCase();
    var hits = [];
    S.pages.forEach(function(p, pi){
      (p.items || []).forEach(function(it){
        var hay = it.s.toLowerCase();
        var from = 0, at;
        while ((at = hay.indexOf(needle, from)) !== -1){
          var frac = at / it.s.length;
          var wf = needle.length / it.s.length;
          hits.push({
            p:pi,
            x:(it.x + it.w * frac) / p.vw,
            y:(it.y - it.h) / p.vh,
            w:(it.w * wf) / p.vw,
            h:(it.h * 1.25) / p.vh
          });
          from = at + needle.length;
        }
      });
    });
    S.find.q = q;
    S.find.hits = hits;
    S.find.i = hits.length ? 0 : -1;
    box.classList.toggle('miss', !hits.length);
    updateFindCount();
    highlightHits();
    if (jump && hits.length) showHit(0);
  });
}

function updateFindCount(){
  var f = S.find;
  $('findcount').textContent = f.hits.length ? ((f.i + 1) + ' of ' + f.hits.length) : (f.q ? 'none' : '');
}

function highlightHits(){
  S.pages.forEach(function(p){ if (p.find) p.find.innerHTML = ''; });
  S.find.hits.forEach(function(h, i){
    var p = S.pages[h.p];
    if (!p || !p.find) return;
    var d = document.createElement('div');
    d.className = 'hit' + (i === S.find.i ? ' cur' : '');
    d.style.left = (h.x * 100) + '%';
    d.style.top = (h.y * 100) + '%';
    d.style.width = (h.w * 100) + '%';
    d.style.height = (h.h * 100) + '%';
    p.find.appendChild(d);
  });
}

function showHit(i){
  var f = S.find;
  if (!f.hits.length) return;
  f.i = (i + f.hits.length) % f.hits.length;
  var h = f.hits[f.i];
  gotoPage(h.p + 1, { render:true });
  highlightHits();
  updateFindCount();
  var p = S.pages[h.p];
  var v = $('viewer');
  var top = p.el.offsetTop + h.y * p.vh * S.zoom;
  if (S.cont) v.scrollTop = Math.max(0, top - v.clientHeight * 0.35);
  else v.scrollTop = Math.max(0, h.y * p.vh * S.zoom - v.clientHeight * 0.35);
}

function findStep(d){
  if (!S.find.hits.length){ runFind($('findbox').value, true); return; }
  showHit(S.find.i + d);
}

/* ================= annotations ================= */
function addAnn(pi, nx, ny, type){
  var p = S.pages[pi];
  var a = { id:'a' + (++S.seq), p:pi, x:nx, y:ny, type:type, color:S.ink };

  if (type === 'text' || type === 'date'){
    a.size = 0.0165;
    a.text = (type === 'date') ? new Date().toLocaleDateString() : '';
    a.y = ny - a.size * 0.6;
  } else if (type === 'check' || type === 'cross'){
    a.size = 0.026;
    a.x = nx - (a.size * p.vh) / (p.vw * 2);
    a.y = ny - a.size / 2;
  } else if (type === 'sig'){
    if (!S.sig){ openSig(); return null; }
    a.src = S.sig.src;
    a.aspect = S.sig.aspect;
    a.h = 0.048;
    a.x = nx - (a.h * p.vh * a.aspect) / p.vw / 2;
    a.y = ny - a.h / 2;
  } else {
    return null;
  }

  a.x = clamp(a.x, 0, 0.99);
  a.y = clamp(a.y, 0, 0.99);
  snapshot();
  S.anns.push(a);
  var el = buildAnn(a);
  select(a.id);
  if (type === 'text') setTimeout(function(){ el.querySelector('.bd').focus(); }, 0);
  return a;
}

function buildAnn(a){
  var wrap = document.createElement('div');
  wrap.className = 'ann ' + (a.type === 'sig' ? 'sig' : ((a.type === 'check' || a.type === 'cross') ? 'mark' : 'txt'));
  wrap.dataset.id = a.id;

  var bd = document.createElement('div');
  bd.className = 'bd';

  if (a.type === 'text' || a.type === 'date'){
    bd.contentEditable = 'true';
    bd.spellcheck = false;
    bd.textContent = a.text || '';
    bd.addEventListener('input', function(){ a.text = bd.innerText.replace(/\n$/, ''); });
    bd.addEventListener('blur', function(){ if (!String(a.text || '').trim()) removeAnn(a.id); });
    bd.addEventListener('keydown', function(e){
      if (e.key === 'Escape') bd.blur();
      e.stopPropagation();
    });
  } else if (a.type === 'sig'){
    var img = document.createElement('img');
    img.src = a.src;
    img.alt = 'Signature';
    bd.appendChild(img);
  } else {
    bd.innerHTML = '<svg viewBox="0 0 100 100" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + (a.type === 'check' ? CHECK_PATH : CROSS_PATH) + '" stroke-width="9"></path></svg>';
  }
  wrap.appendChild(bd);

  var chip = document.createElement('div');
  chip.className = 'chip';
  chip.innerHTML =
    '<button class="grip" title="Drag to move"><svg viewBox="0 0 16 16"><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></svg></button>' +
    '<div class="sep"></div>' +
    '<button class="sm" title="Smaller">\u2212</button>' +
    '<button class="bg" title="Bigger">+</button>' +
    '<div class="sep"></div>' +
    '<button class="del" title="Delete"><svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 7.5v4M9.5 7.5v4M4 4.5l.8 8.5h6.4l.8-8.5M6 4.5V2.5h4v2"/></svg></button>';
  wrap.appendChild(chip);

  function stop(e){ e.stopPropagation(); }
  var del = chip.querySelector('.del');
  var sm = chip.querySelector('.sm');
  var bg = chip.querySelector('.bg');
  del.addEventListener('pointerdown', stop);
  del.addEventListener('click', function(e){ e.stopPropagation(); removeAnn(a.id); });
  sm.addEventListener('pointerdown', stop);
  sm.addEventListener('click', function(e){ e.stopPropagation(); resize(a, 1/1.15); });
  bg.addEventListener('pointerdown', stop);
  bg.addEventListener('click', function(e){ e.stopPropagation(); resize(a, 1.15); });
  chip.querySelector('.grip').addEventListener('pointerdown', function(e){ startDrag(e, a, true); });

  wrap.addEventListener('pointerdown', function(e){ onAnnDown(e, a); });

  S.pages[a.p].layer.appendChild(wrap);
  S.els[a.id] = wrap;
  styleAnn(a);
  return wrap;
}

function styleAnn(a){
  var el = S.els[a.id];
  if (!el) return;
  var p = S.pages[a.p];
  var wpx = p.vw * S.zoom, hpx = p.vh * S.zoom;
  el.style.left = (a.x * wpx) + 'px';
  el.style.top = (a.y * hpx) + 'px';
  var bd = el.querySelector('.bd');

  if (a.type === 'text' || a.type === 'date'){
    bd.style.fontSize = (a.size * hpx) + 'px';
    bd.style.color = a.color;
    el.style.width = 'auto';
    el.style.height = 'auto';
  } else if (a.type === 'sig'){
    var h = a.h * hpx;
    el.style.height = h + 'px';
    el.style.width = (h * a.aspect) + 'px';
  } else {
    var s = a.size * hpx;
    el.style.width = s + 'px';
    el.style.height = s + 'px';
    var svg = bd.querySelector('svg');
    if (svg) svg.setAttribute('stroke', a.color);
  }
}

function syncAnns(){ S.anns.forEach(styleAnn); }

function rebuildAnns(){
  S.pages.forEach(function(p){ if (p.layer) p.layer.innerHTML = ''; });
  S.els = {};
  S.anns.forEach(buildAnn);
}

function removeAnn(id){
  var i = -1;
  for (var k = 0; k < S.anns.length; k++){ if (S.anns[k].id === id){ i = k; break; } }
  if (i < 0) return;
  snapshot();
  S.anns.splice(i, 1);
  if (S.els[id]) S.els[id].remove();
  delete S.els[id];
  if (S.sel === id) S.sel = null;
}

function resize(a, k){
  snapshot();
  if (a.type === 'sig') a.h = clamp(a.h * k, 0.012, 0.5);
  else a.size = clamp(a.size * k, 0.006, 0.3);
  styleAnn(a);
}

function select(id){
  if (S.sel && S.els[S.sel]) S.els[S.sel].classList.remove('sel');
  S.sel = id;
  if (id && S.els[id]) S.els[id].classList.add('sel');
}

/* ================= pointer ================= */
function onLayerDown(e){
  if (e.target !== e.currentTarget) return;
  select(null);
  var layer = e.currentTarget;
  var pi = +layer.parentNode.dataset.p;
  S.cur = pi + 1;
  $('pagebox').value = String(S.cur);

  if (S.tool === 'hand'){ startPan(e); return; }
  var r = layer.getBoundingClientRect();
  addAnn(pi, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, S.tool);
}

function startPan(e){
  var v = $('viewer');
  var sx = e.clientX, sy = e.clientY;
  var l = v.scrollLeft, t = v.scrollTop;
  function move(ev){
    ev.preventDefault();
    v.scrollLeft = l - (ev.clientX - sx);
    v.scrollTop = t - (ev.clientY - sy);
  }
  function up(){
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  }
  window.addEventListener('pointermove', move, { passive:false });
  window.addEventListener('pointerup', up);
}

function onAnnDown(e, a){
  var bd = S.els[a.id].querySelector('.bd');
  var editing = (a.type === 'text' || a.type === 'date') && document.activeElement === bd;
  select(a.id);
  if (editing) return;
  startDrag(e, a, false);
}

function startDrag(e, a, force){
  e.stopPropagation();
  var el = S.els[a.id];
  var r = S.pages[a.p].layer.getBoundingClientRect();
  var sx = e.clientX, sy = e.clientY;
  var ox = a.x, oy = a.y;
  var moved = false;

  function move(ev){
    var dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    if (!moved){ moved = true; snapshot(); el.style.cursor = 'grabbing'; }
    ev.preventDefault();
    a.x = clamp(ox + dx / r.width, -0.02, 1);
    a.y = clamp(oy + dy / r.height, -0.02, 1);
    styleAnn(a);
  }
  function up(ev){
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    el.style.cursor = '';
    if (!moved && !force && (a.type === 'text' || a.type === 'date')){
      var bd = el.querySelector('.bd');
      bd.focus();
      placeCaret(bd, ev.clientX, ev.clientY);
    }
  }
  window.addEventListener('pointermove', move, { passive:false });
  window.addEventListener('pointerup', up);
}

function placeCaret(el, x, y){
  try {
    var range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint){
      var pos = document.caretPositionFromPoint(x, y);
      if (pos){ range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    }
    if (range){
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch(err){}
}

/* ================= signature ================= */
var SIG_FONTS = [
  { css:"'Caveat', cursive", size:64 },
  { css:"'Dancing Script', cursive", size:60 },
  { css:"'Homemade Apple', cursive", size:44 },
  { css:"'Sacramento', cursive", size:66 }
];
var sigDraft = null, typedFont = 0;
var pad, pctx, drawing = false, hasInk = false, lastPt = null;

function openSig(){
  $('scrim').classList.add('open');
  paintFontOptions();
  setTimeout(function(){ setupPad(); updateSigReady(); }, 30);
}
function closeSig(){ $('scrim').classList.remove('open'); }

function tab(name){
  each('#tabs button', function(b){ b.classList.toggle('on', b.dataset.tab === name); });
  each('.pane', function(p){ p.classList.toggle('on', p.dataset.pane === name); });
  sigDraft = null;
  if (name === 'draw') setupPad();
  if (name === 'type') makeTyped();
  updateSigReady();
}

function setupPad(){
  pad = $('pad');
  var r = pad.getBoundingClientRect();
  if (!r.width) return;
  pad.width = Math.floor(r.width * 2);
  pad.height = Math.floor(r.height * 2);
  pctx = pad.getContext('2d');
  pctx.scale(2, 2);
  pctx.lineCap = 'round';
  pctx.lineJoin = 'round';
  pctx.strokeStyle = S.ink;
  pctx.lineWidth = 2.6;
  hasInk = false;
}

function padPt(e){
  var r = pad.getBoundingClientRect();
  return { x:e.clientX - r.left, y:e.clientY - r.top };
}
function padDown(e){
  if (!pctx) setupPad();
  if (!pctx) return;
  e.preventDefault();
  drawing = true; hasInk = true;
  lastPt = padPt(e);
  pctx.strokeStyle = S.ink;
  pctx.beginPath();
  pctx.moveTo(lastPt.x, lastPt.y);
  pctx.lineTo(lastPt.x + 0.01, lastPt.y);
  pctx.stroke();
  try { pad.setPointerCapture(e.pointerId); } catch(err){}
  updateSigReady();
}
function padMove(e){
  if (!drawing) return;
  e.preventDefault();
  var p = padPt(e);
  var mid = { x:(lastPt.x + p.x)/2, y:(lastPt.y + p.y)/2 };
  pctx.beginPath();
  pctx.moveTo(lastPt.x, lastPt.y);
  pctx.quadraticCurveTo(lastPt.x, lastPt.y, mid.x, mid.y);
  pctx.stroke();
  lastPt = p;
}
function padUp(){ drawing = false; }

function trim(canvas){
  var w = canvas.width, h = canvas.height;
  var d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  var x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (var y = 0; y < h; y++){
    for (var x = 0; x < w; x++){
      if (d[(y * w + x) * 4 + 3] > 8){
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  var m = 6;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  var out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function paintFontOptions(){
  var box = $('fonts');
  if (box.childNodes.length) return;
  SIG_FONTS.forEach(function(f, i){
    var b = document.createElement('button');
    b.className = 'fopt' + (i === 0 ? ' on' : '');
    b.innerHTML = '<span style="font-family:' + f.css + '">Signature</span>';
    b.addEventListener('click', function(){
      typedFont = i;
      for (var j = 0; j < box.children.length; j++) box.children[j].classList.toggle('on', i === j);
      makeTyped();
    });
    box.appendChild(b);
  });
}

function makeTyped(){
  var text = $('typed').value.trim();
  var box = $('fonts');
  for (var i = 0; i < box.children.length; i++){
    var s = box.children[i].querySelector('span');
    s.textContent = text || 'Signature';
    s.style.fontFamily = SIG_FONTS[i].css;
  }
  if (!text){ sigDraft = null; updateSigReady(); return; }
  var f = SIG_FONTS[typedFont];
  var size = f.size * 3;
  var c = document.createElement('canvas');
  var ctx = c.getContext('2d');
  ctx.font = size + 'px ' + f.css;
  c.width = Math.max(80, Math.ceil(ctx.measureText(text).width) + 40);
  c.height = Math.ceil(size * 1.8);
  ctx = c.getContext('2d');
  ctx.font = size + 'px ' + f.css;
  ctx.fillStyle = S.ink;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 20, c.height * 0.68);
  var t = trim(c);
  sigDraft = t ? { canvas:t } : null;
  updateSigReady();
}

function loadSigImage(file){
  var url = URL.createObjectURL(file);
  var img = new Image();
  img.onload = function(){
    var k = Math.min(1, 1400 / img.width);
    var c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    var im = ctx.getImageData(0, 0, c.width, c.height);
    var d = im.data;
    for (var i = 0; i < d.length; i += 4){
      var lum = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
      if (lum > 232) d[i+3] = 0;
      else if (lum > 170) d[i+3] = Math.round(d[i+3] * (232 - lum) / 62);
    }
    ctx.putImageData(im, 0, 0);
    var t = trim(c) || c;
    sigDraft = { canvas:t };
    var prev = $('uprev');
    prev.innerHTML = '';
    var pi = new Image();
    pi.src = t.toDataURL('image/png');
    prev.appendChild(pi);
    URL.revokeObjectURL(url);
    updateSigReady();
  };
  img.onerror = function(){ toast('Could not read that image.'); };
  img.src = url;
}

function updateSigReady(){
  var active = document.querySelector('.pane.on');
  var name = active ? active.dataset.pane : 'draw';
  $('siguse').disabled = (name === 'draw') ? !hasInk : !sigDraft;
}

function useSignature(){
  var active = document.querySelector('.pane.on').dataset.pane;
  var canvas = (active === 'draw') ? trim(pad) : (sigDraft ? sigDraft.canvas : null);
  if (!canvas){ toast('Nothing to save yet.'); return; }
  S.sig = { src:canvas.toDataURL('image/png'), aspect:canvas.width / canvas.height };
  var icon = $('sigicon');
  icon.innerHTML = '';
  var thumb = new Image();
  thumb.src = S.sig.src;
  thumb.className = 'sigthumb';
  icon.appendChild(thumb);
  $('editsig').hidden = false;
  closeSig();
  setTool('sig');
  toast('Click where the signature goes.');
}

/* ================= save ================= */
function sanitize(s){
  return String(s)
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '');
}

function save(){
  if (!S.bytes) return;
  var btn = $('dl');
  var label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';

  var PDFDocument = PDFLIB.PDFDocument;
  var StandardFonts = PDFLIB.StandardFonts;
  var degrees = PDFLIB.degrees;
  var LineCapStyle = PDFLIB.LineCapStyle;

  PDFDocument.load(S.bytes, { ignoreEncryption:true }).then(function(pdf){
    return pdf.embedFont(StandardFonts.Helvetica).then(function(font){
      var pages = pdf.getPages();
      var imgs = {};
      var chain = Promise.resolve();

      S.anns.forEach(function(a){
        chain = chain.then(function(){
          var page = pages[a.p];
          if (!page) return null;
          var sz = page.getSize();
          var W = sz.width, H = sz.height;
          var rot = ((page.getRotation().angle % 360) + 360) % 360;
          var flip = (rot === 90 || rot === 270);
          var Wd = flip ? H : W;
          var Hd = flip ? W : H;

          function toUser(xd, yd){
            if (rot === 90) return { x:yd, y:xd };
            if (rot === 180) return { x:W - xd, y:yd };
            if (rot === 270) return { x:W - yd, y:H - xd };
            return { x:xd, y:H - yd };
          }

          var xd = a.x * Wd, yd = a.y * Hd;
          var col = hexToRgb(a.color);

          if (a.type === 'text' || a.type === 'date'){
            var F = a.size * Hd;
            String(a.text || '').split('\n').forEach(function(line, li){
              var clean = sanitize(line);
              if (!clean) return;
              var pt = toUser(xd, yd + F * 0.94 + li * F * 1.2);
              try {
                page.drawText(clean, { x:pt.x, y:pt.y, size:F, font:font, color:col, rotate:degrees(rot) });
              } catch(err){ console.warn('skipped a line', err); }
            });
            return null;
          }

          if (a.type === 'check' || a.type === 'cross'){
            var s = a.size * Hd;
            var p0 = toUser(xd, yd);
            page.drawSvgPath(a.type === 'check' ? CHECK_PATH : CROSS_PATH, {
              x:p0.x, y:p0.y, scale:s / 100,
              borderColor:col, borderWidth:9,
              borderLineCap:LineCapStyle.Round,
              rotate:degrees(rot)
            });
            return null;
          }

          if (a.type === 'sig'){
            var pending = imgs[a.src]
              ? Promise.resolve(imgs[a.src])
              : pdf.embedPng(a.src).then(function(im){ imgs[a.src] = im; return im; });
            return pending.then(function(im){
              var h = a.h * Hd;
              var w = h * a.aspect;
              var pt2 = toUser(xd, yd + h);
              page.drawImage(im, { x:pt2.x, y:pt2.y, width:w, height:h, rotate:degrees(rot) });
            });
          }
          return null;
        });
      });

      return chain.then(function(){ return pdf.save(); });
    });
  }).then(function(out){
    var blob = new Blob([out], { type:'application/pdf' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = S.name.replace(/\.pdf$/i, '') + ' (signed).pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
    toast('Saved.');
  }).catch(function(err){
    console.error(err);
    toast('Could not write the PDF. ' + ((err && err.message) ? err.message : ''));
  }).then(function(){
    btn.disabled = false;
    btn.innerHTML = label;
  });
}

/* ================= tools ================= */
function setTool(t){
  if (t === 'sig' && !S.sig){ openSig(); return; }
  S.tool = t;
  each('.tool', function(b){ b.classList.toggle('on', b.dataset.tool === t); });
  $('viewer').classList.toggle('hand', t === 'hand');
}

function togglePresent(){
  var on = !document.body.classList.contains('present');
  document.body.classList.toggle('present', on);
  if (on){
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function(){});
    setMode(false);
    setZoomMode('fitp');
  } else {
    if (document.exitFullscreen && document.fullscreenElement) document.exitFullscreen().catch(function(){});
    setMode(true);
    setZoomMode('fitw');
  }
}

/* ================= wiring ================= */
each('.tool', function(b){ b.addEventListener('click', function(){ setTool(b.dataset.tool); }); });
each('.swatch', function(b){
  b.addEventListener('click', function(){
    S.ink = b.dataset.ink;
    each('.swatch', function(x){ x.classList.remove('on'); });
    b.classList.add('on');
  });
});
each('#tabs button', function(b){ b.addEventListener('click', function(){ tab(b.dataset.tab); }); });

$('editsig').addEventListener('click', openSig);
$('openbtn').addEventListener('click', function(){ $('file').click(); });
$('pick').addEventListener('click', function(){ $('file').click(); });
$('file').addEventListener('change', function(e){
  if (e.target.files && e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('upick').addEventListener('click', function(){ $('ufile').click(); });
$('ufile').addEventListener('change', function(e){
  if (e.target.files && e.target.files[0]) loadSigImage(e.target.files[0]);
  e.target.value = '';
});

$('dl').addEventListener('click', save);
$('zin').addEventListener('click', function(){ nudgeZoom(1.2); });
$('zout').addEventListener('click', function(){ nudgeZoom(1/1.2); });
$('zoomsel').addEventListener('change', function(e){ setZoomMode(e.target.value); });
$('prev').addEventListener('click', function(){ pageStep(-1); });
$('next').addEventListener('click', function(){ pageStep(1); });
$('pagebox').addEventListener('keydown', function(e){
  e.stopPropagation();
  if (e.key === 'Enter'){
    var n = parseInt($('pagebox').value, 10);
    if (n) gotoPage(n, { render:true });
    $('pagebox').blur();
  }
});
$('vcont').addEventListener('click', function(){ setMode(true); });
$('vsingle').addEventListener('click', function(){ setMode(false); });
$('toc').addEventListener('click', function(){ toggleSide(); });

var findT;
$('findbox').addEventListener('input', function(e){
  clearTimeout(findT);
  var v = e.target.value;
  findT = setTimeout(function(){ runFind(v, true); }, 220);
});
$('findbox').addEventListener('keydown', function(e){
  e.stopPropagation();
  if (e.key === 'Enter'){ e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape'){ e.target.value = ''; runFind('', false); e.target.blur(); }
});
$('findnext').addEventListener('click', function(){ findStep(1); });
$('findprev').addEventListener('click', function(){ findStep(-1); });

$('scrim').addEventListener('pointerdown', function(e){ if (e.target === $('scrim')) closeSig(); });
$('sigcancel').addEventListener('click', closeSig);
$('siguse').addEventListener('click', useSignature);
$('padclear').addEventListener('click', function(){ setupPad(); updateSigReady(); });
$('typed').addEventListener('input', makeTyped);
$('typed').addEventListener('keydown', function(e){ e.stopPropagation(); });
$('pad').addEventListener('pointerdown', padDown);
$('pad').addEventListener('pointermove', padMove);
$('pad').addEventListener('pointerup', padUp);
$('pad').addEventListener('pointercancel', padUp);

/* splitter */
$('splitter').addEventListener('pointerdown', function(e){
  e.preventDefault();
  function move(ev){
    var w = clamp(ev.clientX, 120, window.innerWidth * 0.6);
    $('side').style.width = w + 'px';
  }
  function up(){
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    applyZoomMode();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

/* drag & drop */
['dragenter', 'dragover'].forEach(function(t){
  window.addEventListener(t, function(e){ e.preventDefault(); document.body.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach(function(t){
  window.addEventListener(t, function(e){ e.preventDefault(); document.body.classList.remove('dragover'); });
});
window.addEventListener('drop', function(e){
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});

/* ================= keyboard (Sumatra-flavoured) ================= */
var TOOLKEYS = { '1':'text', '2':'check', '3':'cross', '4':'date', '5':'sig' };

window.addEventListener('keydown', function(e){
  var ae = document.activeElement;
  if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) return;

  var k = e.key;
  var ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && k.toLowerCase() === 'o'){ e.preventDefault(); $('file').click(); return; }
  if (ctrl && k.toLowerCase() === 's'){ e.preventDefault(); if (!$('dl').disabled) save(); return; }
  if (ctrl && k.toLowerCase() === 'z'){ e.preventDefault(); undo(); return; }
  if (ctrl && k.toLowerCase() === 'f'){ e.preventDefault(); $('findbox').focus(); $('findbox').select(); return; }
  if (ctrl && k.toLowerCase() === 'g'){ e.preventDefault(); $('pagebox').focus(); $('pagebox').select(); return; }
  if (ctrl) return;

  if (k === 'Escape'){
    if ($('scrim').classList.contains('open')) closeSig();
    else if (document.body.classList.contains('present')) togglePresent();
    else select(null);
    return;
  }
  if (k === 'F11'){ e.preventDefault(); togglePresent(); return; }
  if (k === 'F12'){ e.preventDefault(); toggleSide(); return; }
  if (k === 'F3'){ e.preventDefault(); findStep(e.shiftKey ? -1 : 1); return; }
  if (!S.doc) return;

  if ((k === 'Backspace' || k === 'Delete') && S.sel){ e.preventDefault(); removeAnn(S.sel); return; }

  switch (k){
    case 'j': case 'ArrowDown': e.preventDefault(); scrollBy(60); return;
    case 'k': case 'ArrowUp': e.preventDefault(); scrollBy(-60); return;
    case 'ArrowRight': e.preventDefault(); scrollBy(60); return;
    case 'ArrowLeft': e.preventDefault(); scrollBy(-60); return;
    case 'n': case 'PageDown': e.preventDefault(); pageStep(1); return;
    case 'p': case 'PageUp': case 'Backspace': e.preventDefault(); pageStep(-1); return;
    case ' ': e.preventDefault(); scrollBy($('viewer').clientHeight - 40); return;
    case 'Home': e.preventDefault(); gotoPage(1, { render:true }); $('viewer').scrollTop = 0; return;
    case 'End': e.preventDefault(); gotoPage(S.pages.length, { render:true }); return;
    case '+': case '=': e.preventDefault(); nudgeZoom(1.2); return;
    case '-': e.preventDefault(); nudgeZoom(1/1.2); return;
    case 'c': e.preventDefault(); setMode(!S.cont); return;
    case 'w': e.preventDefault(); setZoomMode('fitw'); return;
    case 'z': e.preventDefault(); setZoomMode(S.zmode === 'fitp' ? 'fitw' : 'fitp'); return;
    case 'h': e.preventDefault(); setTool('hand'); return;
    case '/': e.preventDefault(); $('findbox').focus(); return;
  }
  if (TOOLKEYS[k]){ e.preventDefault(); setTool(TOOLKEYS[k]); }
});

/* ================= scroll & resize ================= */
var rafPending = false;
$('viewer').addEventListener('scroll', function(){
  if (rafPending || !S.cont || !S.pages.length) return;
  rafPending = true;
  requestAnimationFrame(function(){
    rafPending = false;
    var mid = $('viewer').getBoundingClientRect().top + 100;
    var cur = 1;
    for (var i = 0; i < S.pages.length; i++){
      if (S.pages[i].el.getBoundingClientRect().top <= mid) cur = i + 1;
    }
    if (cur !== S.cur){
      S.cur = cur;
      $('pagebox').value = String(cur);
      S.pages.forEach(function(p, j){ p.el.classList.toggle('cur', j === cur - 1); });
    }
  });
});

var rt;
window.addEventListener('resize', function(){
  clearTimeout(rt);
  rt = setTimeout(function(){ if (S.pages.length) applyZoomMode(); }, 140);
});

document.addEventListener('fullscreenchange', function(){
  if (!document.fullscreenElement && document.body.classList.contains('present')) togglePresent();
});

setTool('text');

})();
