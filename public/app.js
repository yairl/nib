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
  if (dz) dz.innerHTML = '<h1>Blocked</h1><p>The PDF engine could not load. A browser extension or setting is blocking scripts on this page. Allow it and reload.</p>';
  return;
}

var PDFLIB = window.PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
// One shared worker for the whole session: prewarms the 1MB worker script during
// page idle and is reused by every getDocument, so opens don't each spin up (and
// re-fetch) a fresh worker.
var PDFWORKER = null;
try { PDFWORKER = new pdfjsLib.PDFWorker({ name: 'inkwell-pdf-worker' }); } catch (e) { PDFWORKER = null; }

var DPR = Math.min(window.devicePixelRatio || 1, 2);

var PERF = /perf/.test(location.search) || /perf/.test(location.hash);
function perfPanel(){
  var d = document.getElementById('perfpanel');
  if (!d){
    d = document.createElement('div');
    d.id = 'perfpanel';
    d.innerHTML = '<b>Perf timing — load a PDF</b>';
    (document.body || document.documentElement).appendChild(d);
  }
  return d;
}
function perfReset(){ var d = document.getElementById('perfpanel'); if (d) d.innerHTML = '<b>Perf timing</b>'; }
function plog(){
  if (!PERF) return;
  var args = [].slice.call(arguments);
  try { console.info.apply(console, ['[perf]'].concat(args)); } catch(e){}
  var line = document.createElement('div');
  line.textContent = args.join(' ');
  perfPanel().appendChild(line);
}
if (PERF){ if (document.readyState !== 'loading') perfPanel(); else document.addEventListener('DOMContentLoaded', perfPanel); }

var S = {
  bytes:null, name:'document.pdf', doc:null, pages:[],
  zoom:1, zmode:'fitw', cont:true, cur:1,
  tool:'text', ink:'#16325c',
  anns:[], els:{}, sel:null, sig:null, hist:[], seq:0,
  fields:[],
  find:{ q:'', hits:[], i:-1, indexed:false },
  printUrl:null,
  user:null, saved:[], profile:null
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
  var tRead = performance.now();
  var fr = new FileReader();
  fr.onload = function(){
    plog('file read', (performance.now() - tRead).toFixed(0) + 'ms', (file.size / 1024).toFixed(0) + 'KB');
    var buf = fr.result;
    S.bytes = new Uint8Array(buf);
    S.name = file.name || 'document.pdf';
    S.anns = []; S.els = {}; S.sel = null; S.hist = []; S.fields = [];
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
  var tOpen = performance.now();
  perfReset();
  renderPage._logged = false;
  renderText._logged = false;
  window.__perfOpen = tOpen;
  var tDoc = performance.now();
  pdfjsLib.getDocument({ data:data, worker:PDFWORKER || undefined }).promise.then(function(doc){
    plog('getDocument (parse structure)', (performance.now() - tDoc).toFixed(0) + 'ms', doc.numPages + ' pages');
    S.doc = doc;
    var tPages = performance.now();
    var jobs = [];
    for (var i = 1; i <= doc.numPages; i++) jobs.push(doc.getPage(i));
    return Promise.all(jobs).then(function(pages){
      plog('getPage x' + pages.length + ' (metadata)', (performance.now() - tPages).toFixed(0) + 'ms');
      return pages;
    });
  }).then(function(pages){
    S.pages = pages.map(function(p){
      var vp = p.getViewport({ scale:1 });
      return {
        pdf:p, vw:vp.width, vh:vp.height,
        el:null, canvas:null, layer:null, find:null, text:null,
        scale:0, tscale:0, busy:false, ttask:null, tc:null, items:null
      };
    });
    buildDoc();
    loadFields();
    document.title = S.name + ' - Inkwell';
    $('empty').hidden = true;
    $('dl').disabled = false;
    $('printbtn').disabled = false;
    $('mergebtn').disabled = false;
    $('splitbtn').disabled = false;
    $('reducebtn').disabled = false;
    $('pagecount').textContent = 'of ' + S.pages.length;
    S.cur = 1;
    $('pagebox').value = '1';
    applyZoomMode();
    loadOutline();
    toast('Click the page to type. V to select text, H to pan.');
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
    var tl = document.createElement('div');
    tl.className = 'textlayer';
    var layer = document.createElement('div');
    layer.className = 'layer';
    var fields = document.createElement('div');
    fields.className = 'fieldlayer';

    el.appendChild(c);
    el.appendChild(fl);
    el.appendChild(tl);
    el.appendChild(layer);
    el.appendChild(fields);
    doc.appendChild(el);

    p.el = el; p.canvas = c; p.layer = layer; p.find = fl; p.text = tl; p.fields = fields;
    p.scale = 0; p.tscale = 0;
    layer.addEventListener('pointerdown', onLayerDown);
    io.observe(el);
  });
  setMode(S.cont);
}

function renderPage(i){
  var p = S.pages[i];
  if (!p) return;
  renderText(i);
  var target = S.zoom * DPR;
  if (p.busy || Math.abs(p.scale - target) < 0.001) return;
  p.busy = true;
  var vp = p.pdf.getViewport({ scale:target });
  p.canvas.width = Math.floor(vp.width);
  p.canvas.height = Math.floor(vp.height);
  var ctx = p.canvas.getContext('2d', { alpha:false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, p.canvas.width, p.canvas.height);
  var tRender = performance.now();
  p.pdf.render({ canvasContext:ctx, viewport:vp }).promise.then(function(){
    p.scale = target; p.busy = false;
    if (!renderPage._logged){
      renderPage._logged = true;
      plog('first page canvas render', (performance.now() - tRender).toFixed(0) + 'ms');
      if (window.__perfOpen) plog('=> total open to first page painted', (performance.now() - window.__perfOpen).toFixed(0) + 'ms');
    }
  }).catch(function(){ p.busy = false; });
}

function renderText(i){
  var p = S.pages[i];
  if (!p || !p.text) return;
  if (Math.abs(p.tscale - S.zoom) < 0.001) return;
  p.tscale = S.zoom;

  if (p.ttask && p.ttask.cancel){ try { p.ttask.cancel(); } catch(e){} }

  var vp = p.pdf.getViewport({ scale:S.zoom });
  p.el.style.setProperty('--scale-factor', String(S.zoom));
  p.text.style.setProperty('--scale-factor', String(S.zoom));

  var tText = performance.now();
  var src = p.tc ? Promise.resolve(p.tc) : p.pdf.getTextContent().then(function(tc){ p.tc = tc; return tc; });
  src.then(function(tc){
    if (!renderText._logged){ renderText._logged = true; plog('first page getTextContent', (performance.now() - tText).toFixed(0) + 'ms', (tc.items ? tc.items.length : 0) + ' items'); }
    if (Math.abs(p.tscale - S.zoom) > 0.001) return;
    p.text.innerHTML = '';
    p.text.style.setProperty('--scale-factor', String(S.zoom));
    var opts = { container:p.text, viewport:vp, textDivs:[] };
    opts.textContentSource = tc;
    opts.textContent = tc;
    var task = pdfjsLib.renderTextLayer(opts);
    p.ttask = task;
    if (task && task.promise) task.promise.catch(function(){});
  }).catch(function(){});
}

function applyZoom(){
  S.pages.forEach(function(p){
    p.el.style.width = Math.round(p.vw * S.zoom) + 'px';
    p.el.style.height = Math.round(p.vh * S.zoom) + 'px';
  });
  syncAnns();
  syncFields();
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

function pageStep(d){ gotoPage(S.cur + d); }

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
    if (!d || !d[0]) return null;
    return S.doc.getPageIndex(d[0]);
  }).then(function(idx){
    if (typeof idx === 'number') gotoPage(idx + 1, { render:true });
  }).catch(function(){});
}

function toggleSide(force){
  var side = $('side');
  var open = (typeof force === 'boolean') ? force : side.hidden;
  if (open && $('toc').disabled){ toast('This PDF has no bookmarks.'); return; }
  side.hidden = !open;
  $('splitter').hidden = !open;
  $('toc').classList.toggle('on', open);
  setTimeout(applyZoomMode, 0);
}

/* ================= find ================= */
function indexText(){
  if (S.find.indexed) return Promise.resolve();
  var jobs = S.pages.map(function(p){
    var src = p.tc ? Promise.resolve(p.tc) : p.pdf.getTextContent().then(function(tc){ p.tc = tc; return tc; });
    return src.then(function(tc){
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
  if (S.cont) v.scrollTop = Math.max(0, p.el.offsetTop + h.y * p.vh * S.zoom - v.clientHeight * 0.35);
  else v.scrollTop = Math.max(0, h.y * p.vh * S.zoom - v.clientHeight * 0.35);
}

function findStep(d){
  if (!S.find.hits.length){ runFind($('findbox').value, true); return; }
  showHit(S.find.i + d);
}

/* ================= annotations ================= */
function addAnn(pi, nx, ny, type, presetText){
  var p = S.pages[pi];
  var a = { id:'a' + (++S.seq), p:pi, x:nx, y:ny, type:type, color:S.ink };

  if (type === 'text' || type === 'date'){
    a.size = 0.0165;
    a.text = (type === 'date') ? new Date().toLocaleDateString()
      : (presetText != null ? String(presetText) : '');
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
  if (type === 'text' && !a.text) setTimeout(function(){ el.querySelector('.bd').focus(); }, 0);
  return a;
}

var GRIP_SVG = '<svg viewBox="0 0 16 16"><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></svg>';
var DEL_SVG = '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 7.5v4M9.5 7.5v4M4 4.5l.8 8.5h6.4l.8-8.5M6 4.5V2.5h4v2"/></svg>';

function buildRedact(a){
  var wrap = document.createElement('div');
  wrap.className = 'ann redact';
  wrap.dataset.id = a.id;

  var bd = document.createElement('div');
  bd.className = 'bd';
  wrap.appendChild(bd);

  var chip = document.createElement('div');
  chip.className = 'chip';
  chip.innerHTML =
    '<button class="grip" title="Drag to move">' + GRIP_SVG + '</button>' +
    '<div class="sep"></div>' +
    '<button class="del" title="Delete">' + DEL_SVG + '</button>';
  wrap.appendChild(chip);

  var del = chip.querySelector('.del');
  del.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
  del.addEventListener('click', function(e){ e.stopPropagation(); removeAnn(a.id); });
  chip.querySelector('.grip').addEventListener('pointerdown', function(e){ startDrag(e, a, true); });

  var rz = document.createElement('div');
  rz.className = 'rz';
  rz.addEventListener('pointerdown', function(e){ startRedactResize(e, a); });
  wrap.appendChild(rz);

  wrap.addEventListener('pointerdown', function(e){ onAnnDown(e, a); });

  S.pages[a.p].layer.appendChild(wrap);
  S.els[a.id] = wrap;
  styleAnn(a);
  return wrap;
}

function buildAnn(a){
  if (a.type === 'redact') return buildRedact(a);
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

  if (a.type === 'redact'){
    el.style.width = (a.w * wpx) + 'px';
    el.style.height = (a.h * hpx) + 'px';
    return;
  }

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

/* ================= form fields (AcroForm) ================= */
function rectToNorm(rect, vpt, p){
  var c1 = pdfjsLib.Util.applyTransform([rect[0], rect[1]], vpt);
  var c2 = pdfjsLib.Util.applyTransform([rect[2], rect[3]], vpt);
  var x0 = Math.min(c1[0], c2[0]), x1 = Math.max(c1[0], c2[0]);
  var y0 = Math.min(c1[1], c2[1]), y1 = Math.max(c1[1], c2[1]);
  return { x:x0 / p.vw, y:y0 / p.vh, w:(x1 - x0) / p.vw, h:(y1 - y0) / p.vh };
}

function loadFields(){
  var jobs = S.pages.map(function(p){
    return p.pdf.getAnnotations({ intent:'display' })
      .then(function(raw){ p.rawAnnots = raw; return raw; })
      .catch(function(){ p.rawAnnots = []; return []; });
  });
  Promise.all(jobs).then(function(){
    var list = [];
    S.pages.forEach(function(p, pi){
      var vpt = p.pdf.getViewport({ scale:1 }).transform;
      (p.rawAnnots || []).forEach(function(a){
        if (a.subtype !== 'Widget' || !a.fieldName) return;
        var f = { id:'f' + (++S.seq), p:pi, name:a.fieldName, type:null,
          rect:null, value:'', radioValue:'', options:[], readOnly:!!a.readOnly,
          multiline:false, el:null };

        if (a.fieldType === 'Tx'){
          f.type = 'tx';
          f.multiline = !!a.multiLine;
          f.value = (a.fieldValue != null) ? String(a.fieldValue) : '';
        } else if (a.fieldType === 'Btn'){
          if (a.pushButton) return;
          if (a.radioButton){
            f.type = 'radio';
            f.radioValue = (a.buttonValue != null) ? String(a.buttonValue) : '';
            f.value = (a.fieldValue != null) ? String(a.fieldValue) : '';
          } else {
            f.type = 'check';
            var fv = (a.fieldValue != null) ? String(a.fieldValue) : 'Off';
            f.value = (fv !== 'Off' && fv !== '');
          }
        } else if (a.fieldType === 'Ch'){
          f.type = a.combo ? 'combo' : 'list';
          f.options = (a.options || []).map(function(o){
            var v = (o.exportValue != null) ? o.exportValue : o.displayValue;
            var l = (o.displayValue != null) ? o.displayValue : o.exportValue;
            return { value:String(v == null ? '' : v), label:String(l == null ? '' : l) };
          });
          f.value = Array.isArray(a.fieldValue)
            ? String(a.fieldValue[0] || '')
            : ((a.fieldValue != null) ? String(a.fieldValue) : '');
        } else {
          return;
        }

        f.rect = rectToNorm(a.rect, vpt, p);
        list.push(f);
      });
    });

    list.sort(function(a, b){
      if (a.p !== b.p) return a.p - b.p;
      if (Math.abs(a.rect.y - b.rect.y) > 0.01) return a.rect.y - b.rect.y;
      return a.rect.x - b.rect.x;
    });
    list.forEach(function(f, i){ f.tab = i + 1; });

    S.fields = list;
    S.fields.forEach(buildField);
    syncFields();
    updateFieldToggle();
  }).catch(function(){});
}

function buildField(f){
  var p = S.pages[f.p];
  if (!p || !p.fields) return;
  var el;
  if (f.type === 'check' || f.type === 'radio'){
    el = document.createElement('input');
    el.type = (f.type === 'check') ? 'checkbox' : 'radio';
    el.className = 'ff ff-check';
    if (f.type === 'radio'){
      el.name = 'rf-' + f.name;
      el.value = f.radioValue;
      el.checked = (f.value !== '' && f.value !== 'Off' && f.value === f.radioValue);
      el.addEventListener('change', function(){
        S.fields.forEach(function(g){ if (g.type === 'radio' && g.name === f.name) g.value = el.value; });
      });
    } else {
      el.checked = !!f.value;
      el.addEventListener('change', function(){ f.value = el.checked; });
    }
  } else if (f.type === 'combo' || f.type === 'list'){
    el = document.createElement('select');
    el.className = 'ff ff-select';
    var blank = document.createElement('option');
    blank.value = ''; blank.textContent = '';
    el.appendChild(blank);
    f.options.forEach(function(o){
      var op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      el.appendChild(op);
    });
    el.value = f.value || '';
    el.addEventListener('change', function(){ f.value = el.value; });
  } else if (f.multiline){
    el = document.createElement('textarea');
    el.className = 'ff ff-area';
    el.value = f.value || '';
    el.addEventListener('input', function(){ f.value = el.value; });
  } else {
    el = document.createElement('input');
    el.type = 'text';
    el.className = 'ff ff-text';
    el.value = f.value || '';
    el.addEventListener('input', function(){ f.value = el.value; });
  }
  if (f.readOnly) el.disabled = true;
  el.tabIndex = f.tab || 0;
  el.addEventListener('keydown', function(e){ e.stopPropagation(); });
  p.fields.appendChild(el);
  f.el = el;
  styleField(f);
}

function styleField(f){
  var el = f.el;
  if (!el) return;
  var p = S.pages[f.p];
  var wpx = p.vw * S.zoom, hpx = p.vh * S.zoom, r = f.rect;
  el.style.left = (r.x * wpx) + 'px';
  el.style.top = (r.y * hpx) + 'px';
  if (f.type === 'check' || f.type === 'radio'){
    var s = clamp(Math.min(r.w * wpx, r.h * hpx), 9, 26);
    el.style.width = s + 'px';
    el.style.height = s + 'px';
  } else {
    el.style.width = (r.w * wpx) + 'px';
    el.style.height = (r.h * hpx) + 'px';
    el.style.fontSize = Math.max(7, Math.min(r.h * hpx * 0.7, 16)) + 'px';
  }
}

function syncFields(){ S.fields.forEach(styleField); }

function updateFieldToggle(){
  var has = S.fields.length > 0;
  var btn = $('fieldtoggle');
  btn.hidden = !has;
  document.body.classList.remove('hidefields');
  btn.classList.toggle('on', has);
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
  if (S.tool === 'pick') return;
  var r = layer.getBoundingClientRect();
  var nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
  if (S.tool === 'profile'){ openProfilePopover(pi, nx, ny, e.clientX, e.clientY); return; }
  if (S.tool === 'redact'){ startRedactDraw(e, pi, layer, nx, ny); return; }
  addAnn(pi, nx, ny, S.tool);
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

function startRedactDraw(e, pi, layer, nx, ny){
  e.preventDefault();
  var r = layer.getBoundingClientRect();
  var sx = nx, sy = ny;
  var a = { id:'a' + (++S.seq), p:pi, type:'redact', x:nx, y:ny, w:0, h:0, color:'#000' };
  snapshot();
  S.anns.push(a);
  var el = buildRedact(a);
  el.classList.add('drawing');
  select(a.id);

  function move(ev){
    ev.preventDefault();
    var cx = clamp((ev.clientX - r.left) / r.width, 0, 1);
    var cy = clamp((ev.clientY - r.top) / r.height, 0, 1);
    a.x = Math.min(sx, cx); a.y = Math.min(sy, cy);
    a.w = Math.abs(cx - sx); a.h = Math.abs(cy - sy);
    styleAnn(a);
  }
  function up(){
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    el.classList.remove('drawing');
    if (a.w < 0.008 || a.h < 0.008){ removeAnn(a.id); return; }
    select(a.id);
  }
  window.addEventListener('pointermove', move, { passive:false });
  window.addEventListener('pointerup', up);
}

function startRedactResize(e, a){
  e.stopPropagation();
  e.preventDefault();
  var r = S.pages[a.p].layer.getBoundingClientRect();
  var ox = a.x, oy = a.y;
  var moved = false;
  function move(ev){
    ev.preventDefault();
    if (!moved){ moved = true; snapshot(); }
    var cx = clamp((ev.clientX - r.left) / r.width, 0, 1);
    var cy = clamp((ev.clientY - r.top) / r.height, 0, 1);
    a.w = clamp(cx - ox, 0.005, 1 - ox);
    a.h = clamp(cy - oy, 0.005, 1 - oy);
    styleAnn(a);
  }
  function up(){
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
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

function openSig(startTab){
  $('scrim').classList.add('open');
  paintFontOptions();
  if (startTab) tab(startTab);
  renderLib();
  renderProfile();
  if (S.user){ loadSaved(); loadProfile(); }
  setTimeout(function(){ setupPad(); updateSigReady(); }, 30);
}
function openSigChooser(){ openSig('saved'); }
function closeSig(){ $('scrim').classList.remove('open'); }

function tab(name){
  each('#tabs button', function(b){ b.classList.toggle('on', b.dataset.tab === name); });
  each('.pane', function(p){ p.classList.toggle('on', p.dataset.pane === name); });
  sigDraft = null;
  if (name === 'draw') setupPad();
  if (name === 'type') makeTyped();
  if (name === 'saved') loadSaved();
  if (name === 'profile') renderProfile();
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

function currentSigCanvas(){
  var active = document.querySelector('.pane.on');
  var name = active ? active.dataset.pane : 'draw';
  if (name === 'draw') return trim(pad);
  if (name === 'saved') return null;
  return sigDraft ? sigDraft.canvas : null;
}

function updateSigReady(){
  var active = document.querySelector('.pane.on');
  var name = active ? active.dataset.pane : 'draw';
  var hasDraft = (name === 'draw') ? hasInk : (name === 'saved' ? false : !!sigDraft);
  $('siguse').disabled = !hasDraft;

  var canSave = !!S.user && hasDraft && name !== 'saved';
  var nameBox = $('savename');
  var saveBtn = $('sigsave');
  nameBox.hidden = !canSave;
  saveBtn.hidden = !canSave;
  saveBtn.disabled = !canSave;

  var note = $('signote');
  if (note) note.textContent = S.user
    ? 'Signatures you save are stored to your account for reuse.'
    : 'Kept for this session only. Sign in to save signatures.';
}

function setSigIcon(src){
  var icon = $('sigicon');
  icon.innerHTML = '';
  var thumb = new Image();
  thumb.src = src;
  thumb.className = 'sigthumb';
  icon.appendChild(thumb);
  $('editsig').hidden = false;
}

function useSignature(){
  var canvas = currentSigCanvas();
  if (!canvas){ toast('Nothing to save yet.'); return; }
  S.sig = { src:canvas.toDataURL('image/png'), aspect:canvas.width / canvas.height };
  setSigIcon(S.sig.src);
  closeSig();
  setTool('sig');
  toast('Click where the signature goes.');
}

/* ============ account & saved signatures ============ */
function loginRedirect(){
  location.href = '/xhost-auth/login?return_to=' + encodeURIComponent(location.pathname + location.search);
}

function loadAccount(){
  fetch('/xhost-auth/whoami', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(w){
      var signedIn = !!(w && w.logged_in);
      $('acctemail').hidden = !signedIn;
      $('signout').hidden = !signedIn;
      $('acctnote').hidden = signedIn;
      $('acctsignin').hidden = signedIn;
      $('acctmenu').hidden = true;
      if (signedIn){
        S.user = { email:w.email || '', name:w.name || '' };
        $('acctlabel').textContent = 'Signed in as ' + (w.name || w.email || 'you');
        $('acctemail').textContent = w.email || '';
        $('acctbtn').classList.add('in');
        loadProfile();
      } else {
        S.user = null;
        S.profile = null;
        $('acctlabel').textContent = 'Sign in';
        $('acctbtn').classList.remove('in');
      }
      updateSigReady();
      if ($('scrim').classList.contains('open')){ renderLib(); renderProfile(); if (S.user) loadSaved(); }
    })
    .catch(function(){});
}

function loadSaved(){
  if (!S.user){ S.saved = []; renderLib(); return; }
  fetch('/api/signatures', { credentials:'same-origin' })
    .then(function(r){ return r.ok ? r.json() : { signatures:[] }; })
    .then(function(d){ S.saved = (d && d.signatures) || []; renderLib(); })
    .catch(function(){ renderLib(); });
}

function renderLib(){
  var box = $('siglib');
  var signedOut = $('libsignedout');
  var emptyNote = $('siglibempty');
  box.innerHTML = '';
  if (!S.user){
    box.hidden = true; emptyNote.hidden = true; signedOut.hidden = false; return;
  }
  signedOut.hidden = true;
  box.hidden = false;
  if (!S.saved.length){ emptyNote.hidden = false; return; }
  emptyNote.hidden = true;
  S.saved.forEach(function(s){
    var it = document.createElement('div');
    it.className = 'sigitem';
    it.title = 'Use ' + s.name;

    var del = document.createElement('button');
    del.className = 'sigdel';
    del.title = 'Delete';
    del.innerHTML = '×';
    del.addEventListener('click', function(e){ e.stopPropagation(); deleteSaved(s.id); });

    var img = new Image();
    img.src = s.src; img.alt = s.name;

    var cap = document.createElement('div');
    cap.className = 'signame';
    cap.textContent = s.name;

    it.appendChild(del);
    it.appendChild(img);
    it.appendChild(cap);
    it.addEventListener('click', function(){ useSaved(s); });
    box.appendChild(it);
  });
}

function useSaved(s){
  S.sig = { src:s.src, aspect:s.aspect };
  setSigIcon(s.src);
  closeSig();
  setTool('sig');
  toast('Click where the signature goes.');
}

function deleteSaved(id){
  fetch('/api/signatures/' + id, { method:'DELETE', credentials:'same-origin' })
    .then(function(r){
      if (r.ok || r.status === 404){
        S.saved = S.saved.filter(function(x){ return x.id !== id; });
        renderLib();
        toast('Signature deleted.');
      } else {
        toast('Could not delete.');
      }
    })
    .catch(function(){ toast('Could not delete.'); });
}

function saveCurrent(){
  if (!S.user){ loginRedirect(); return; }
  var canvas = currentSigCanvas();
  if (!canvas){ toast('Nothing to save yet.'); return; }
  var name = ($('savename').value || $('typed').value || '').trim() || 'Signature';
  var src = canvas.toDataURL('image/png');
  var btn = $('sigsave');
  btn.disabled = true;
  fetch('/api/signatures', {
    method:'POST', credentials:'same-origin',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ name:name, dataUrl:src })
  }).then(function(r){
    if (r.status === 401){ loginRedirect(); return null; }
    if (r.status === 409){ toast('You can store up to 50 signatures.'); return null; }
    if (!r.ok){ return r.json().then(function(e){ toast(e && e.error ? e.error : 'Could not save signature.'); return null; }); }
    return r.json();
  }).then(function(d){
    btn.disabled = false;
    if (!d) return;
    $('savename').value = '';
    toast('Signature saved.');
    loadSaved();
    tab('saved');
  }).catch(function(){ btn.disabled = false; toast('Could not save signature.'); });
}

/* ============ auto-fill profile ============ */
var PROFILE_FIELDS = [
  ['fullName', 'Full name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['initials', 'Initials'],
  ['address', 'Address']
];

function loadProfile(){
  if (!S.user){ S.profile = null; renderProfile(); return; }
  fetch('/api/profile', { credentials:'same-origin' })
    .then(function(r){ return r.ok ? r.json() : { profile:{} }; })
    .then(function(d){ S.profile = (d && d.profile) || {}; renderProfile(); })
    .catch(function(){ renderProfile(); });
}

function renderProfile(){
  var form = $('profileform');
  var out = $('profilesignedout');
  if (!S.user){ form.hidden = true; out.hidden = false; return; }
  out.hidden = true; form.hidden = false;
  var pf = S.profile || {};
  $('pf-fullName').value = pf.fullName || '';
  $('pf-email').value = pf.email || '';
  $('pf-phone').value = pf.phone || '';
  $('pf-initials').value = pf.initials || '';
  $('pf-address').value = pf.address || '';
  $('pf-dateMode').value = (pf.dateMode === 'today') ? 'today' : 'none';
}

function saveProfile(){
  if (!S.user){ loginRedirect(); return; }
  var profile = {
    fullName: $('pf-fullName').value,
    email: $('pf-email').value,
    phone: $('pf-phone').value,
    initials: $('pf-initials').value,
    address: $('pf-address').value,
    dateMode: ($('pf-dateMode').value === 'today') ? 'today' : 'none'
  };
  var btn = $('profilesave');
  btn.disabled = true;
  fetch('/api/profile', {
    method:'PUT', credentials:'same-origin',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ profile:profile })
  }).then(function(r){
    if (r.status === 401){ loginRedirect(); return null; }
    if (!r.ok) return null;
    return r.json();
  }).then(function(d){
    btn.disabled = false;
    if (!d){ toast('Could not save profile.'); return; }
    S.profile = d.profile || profile;
    renderProfile();
    toast('Profile saved.');
  }).catch(function(){ btn.disabled = false; toast('Could not save profile.'); });
}

function profileEntries(){
  var pf = S.profile || {};
  var list = [];
  PROFILE_FIELDS.forEach(function(kv){ if (pf[kv[0]]) list.push({ label:kv[1], value:pf[kv[0]] }); });
  if (pf.dateMode === 'today') list.push({ label:"Today's date", value:new Date().toLocaleDateString() });
  return list;
}

function closePopover(){ var p = $('profilepop'); if (p) p.remove(); }

function openProfilePopover(pi, nx, ny, cx, cy){
  closePopover();
  var entries = profileEntries();
  if (!S.user || !entries.length){
    openSig('profile');
    toast(S.user ? 'Add profile details to auto-fill.' : 'Sign in and save a profile to auto-fill.');
    return;
  }
  var pop = document.createElement('div');
  pop.className = 'popover';
  pop.id = 'profilepop';
  var head = document.createElement('div');
  head.className = 'pophead';
  head.textContent = 'Insert from profile';
  pop.appendChild(head);
  entries.forEach(function(en){
    var b = document.createElement('button');
    b.className = 'popitem';
    var k = document.createElement('span'); k.className = 'k'; k.textContent = en.label;
    var v = document.createElement('span'); v.className = 'v'; v.textContent = en.value;
    b.appendChild(k); b.appendChild(v);
    b.addEventListener('click', function(){ addAnn(pi, nx, ny, 'text', en.value); closePopover(); });
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  var rect = pop.getBoundingClientRect();
  var left = Math.min(cx, window.innerWidth - rect.width - 8);
  var top = Math.min(cy, window.innerHeight - rect.height - 8);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

/* ================= flatten, save, print ================= */
function sanitize(s){
  return String(s)
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '');
}

function buildPdf(){
  var PDFDocument = PDFLIB.PDFDocument;
  var StandardFonts = PDFLIB.StandardFonts;
  var degrees = PDFLIB.degrees;
  var LineCapStyle = PDFLIB.LineCapStyle;

  return PDFDocument.load(S.bytes, { ignoreEncryption:true }).then(function(pdf){
    return pdf.embedFont(StandardFonts.Helvetica).then(function(font){
      var pages = pdf.getPages();

      if (S.fields.length){
        var form = null;
        try { form = pdf.getForm(); } catch(e){ form = null; }
        if (form){
          var doneRadio = {};
          S.fields.forEach(function(f){
            try {
              if (f.type === 'tx'){
                form.getTextField(f.name).setText(String(f.value || ''));
              } else if (f.type === 'check'){
                var cb = form.getCheckBox(f.name);
                if (f.value) cb.check(); else cb.uncheck();
              } else if (f.type === 'radio'){
                if (doneRadio[f.name]) return;
                doneRadio[f.name] = true;
                if (f.value && f.value !== 'Off') form.getRadioGroup(f.name).select(f.value);
              } else if (f.type === 'combo'){
                if (f.value) form.getDropdown(f.name).select(f.value);
              } else if (f.type === 'list'){
                if (f.value) form.getOptionList(f.name).select(f.value);
              }
            } catch(err){ /* skip unresolvable field */ }
          });
          try { form.updateFieldAppearances(font); } catch(e){}
          try { form.flatten(); } catch(e){}
        }
      }

      var imgs = {};
      var chain = Promise.resolve();

      S.anns.forEach(function(a){
        chain = chain.then(function(){
          var page = pages[a.p];
          if (!page) return null;
          if (a.type === 'redact') return null; // baked destructively in rebuildDocument, never as vector
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
  });
}

/* ================= document tools (redact / merge / split / reduce) ================= */
function downloadBytes(bytes, filename){
  var blob = new Blob([bytes], { type:'application/pdf' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
}

// Build a redaction map { pageIndex: [ {x,y,w,h} normalized ] } from S.anns, or null.
function redactMapFromAnns(){
  var map = {}, any = false;
  S.anns.forEach(function(a){
    if (a.type !== 'redact') return;
    any = true;
    (map[a.p] = map[a.p] || []).push({ x:a.x, y:a.y, w:a.w, h:a.h });
  });
  return any ? map : null;
}

// Rebuild a document, RASTERIZING selected pages so their original text/vector
// content is destroyed (not merely covered). Pages that are neither redacted
// nor force-rasterized are copied verbatim so their text stays selectable.
// This is the guarantee that redacted content is not discoverable.
function rebuildDocument(baseBytes, opts){
  opts = opts || {};
  var redactMap = opts.redactMap || {};
  var rasterizeAll = !!opts.rasterizeAll;
  var scale = opts.scale || 2;
  var quality = (opts.quality != null) ? opts.quality : 0.85;
  var PDFDocument = PDFLIB.PDFDocument;
  var pdfjsDoc, srcDoc, outDoc;

  return pdfjsLib.getDocument({ data:baseBytes.slice(0), worker:PDFWORKER || undefined }).promise.then(function(d){
    pdfjsDoc = d;
    return PDFDocument.load(baseBytes, { ignoreEncryption:true });
  }).then(function(s){
    srcDoc = s;
    return PDFDocument.create();
  }).then(function(o){
    outDoc = o;
    var n = pdfjsDoc.numPages;
    var chain = Promise.resolve();
    for (var i = 0; i < n; i++){
      (function(idx){
        chain = chain.then(function(){
          var rects = redactMap[idx];
          var needRaster = rasterizeAll || (rects && rects.length);
          if (!needRaster){
            return outDoc.copyPages(srcDoc, [idx]).then(function(cp){ outDoc.addPage(cp[0]); });
          }
          return pdfjsDoc.getPage(idx + 1).then(function(pg){
            var vp = pg.getViewport({ scale:scale });
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(vp.width));
            canvas.height = Math.max(1, Math.floor(vp.height));
            var ctx = canvas.getContext('2d', { alpha:false });
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return pg.render({ canvasContext:ctx, viewport:vp }).promise.then(function(){
              if (rects && rects.length){
                ctx.fillStyle = '#000';
                rects.forEach(function(r){
                  ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
                });
              }
              var jpg = canvas.toDataURL('image/jpeg', quality);
              return outDoc.embedJpg(jpg).then(function(img){
                var vp1 = pg.getViewport({ scale:1 });
                var page = outDoc.addPage([vp1.width, vp1.height]);
                page.drawImage(img, { x:0, y:0, width:vp1.width, height:vp1.height });
              });
            });
          });
        });
      })(i);
    }
    return chain;
  }).then(function(){ return outDoc.save(); });
}

// buildPdf bakes fills + annotations (skipping redaction boxes); this wrapper
// then destructively rasterizes any redacted pages.
function buildOutput(){
  return buildPdf().then(function(out){
    var map = redactMapFromAnns();
    if (!map) return out;
    return rebuildDocument(out, { redactMap:map, scale:2, quality:0.85 });
  });
}

function fmtSize(n){
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function busy(btn, text, job){
  var label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = text;
  return job().catch(function(err){
    console.error(err);
    toast('Could not write the PDF. ' + ((err && err.message) ? err.message : ''));
  }).then(function(){
    btn.disabled = false;
    btn.innerHTML = label;
  });
}

function save(){
  if (!S.bytes) return;
  busy($('dl'), 'Saving\u2026', function(){
    return buildOutput().then(function(out){
      downloadBytes(out, S.name.replace(/\.pdf$/i, '') + ' (signed).pdf');
      toast('Saved.');
    });
  });
}

function printDoc(){
  if (!S.bytes) return;
  busy($('printbtn'), '\u2026', function(){
    return buildOutput().then(function(out){
      var blob = new Blob([out], { type:'application/pdf' });
      if (S.printUrl) URL.revokeObjectURL(S.printUrl);
      S.printUrl = URL.createObjectURL(blob);
      var frame = $('printframe');
      frame.onload = function(){
        setTimeout(function(){
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch(err){
            window.open(S.printUrl, '_blank');
            toast('Opened the copy in a new tab to print.');
          }
        }, 250);
      };
      frame.src = S.printUrl;
    });
  });
}

/* ================= document ops ================= */
function reopenBytes(bytes, name){
  S.bytes = bytes;
  if (name) S.name = name;
  S.anns = []; S.els = {}; S.sel = null; S.hist = []; S.fields = [];
  S.find = { q:'', hits:[], i:-1, indexed:false };
  $('findbox').value = '';
  $('findcount').textContent = '';
  load(new Uint8Array(bytes.slice(0)));
}

function readFileBytes(file){
  return new Promise(function(resolve, reject){
    var fr = new FileReader();
    fr.onload = function(){ resolve(new Uint8Array(fr.result)); };
    fr.onerror = function(){ reject(new Error('Could not read ' + (file.name || 'file'))); };
    fr.readAsArrayBuffer(file);
  });
}

function mergeAppend(files){
  files = Array.prototype.slice.call(files || []).filter(function(f){
    return (f.type && f.type.indexOf('pdf') !== -1) || /\.pdf$/i.test(f.name || '');
  });
  if (!files.length){ toast('No PDF files selected.'); return; }
  var PDFDocument = PDFLIB.PDFDocument;
  busy($('mergebtn'), 'Merging…', function(){
    var baseDoc, added = 0;
    return buildOutput().then(function(base){
      return PDFDocument.load(base, { ignoreEncryption:true });
    }).then(function(d){
      baseDoc = d;
      var chain = Promise.resolve();
      files.forEach(function(f){
        chain = chain.then(function(){ return readFileBytes(f); }).then(function(bytes){
          if (String.fromCharCode.apply(null, bytes.subarray(0, 4)) !== '%PDF'){
            throw new Error((f.name || 'A file') + ' is not a valid PDF.');
          }
          return PDFDocument.load(bytes, { ignoreEncryption:true }).then(function(src){
            return baseDoc.copyPages(src, src.getPageIndices());
          }).then(function(pages){
            pages.forEach(function(p){ baseDoc.addPage(p); });
            added += pages.length;
          });
        });
      });
      return chain;
    }).then(function(){
      return baseDoc.save({ useObjectStreams:true });
    }).then(function(merged){
      reopenBytes(new Uint8Array(merged));
      toast('Merged — added ' + added + ' page' + (added === 1 ? '' : 's') + '.');
    });
  });
}

function parsePageRange(str, total){
  var out = [], seen = {};
  (str || '').split(',').forEach(function(part){
    part = part.trim();
    if (!part) return;
    var m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m){
      var a = +m[1], b = +m[2];
      if (a > b){ var t = a; a = b; b = t; }
      for (var i = a; i <= b; i++) if (i >= 1 && i <= total && !seen[i]){ seen[i] = 1; out.push(i - 1); }
    } else if (/^\d+$/.test(part)){
      var n = +part;
      if (n >= 1 && n <= total && !seen[n]){ seen[n] = 1; out.push(n - 1); }
    }
  });
  return out;
}

function splitExtract(indices){
  var PDFDocument = PDFLIB.PDFDocument;
  busy($('splitgo'), 'Extracting…', function(){
    var outDoc;
    return buildOutput().then(function(base){
      return PDFDocument.load(base, { ignoreEncryption:true });
    }).then(function(src){
      return PDFDocument.create().then(function(o){
        outDoc = o;
        return outDoc.copyPages(src, indices);
      });
    }).then(function(pages){
      pages.forEach(function(p){ outDoc.addPage(p); });
      return outDoc.save({ useObjectStreams:true });
    }).then(function(bytes){
      var label = indices.length === 1 ? ('page ' + (indices[0] + 1)) : (indices.length + ' pages');
      downloadBytes(new Uint8Array(bytes), S.name.replace(/\.pdf$/i, '') + ' (' + label + ').pdf');
      closeSplit();
      toast('Extracted ' + indices.length + ' page' + (indices.length === 1 ? '' : 's') + '.');
    });
  });
}

function reduceLossless(){
  var PDFDocument = PDFLIB.PDFDocument;
  return buildOutput().then(function(base){
    return PDFDocument.load(base, { ignoreEncryption:true });
  }).then(function(src){
    try {
      src.setTitle(''); src.setAuthor(''); src.setSubject('');
      src.setKeywords([]); src.setProducer(''); src.setCreator('');
    } catch(e){}
    return src.save({ useObjectStreams:true });
  });
}

function reduceStrong(quality){
  return buildOutput().then(function(base){
    return rebuildDocument(base, { rasterizeAll:true, scale:1.5, quality:quality });
  });
}

function runReduce(mode, quality){
  var before = S.bytes.length;
  busy($('reducego'), 'Reducing…', function(){
    var job = (mode === 'strong') ? reduceStrong(quality) : reduceLossless();
    return job.then(function(bytes){
      var out = new Uint8Array(bytes);
      downloadBytes(out, S.name.replace(/\.pdf$/i, '') + ' (reduced).pdf');
      closeReduce();
      var delta = before - out.length;
      if (delta > 0){
        toast('Reduced ' + fmtSize(before) + ' → ' + fmtSize(out.length) +
          ' (' + Math.round(delta / before * 100) + '% smaller).');
      } else {
        toast('Already compact: ' + fmtSize(before) + ' → ' + fmtSize(out.length) + '.');
      }
    });
  });
}

/* split / reduce dialogs */
function openSplit(){
  if (!S.bytes) return;
  $('splithint').textContent = 'This document has ' + S.pages.length +
    ' page' + (S.pages.length === 1 ? '' : 's') + '. The current document stays open.';
  $('splitrange').value = '';
  $('splitscrim').classList.add('open');
  setTimeout(function(){ $('splitrange').focus(); }, 30);
}
function closeSplit(){ $('splitscrim').classList.remove('open'); }
function doSplit(){
  var idx = parsePageRange($('splitrange').value, S.pages.length);
  if (!idx.length){ toast('Enter a valid page range, e.g. 1-3, 5.'); return; }
  splitExtract(idx);
}

function openReduce(){
  if (!S.bytes) return;
  $('reducescrim').classList.add('open');
}
function closeReduce(){ $('reducescrim').classList.remove('open'); }
function doReduce(){
  var mode = 'lossless';
  each('input[name=reducemode]', function(r){ if (r.checked) mode = r.value; });
  var q = (+$('reducequality').value || 60) / 100;
  runReduce(mode, q);
}

/* ================= tools ================= */
function setTool(t){
  if (t === 'sig' && !S.sig){ openSigChooser(); return; }
  closePopover();
  S.tool = t;
  each('.tool', function(b){ b.classList.toggle('on', b.dataset.tool === t); });
  var v = $('viewer');
  v.classList.toggle('hand', t === 'hand');
  v.classList.toggle('pick-text', t === 'pick');
  if (t !== 'pick'){
    var s = window.getSelection();
    if (s && s.rangeCount && !document.activeElement.isContentEditable) s.removeAllRanges();
  }
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
each('.tool', function(b){
  b.addEventListener('click', function(){
    if (b.dataset.tool === 'sig') openSigChooser();
    else setTool(b.dataset.tool);
  });
});
each('.swatch', function(b){
  b.addEventListener('click', function(){
    S.ink = b.dataset.ink;
    each('.swatch', function(x){ x.classList.remove('on'); });
    b.classList.add('on');
  });
});
each('#tabs button', function(b){ b.addEventListener('click', function(){ tab(b.dataset.tab); }); });

$('editsig').addEventListener('click', openSigChooser);
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
$('printbtn').addEventListener('click', printDoc);

$('mergebtn').addEventListener('click', function(){ $('mergefile').click(); });
$('mergefile').addEventListener('change', function(e){
  if (e.target.files && e.target.files.length) mergeAppend(e.target.files);
  e.target.value = '';
});
$('splitbtn').addEventListener('click', openSplit);
$('splitcancel').addEventListener('click', closeSplit);
$('splitgo').addEventListener('click', doSplit);
$('splitscrim').addEventListener('pointerdown', function(e){ if (e.target === $('splitscrim')) closeSplit(); });
$('splitrange').addEventListener('keydown', function(e){
  e.stopPropagation();
  if (e.key === 'Enter'){ e.preventDefault(); doSplit(); }
});
$('reducebtn').addEventListener('click', openReduce);
$('reducecancel').addEventListener('click', closeReduce);
$('reducego').addEventListener('click', doReduce);
$('reducescrim').addEventListener('pointerdown', function(e){ if (e.target === $('reducescrim')) closeReduce(); });
each('input[name=reducemode]', function(r){
  r.addEventListener('change', function(){
    $('strongopts').hidden = ($('reducescrim').querySelector('input[name=reducemode]:checked').value !== 'strong');
  });
});
$('reducequality').addEventListener('input', function(e){
  $('reduceqval').textContent = e.target.value + '%';
});
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
$('sigsave').addEventListener('click', saveCurrent);
$('savename').addEventListener('keydown', function(e){
  e.stopPropagation();
  if (e.key === 'Enter'){ e.preventDefault(); saveCurrent(); }
});
$('libsignin').addEventListener('click', loginRedirect);
$('profilesave').addEventListener('click', saveProfile);
$('profilesignin').addEventListener('click', loginRedirect);
$('fieldtoggle').addEventListener('click', function(){
  var hidden = document.body.classList.toggle('hidefields');
  $('fieldtoggle').classList.toggle('on', !hidden);
});
each('.pf', function(el){ el.addEventListener('keydown', function(e){ e.stopPropagation(); }); });

$('acctbtn').addEventListener('click', function(e){
  e.stopPropagation();
  var m = $('acctmenu');
  var willOpen = m.hidden;
  m.hidden = !willOpen;
  if (willOpen){
    var r = this.getBoundingClientRect();
    m.style.top = (r.bottom + 2) + 'px';
    m.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
  }
});
$('acctsignin').addEventListener('click', loginRedirect);
$('signout').addEventListener('click', function(){ location.href = '/xhost-auth/logout?return_to=/'; });
document.addEventListener('click', function(e){
  var acct = $('acct');
  if (acct && !acct.contains(e.target)) $('acctmenu').hidden = true;
});

/* ---- alt-hold shortcut badges ---- */
var BADGES = {
  '[data-tool="pick"]':'V', '[data-tool="hand"]':'H',
  '[data-tool="text"]':'1', '[data-tool="check"]':'2', '[data-tool="cross"]':'3',
  '[data-tool="date"]':'4', '[data-tool="sig"]':'5', '[data-tool="profile"]':'6',
  '[data-tool="redact"]':'R',
  '#prev':'P', '#next':'N', '#zin':'+', '#zout':'−', '#vcont':'C', '#vsingle':'C'
};
Object.keys(BADGES).forEach(function(sel){
  var el = document.querySelector(sel);
  if (!el) return;
  var b = document.createElement('span');
  b.className = 'kbadge';
  b.textContent = BADGES[sel];
  el.appendChild(b);
});
window.addEventListener('keydown', function(e){ if (e.key === 'Alt'){ e.preventDefault(); document.body.classList.add('altdown'); } }, true);
window.addEventListener('keyup', function(e){ if (e.key === 'Alt') document.body.classList.remove('altdown'); }, true);
window.addEventListener('blur', function(){ document.body.classList.remove('altdown'); });

/* ---- keyboard shortcuts sheet ---- */
function openHelp(){ $('acctmenu').hidden = true; $('helpscrim').classList.add('open'); }
function closeHelp(){ $('helpscrim').classList.remove('open'); }
$('helpbtn').addEventListener('click', openHelp);
$('helpclose').addEventListener('click', closeHelp);
$('helpscrim').addEventListener('click', function(e){ if (e.target === this) closeHelp(); });
$('padclear').addEventListener('click', function(){ setupPad(); updateSigReady(); });
$('typed').addEventListener('input', makeTyped);
$('typed').addEventListener('keydown', function(e){ e.stopPropagation(); });
$('pad').addEventListener('pointerdown', padDown);
$('pad').addEventListener('pointermove', padMove);
$('pad').addEventListener('pointerup', padUp);
$('pad').addEventListener('pointercancel', padUp);

$('splitter').addEventListener('pointerdown', function(e){
  e.preventDefault();
  function move(ev){ $('side').style.width = clamp(ev.clientX, 120, window.innerWidth * 0.6) + 'px'; }
  function up(){
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    applyZoomMode();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

['dragenter', 'dragover'].forEach(function(t){
  window.addEventListener(t, function(e){ e.preventDefault(); document.body.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach(function(t){
  window.addEventListener(t, function(e){ e.preventDefault(); document.body.classList.remove('dragover'); });
});
window.addEventListener('drop', function(e){
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});

/* ================= keyboard ================= */
var TOOLKEYS = { '1':'text', '2':'check', '3':'cross', '4':'date', '5':'sig', '6':'profile', 'r':'redact' };

window.addEventListener('keydown', function(e){
  var ae = document.activeElement;
  if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;

  var k = e.key;
  var ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey) return;

  if (k === '?'){ e.preventDefault(); $('helpscrim').classList.contains('open') ? closeHelp() : openHelp(); return; }

  if (ctrl && k.toLowerCase() === 'o'){ e.preventDefault(); $('file').click(); return; }
  if (ctrl && k.toLowerCase() === 's'){ e.preventDefault(); if (!$('dl').disabled) save(); return; }
  if (ctrl && k.toLowerCase() === 'p'){ e.preventDefault(); if (!$('printbtn').disabled) printDoc(); return; }
  if (ctrl && k.toLowerCase() === 'z'){ e.preventDefault(); undo(); return; }
  if (ctrl && k.toLowerCase() === 'f'){ e.preventDefault(); $('findbox').focus(); $('findbox').select(); return; }
  if (ctrl && k.toLowerCase() === 'g'){ e.preventDefault(); $('pagebox').focus(); $('pagebox').select(); return; }
  if (ctrl) return;

  if (k === 'Escape'){
    if ($('helpscrim').classList.contains('open')) closeHelp();
    else if ($('profilepop')) closePopover();
    else if ($('splitscrim').classList.contains('open')) closeSplit();
    else if ($('reducescrim').classList.contains('open')) closeReduce();
    else if ($('scrim').classList.contains('open')) closeSig();
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
    case 'v': e.preventDefault(); setTool('pick'); return;
    case '/': e.preventDefault(); $('findbox').focus(); return;
  }
  if (TOOLKEYS[k]){
    e.preventDefault();
    if (TOOLKEYS[k] === 'sig') openSigChooser();
    else setTool(TOOLKEYS[k]);
  }
});

/* ================= scroll & resize ================= */
var rafPending = false;
$('viewer').addEventListener('scroll', function(){
  if ($('profilepop')) closePopover();
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
loadAccount();

})();
