(function(){
'use strict';

var $ = function(id){ return document.getElementById(id); };

/* ---------------- toast ---------------- */
var toastT;
function toast(msg){
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(function(){ t.classList.remove('on'); }, 2800);
}

/* ---------------- library guard ---------------- */
if (typeof window.pdfjsLib === 'undefined' || typeof window.PDFLib === 'undefined'){
  var d = $('drop');
  if (d){
    d.innerHTML = '<h1>Something is blocking Inkwell</h1>' +
      '<p>The PDF engine could not load. This usually means an extension or network policy is blocking cdnjs.cloudflare.com. Allow it and reload.</p>';
  }
  return;
}

var PDFLIB = window.PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

var DPR = Math.min(window.devicePixelRatio || 1, 2);

var S = {
  bytes:null, name:'document.pdf', doc:null, pages:[],
  zoom:1, fit:true, tool:'text', ink:'#16325c',
  anns:[], els:{}, sel:null, sig:null, hist:[], seq:0
};

var CHECK_PATH = 'M 12 54 L 40 82 L 88 16';
var CROSS_PATH = 'M 16 16 L 84 84 M 84 16 L 16 84';

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function snapshot(){
  S.hist.push(JSON.stringify(S.anns));
  if (S.hist.length > 60) S.hist.shift();
}

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

/* ---------------- opening ---------------- */
function openFile(file){
  if (!file) return;
  var isPdf = (file.type && file.type.indexOf('pdf') !== -1) || /\.pdf$/i.test(file.name || '');
  if (!isPdf){ toast('That is not a PDF.'); return; }
  var fr = new FileReader();
  fr.onload = function(){
    var buf = fr.result;
    S.bytes = new Uint8Array(buf);
    S.name = file.name || 'document.pdf';
    S.anns = []; S.els = {}; S.sel = null; S.hist = [];
    load(new Uint8Array(buf.slice(0)));
  };
  fr.onerror = function(){ toast('Could not read that file.'); };
  fr.readAsArrayBuffer(file);
}

function load(data){
  $('fname').textContent = 'Opening\u2026';
  pdfjsLib.getDocument({ data:data }).promise.then(function(doc){
    S.doc = doc;
    var jobs = [];
    for (var i = 1; i <= doc.numPages; i++) jobs.push(doc.getPage(i));
    return Promise.all(jobs);
  }).then(function(pages){
    S.pages = pages.map(function(p){
      var vp = p.getViewport({ scale:1 });
      return { pdf:p, vw:vp.width, vh:vp.height, el:null, canvas:null, layer:null, scale:0, busy:false };
    });
    buildDoc();
    $('fname').textContent = S.name;
    $('empty').classList.add('hidden');
    $('viewer').classList.remove('hidden');
    $('rail').classList.remove('hidden');
    $('dl').disabled = false;
    $('pageno').textContent = 'Page 1 of ' + S.pages.length;
    fitWidth();
    toast('Click anywhere on the page to type.');
  }).catch(function(err){
    console.error(err);
    $('fname').textContent = 'No file open';
    toast('That PDF could not be opened.');
  });
}

/* ---------------- layout & rendering ---------------- */
var io = new IntersectionObserver(function(entries){
  entries.forEach(function(e){
    if (e.isIntersecting) renderPage(+e.target.dataset.p);
  });
}, { root:$('viewer'), rootMargin:'700px 0px' });

function buildDoc(){
  var doc = $('doc');
  doc.innerHTML = '';
  io.disconnect();
  S.pages.forEach(function(p, i){
    var el = document.createElement('div');
    el.className = 'page';
    el.dataset.p = i;
    var c = document.createElement('canvas');
    var layer = document.createElement('div');
    layer.className = 'layer';
    el.appendChild(c);
    el.appendChild(layer);
    doc.appendChild(el);
    p.el = el; p.canvas = c; p.layer = layer; p.scale = 0;
    layer.addEventListener('pointerdown', onLayerDown);
    io.observe(el);
  });
}

function applyZoom(){
  S.pages.forEach(function(p){
    p.el.style.width = Math.round(p.vw * S.zoom) + 'px';
    p.el.style.height = Math.round(p.vh * S.zoom) + 'px';
  });
  $('pct').textContent = Math.round(S.zoom * 100) + '%';
  syncAnns();
  S.pages.forEach(function(p, i){
    var r = p.el.getBoundingClientRect();
    if (r.bottom > -700 && r.top < window.innerHeight + 700) renderPage(i);
  });
}

function fitWidth(){
  var w = $('viewer').clientWidth - 48;
  var maxw = 0;
  S.pages.forEach(function(p){ if (p.vw > maxw) maxw = p.vw; });
  if (!maxw) return;
  S.fit = true;
  S.zoom = clamp(w / maxw, 0.15, 4);
  applyZoom();
}

function setZoom(z){
  S.fit = false;
  S.zoom = clamp(z, 0.15, 4);
  applyZoom();
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
    p.scale = target;
    p.busy = false;
  }).catch(function(){ p.busy = false; });
}

/* ---------------- annotations ---------------- */
function addAnn(pageIndex, nx, ny, type){
  var p = S.pages[pageIndex];
  var a = { id:'a' + (++S.seq), p:pageIndex, x:nx, y:ny, type:type, color:S.ink };

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
  if (type === 'text'){
    var bd = el.querySelector('.bd');
    setTimeout(function(){ bd.focus(); }, 0);
  }
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
    bd.addEventListener('blur', function(){
      if (!String(a.text || '').trim()) removeAnn(a.id);
    });
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
    bd.innerHTML = '<svg viewBox="0 0 100 100" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + (a.type === 'check' ? CHECK_PATH : CROSS_PATH) + '" stroke-width="9"></path></svg>';
  }
  wrap.appendChild(bd);

  var chip = document.createElement('div');
  chip.className = 'chip';
  chip.innerHTML =
    '<button class="grip" title="Drag to move" aria-label="Drag to move"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>' +
    '<div class="sep"></div>' +
    '<button class="sm" title="Smaller" aria-label="Smaller">\u2212</button>' +
    '<button class="bg" title="Bigger" aria-label="Bigger">+</button>' +
    '<div class="sep"></div>' +
    '<button class="del" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg></button>';
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

/* ---------------- pointer interaction ---------------- */
function onLayerDown(e){
  if (e.target !== e.currentTarget) return;
  select(null);
  var layer = e.currentTarget;
  var p = +layer.parentNode.dataset.p;
  var r = layer.getBoundingClientRect();
  addAnn(p, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, S.tool);
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
    if (document.caretRangeFromPoint){
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint){
      var pos = document.caretPositionFromPoint(x, y);
      if (pos){
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (range){
      range.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch(err){ /* caret placement is a nicety */ }
}

/* ---------------- signature ---------------- */
var SIG_FONTS = [
  { css:"'Caveat', cursive", size:64 },
  { css:"'Dancing Script', cursive", size:60 },
  { css:"'Homemade Apple', cursive", size:44 },
  { css:"'Sacramento', cursive", size:66 }
];
var sigDraft = null;
var typedFont = 0;
var pad, pctx, drawing = false, hasInk = false, lastPt = null;

function openSig(){
  $('scrim').classList.add('open');
  paintFontOptions();
  setTimeout(function(){ setupPad(); updateSigReady(); }, 30);
}
function closeSig(){ $('scrim').classList.remove('open'); }

function tab(name){
  var i;
  var tabs = document.querySelectorAll('#tabs button');
  for (i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].dataset.tab === name);
  var panes = document.querySelectorAll('.pane');
  for (i = 0; i < panes.length; i++) panes[i].classList.toggle('on', panes[i].dataset.pane === name);
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
  drawing = true;
  hasInk = true;
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
      var lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
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
  var ok = (name === 'draw') ? hasInk : !!sigDraft;
  $('siguse').disabled = !ok;
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
  $('editsig').classList.remove('hidden');
  closeSig();
  setTool('sig');
  toast('Click where the signature goes.');
}

/* ---------------- export ---------------- */
function sanitize(s){
  return String(s)
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '');
}

function download(){
  if (!S.bytes) return;
  var btn = $('dl');
  var label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Preparing\u2026';

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

          var xd = a.x * Wd;
          var yd = a.y * Hd;
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
    toast('Downloaded.');
  }).catch(function(err){
    console.error(err);
    toast('Could not write the PDF. ' + ((err && err.message) ? err.message : ''));
  }).then(function(){
    btn.disabled = false;
    btn.innerHTML = label;
  });
}

/* ---------------- tools & wiring ---------------- */
function setTool(t){
  if (t === 'sig' && !S.sig){ openSig(); return; }
  S.tool = t;
  var tools = document.querySelectorAll('.tool[data-tool]');
  for (var i = 0; i < tools.length; i++) tools[i].classList.toggle('on', tools[i].dataset.tool === t);
}

function each(sel, fn){
  var n = document.querySelectorAll(sel);
  for (var i = 0; i < n.length; i++) fn(n[i]);
}

each('.tool[data-tool]', function(b){
  b.addEventListener('click', function(){ setTool(b.dataset.tool); });
});

each('.swatch', function(b){
  b.addEventListener('click', function(){
    S.ink = b.dataset.ink;
    each('.swatch', function(x){ x.classList.remove('on'); });
    b.classList.add('on');
  });
});

each('#tabs button', function(b){
  b.addEventListener('click', function(){ tab(b.dataset.tab); });
});

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

$('dl').addEventListener('click', download);
$('zin').addEventListener('click', function(){ setZoom(S.zoom * 1.2); });
$('zout').addEventListener('click', function(){ setZoom(S.zoom / 1.2); });
$('zfit').addEventListener('click', fitWidth);

$('scrim').addEventListener('pointerdown', function(e){ if (e.target === $('scrim')) closeSig(); });
$('sigcancel').addEventListener('click', closeSig);
$('siguse').addEventListener('click', useSignature);
$('padclear').addEventListener('click', function(){ setupPad(); updateSigReady(); });
$('typed').addEventListener('input', makeTyped);
$('pad').addEventListener('pointerdown', padDown);
$('pad').addEventListener('pointermove', padMove);
$('pad').addEventListener('pointerup', padUp);
$('pad').addEventListener('pointercancel', padUp);

/* drag & drop anywhere */
['dragenter', 'dragover'].forEach(function(t){
  window.addEventListener(t, function(e){
    e.preventDefault();
    $('drop').classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(function(t){
  window.addEventListener(t, function(e){
    e.preventDefault();
    $('drop').classList.remove('dragover');
  });
});
window.addEventListener('drop', function(e){
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});

/* keyboard */
var KEYS = { t:'text', c:'check', x:'cross', d:'date', s:'sig' };
window.addEventListener('keydown', function(e){
  var ae = document.activeElement;
  var editing = ae && (ae.isContentEditable || ae.tagName === 'INPUT');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !editing){ e.preventDefault(); undo(); return; }
  if (e.key === 'Escape'){
    if ($('scrim').classList.contains('open')) closeSig();
    else select(null);
    return;
  }
  if (editing) return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && S.sel){ e.preventDefault(); removeAnn(S.sel); return; }
  var k = KEYS[e.key.toLowerCase()];
  if (k && !e.metaKey && !e.ctrlKey && S.doc) setTool(k);
});

/* page indicator */
var rafPending = false;
$('viewer').addEventListener('scroll', function(){
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(function(){
    rafPending = false;
    if (!S.pages.length) return;
    var mid = $('viewer').getBoundingClientRect().top + 120;
    var cur = 1;
    for (var i = 0; i < S.pages.length; i++){
      if (S.pages[i].el.getBoundingClientRect().top <= mid) cur = i + 1;
    }
    $('pageno').textContent = 'Page ' + cur + ' of ' + S.pages.length;
  });
});

/* resize */
var rt;
window.addEventListener('resize', function(){
  clearTimeout(rt);
  rt = setTimeout(function(){
    if (!S.pages.length) return;
    if (S.fit) fitWidth(); else applyZoom();
  }, 140);
});

})();
