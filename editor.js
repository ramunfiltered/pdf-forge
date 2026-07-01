'use strict';
// PDF Forge — Editor v2.0  (complete rewrite, all bugs fixed)

// ── PDF.js worker ────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.min.js');

// ── IndexedDB (same DB used by popup) ───────────────────────────
const DB_NAME = 'PDFForge', STORE = 'files';
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const r  = tx.objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = e => rej(e.target.error);
  });
}

// ── State ────────────────────────────────────────────────────────
const S = {
  doc:      null,   // pdfjsLib document
  name:     '',
  size:     0,
  total:    0,
  page:     1,
  zoom:     1.0,
  mode:     'select',
  anns:     {},     // { [pageNum]: Annotation[] }
  rots:     {},     // { [pageNum]: 0|90|180|270 }
  wm:       null,   // watermark config
  undoStack:[],
  redoStack:[],
};

// ── DOM shortcuts ────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const vp  = $('vp');
const pgs = $('pages');

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindAll();
  wireProps();

  // Try loading file placed by popup via IndexedDB
  idbGet('pdf').then(rec => {
    if (rec && rec.buf && rec.name) {
      loadBuffer(rec.buf, rec.name, rec.size || 0);
    }
  }).catch(() => {});

  // URL tool param (from popup shortcut buttons)
  const tool = new URLSearchParams(location.search).get('tool');
  if (tool) setTimeout(() => activateTool(tool), 800);
});

// ── Load helpers ─────────────────────────────────────────────────
async function loadFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  await loadBuffer(buf, file.name, file.size);
}

async function loadBuffer(buf, name, size) {
  progress(10);
  toast('⏳ Loading ' + name + '…');
  try {
    S.doc   = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    S.name  = name;
    S.size  = size;
    S.total = S.doc.numPages;
    S.page  = 1;
    S.anns  = {};
    S.rots  = {};
    S.wm    = null;
    S.undoStack = []; S.redoStack = [];
    $('fname').textContent = name;
    $('dov').classList.add('hidden');
    progress(40);
    await renderAll();
    progress(85);
    await buildThumbs();
    progress(100);
    updateNav(); updateInfo(); updateUndoRedo();
    toast('✅ Loaded — ' + S.total + ' page(s)');
    setTimeout(() => progress(0), 600);
  } catch(err) {
    toast('❌ ' + err.message);
    progress(0);
    console.error(err);
  }
}

// ── Progress bar ─────────────────────────────────────────────────
function progress(pct) {
  $('loadbar').style.width = (pct || 0) + '%';
}

// ── Render all pages ──────────────────────────────────────────────
async function renderAll() {
  pgs.innerHTML = '';
  for (let i = 1; i <= S.total; i++) {
    await renderPage(i);
  }
}

async function renderPage(n) {
  const pg   = await S.doc.getPage(n);
  const rot  = S.rots[n] || 0;
  const vw   = pg.getViewport({ scale: S.zoom, rotation: rot });
  const W = vw.width, H = vw.height;

  // wrapper — MUST have position:relative (set in CSS .pgw)
  const wrap = document.createElement('div');
  wrap.className = 'pgw';
  wrap.id   = 'p' + n;
  wrap.style.width  = W + 'px';
  wrap.style.height = H + 'px';

  // Base render canvas
  const rc = document.createElement('canvas');
  rc.className = 'rc';
  rc.width  = W;
  rc.height = H;
  await pg.render({ canvasContext: rc.getContext('2d'), viewport: vw }).promise;

  // Draw canvas — pointer-events:none (CSS), floats above rc
  const dc = document.createElement('canvas');
  dc.className = 'dc';
  dc.width  = W;
  dc.height = H;
  dc.style.width  = W + 'px';
  dc.style.height = H + 'px';

  // Event-capture overlay div
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.dataset.n = n;
  attachEvents(ov, n, dc);

  // Page badge
  const badge = document.createElement('div');
  badge.className = 'pgnum';
  badge.textContent = n;

  wrap.append(rc, dc, ov, badge);
  pgs.appendChild(wrap);

  redraw(n, dc);
}

// ── Re-render a single page in place ─────────────────────────────
async function rerenderPage(n) {
  const existing = $('p' + n);
  if (existing) existing.remove();
  // Insert at correct position
  await renderPage(n);
  const newEl = $('p' + n);
  // Move to correct slot
  const nextEl = $('p' + (n + 1));
  if (nextEl) pgs.insertBefore(newEl, nextEl);
}

// ── Draw annotations on a page's draw canvas ─────────────────────
function redraw(n, dc) {
  if (!dc) {
    const w = $('p' + n);
    if (!w) return;
    dc = w.querySelector('canvas.dc');
    if (!dc) return;
  }
  const ctx = dc.getContext('2d');
  ctx.clearRect(0, 0, dc.width, dc.height);
  for (const a of (S.anns[n] || [])) drawOne(ctx, a);
  if (S.wm) drawWM(ctx, dc.width, dc.height);
}

function redrawAll() {
  for (let i = 1; i <= S.total; i++) redraw(i);
  updateInfo();
}

function drawOne(ctx, a) {
  ctx.save();
  ctx.globalAlpha = (a.opacity ?? 100) / 100;
  switch (a.type) {
    case 'draw':
      if (!a.path || a.path.length < 2) break;
      ctx.strokeStyle = a.color;
      ctx.lineWidth   = a.width;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(a.path[0].x, a.path[0].y);
      for (let i = 1; i < a.path.length; i++) ctx.lineTo(a.path[i].x, a.path[i].y);
      ctx.stroke();
      break;
    case 'shape': {
      ctx.strokeStyle = a.color;
      ctx.lineWidth   = a.width;
      const {x,y,w,h} = a;
      ctx.beginPath();
      if (a.shape === 'rect') {
        ctx.strokeRect(x, y, w, h);
      } else if (a.shape === 'circle') {
        ctx.ellipse(x + w/2, y + h/2, Math.abs(w/2), Math.abs(h/2), 0, 0, Math.PI*2);
        ctx.stroke();
      } else if (a.shape === 'line') {
        ctx.moveTo(x, y); ctx.lineTo(x+w, y+h); ctx.stroke();
      } else if (a.shape === 'arrow') {
        ctx.moveTo(x, y); ctx.lineTo(x+w, y+h); ctx.stroke();
        const ang = Math.atan2(h, w), hs = 14;
        ctx.beginPath();
        ctx.moveTo(x+w, y+h);
        ctx.lineTo(x+w - hs*Math.cos(ang-.5), y+h - hs*Math.sin(ang-.5));
        ctx.moveTo(x+w, y+h);
        ctx.lineTo(x+w - hs*Math.cos(ang+.5), y+h - hs*Math.sin(ang+.5));
        ctx.stroke();
      }
      break;
    }
    case 'highlight':
      ctx.globalAlpha = .38;
      ctx.fillStyle   = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      break;
    case 'text':
      ctx.font         = `${a.size}px "${a.font}"`;
      ctx.fillStyle    = a.color;
      ctx.globalAlpha  = 1;
      // multi-line support
      (a.text || '').split('\n').forEach((line, i) => {
        ctx.fillText(line, a.x, a.y + a.size * (i + 1));
      });
      break;
  }
  ctx.restore();
}

function drawWM(ctx, W, H) {
  const {text, opacity, color, fontSize} = S.wm;
  const fs = fontSize || Math.round(Math.min(W, H) / 7);
  ctx.save();
  ctx.translate(W/2, H/2);
  ctx.rotate(-Math.PI / 4);
  ctx.font         = `bold ${fs}px Helvetica`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = color || '#ff0000';
  ctx.globalAlpha  = opacity / 100;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// ── Mouse events on overlay ───────────────────────────────────────
function attachEvents(ov, n, dc) {
  function pt(e) {
    // Convert client coords → canvas pixel coords
    const r  = dc.getBoundingClientRect();
    // getBoundingClientRect gives rendered size; dc.width is pixel size
    // They're equal (no CSS scaling) so ratio = 1, but be safe:
    const sx = dc.width  / r.width;
    const sy = dc.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  // Single click: text tool
  ov.addEventListener('click', e => {
    if (S.mode === 'text') insertText(e, n, dc, pt(e));
  });

  // Mousedown: draw / shape / highlight / erase
  ov.addEventListener('mousedown', e => {
    if (S.mode === 'select' || S.mode === 'text') return;
    e.preventDefault();
    const start = pt(e);

    if (S.mode === 'erase') {
      doErase(n, dc, start);
      const mv = me => doErase(n, dc, pt(me));
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      return;
    }

    let path = [start];
    const ctx = dc.getContext('2d');

    const mv = me => {
      const cur = pt(me);
      if (S.mode === 'draw') {
        // Incremental draw
        const prev = path[path.length - 1];
        ctx.save();
        ctx.strokeStyle = $('pSC').value;
        ctx.lineWidth   = +$('pSW').value;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.globalAlpha = +$('pOp').value / 100;
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
        ctx.restore();
        path.push(cur);
      } else {
        // Shape / highlight preview
        redraw(n, dc);
        ctx.save();
        const dw = cur.x - start.x, dh = cur.y - start.y;
        if (S.mode === 'highlight') {
          ctx.globalAlpha = .38;
          ctx.fillStyle   = $('pHC').value;
          ctx.fillRect(start.x, start.y, dw, dh);
        } else {
          ctx.globalAlpha = +$('pOp').value / 100;
          ctx.strokeStyle = $('pSC').value;
          ctx.lineWidth   = +$('pSW').value;
          const sh = $('pShape').value;
          ctx.beginPath();
          if (sh === 'rect') ctx.strokeRect(start.x, start.y, dw, dh);
          else if (sh === 'circle') {
            ctx.ellipse(start.x+dw/2, start.y+dh/2, Math.abs(dw/2), Math.abs(dh/2), 0, 0, Math.PI*2);
            ctx.stroke();
          } else { ctx.moveTo(start.x, start.y); ctx.lineTo(cur.x, cur.y); ctx.stroke(); }
        }
        ctx.restore();
      }
    };

    const up = ue => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      const end = pt(ue);
      if (!S.anns[n]) S.anns[n] = [];
      pushUndo();
      if (S.mode === 'draw' && path.length > 1) {
        S.anns[n].push({ type:'draw', path:[...path],
          color:$('pSC').value, width:+$('pSW').value, opacity:+$('pOp').value });
      } else if (S.mode === 'shape') {
        S.anns[n].push({ type:'shape', shape:$('pShape').value,
          x:start.x, y:start.y, w:end.x-start.x, h:end.y-start.y,
          color:$('pSC').value, width:+$('pSW').value, opacity:+$('pOp').value });
      } else if (S.mode === 'highlight') {
        S.anns[n].push({ type:'highlight',
          x:start.x, y:start.y, w:end.x-start.x, h:end.y-start.y, color:$('pHC').value });
      }
      redraw(n, dc);
      updateInfo();
    };

    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });
}

// ── Text insertion ────────────────────────────────────────────────
function insertText(e, n, dc, canvasPt) {
  const wrap = $('p' + n);
  const wRect = wrap.getBoundingClientRect();

  const el = document.createElement('div');
  el.contentEditable = 'true';
  el.className = 'tann';
  el.style.left       = (e.clientX - wRect.left) + 'px';
  el.style.top        = (e.clientY - wRect.top)  + 'px';
  el.style.fontSize   = $('pSize').value + 'px';
  el.style.fontFamily = $('pFont').value;
  el.style.color      = $('pTC').value;
  el.textContent      = '';
  wrap.appendChild(el);
  el.focus();

  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { el.remove(); }
  });

  el.addEventListener('blur', () => {
    const txt = el.textContent.trim();
    el.remove();
    if (!txt) return;
    pushUndo();
    if (!S.anns[n]) S.anns[n] = [];
    S.anns[n].push({
      type:  'text',
      text:  txt,
      x:     canvasPt.x,
      y:     canvasPt.y,
      size:  +$('pSize').value,
      font:  $('pFont').value,
      color: $('pTC').value,
    });
    redraw(n, dc);
    updateInfo();
  });
}

// ── Eraser ────────────────────────────────────────────────────────
function doErase(n, dc, pt) {
  if (!S.anns[n] || !S.anns[n].length) return;
  const R = 20;
  const before = S.anns[n].length;
  S.anns[n] = S.anns[n].filter(a => {
    if (a.type === 'draw')
      return !a.path.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < R);
    if (a.type === 'shape' || a.type === 'highlight') {
      const mx = Math.min(a.x, a.x + a.w), Mx = Math.max(a.x, a.x + a.w);
      const my = Math.min(a.y, a.y + a.h), My = Math.max(a.y, a.y + a.h);
      return !(pt.x >= mx - R && pt.x <= Mx + R && pt.y >= my - R && pt.y <= My + R);
    }
    if (a.type === 'text')
      return Math.hypot(a.x - pt.x, a.y - pt.y) > 40;
    return true;
  });
  if (S.anns[n].length !== before) redraw(n, dc);
}

// ── Undo / Redo ───────────────────────────────────────────────────
function snap() {
  return JSON.stringify(S.anns);
}

function pushUndo() {
  S.undoStack.push(snap());
  S.redoStack = [];
  updateUndoRedo();
}

function undo() {
  if (!S.undoStack.length) return;
  S.redoStack.push(snap());
  S.anns = JSON.parse(S.undoStack.pop());
  redrawAll();
  updateUndoRedo();
  toast('↩ Undo');
}

function redo() {
  if (!S.redoStack.length) return;
  S.undoStack.push(snap());
  S.anns = JSON.parse(S.redoStack.pop());
  redrawAll();
  updateUndoRedo();
  toast('↪ Redo');
}

function updateUndoRedo() {
  $('btnUndo').disabled = !S.undoStack.length;
  $('btnRedo').disabled = !S.redoStack.length;
}

// ── Mode ──────────────────────────────────────────────────────────
function setMode(m) {
  S.mode = m;
  document.querySelectorAll('.si[data-mode]').forEach(b =>
    b.classList.toggle('act', b.dataset.mode === m));
  const cur = {select:'default',text:'text',highlight:'crosshair',
    draw:'crosshair',shape:'crosshair',erase:'cell'}[m] || 'default';
  document.querySelectorAll('.ov').forEach(o => o.style.cursor = cur);
  $('iMode').textContent = m;
}

// ── Zoom ──────────────────────────────────────────────────────────
async function setZoom(z) {
  S.zoom = Math.min(4, Math.max(.2, z));
  const pct = Math.round(S.zoom * 100) + '%';
  $('zl').textContent = pct;
  $('iZoom').textContent = pct;
  // Update zoom button active state
  document.querySelectorAll('.cbtn[id^="btnZoom"]').forEach(b => b.classList.remove('act'));
  const zmap = { 50:'btnZoom50', 100:'btnZoom100', 150:'btnZoom150', 200:'btnZoom200' };
  const key = Math.round(S.zoom * 100);
  if (zmap[key]) $(zmap[key]).classList.add('act');
  if (S.doc) await renderAll();
}

// ── Page navigation ───────────────────────────────────────────────
function goTo(n) {
  S.page = Math.max(1, Math.min(S.total, n));
  const el = $('p' + S.page);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateNav();
  // sync thumbnails
  document.querySelectorAll('.th').forEach(t =>
    t.classList.toggle('act', +t.dataset.n === S.page));
}

function updateNav() {
  $('pi').textContent   = 'Page ' + S.page + ' / ' + S.total;
  $('btnPrev').disabled = S.page <= 1;
  $('btnNext').disabled = S.page >= S.total;
}

// ── Thumbnails ────────────────────────────────────────────────────
async function buildThumbs() {
  const box = $('thumbs');
  box.innerHTML = '';
  for (let i = 1; i <= S.total; i++) {
    const pg = await S.doc.getPage(i);
    const vw = pg.getViewport({ scale: .15, rotation: S.rots[i] || 0 });
    const c  = document.createElement('canvas');
    c.width = vw.width; c.height = vw.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vw }).promise;
    const item = document.createElement('div');
    item.className = 'th' + (i === S.page ? ' act' : '');
    item.dataset.n = i;
    const num = document.createElement('div');
    num.className = 'thn'; num.textContent = i;
    item.append(c, num);
    item.addEventListener('click', () => goTo(i));
    box.appendChild(item);
  }
}

// ── Page operations ───────────────────────────────────────────────
async function rotatePage(dir) {
  if (!S.doc) { toast('⚠️ Open a PDF first'); return; }
  const n = S.page;
  S.rots[n] = ((S.rots[n] || 0) + (dir === 'L' ? 270 : 90)) % 360;
  await rerenderPage(n);
  // Refresh thumbnail for this page
  const pg = await S.doc.getPage(n);
  const vw = pg.getViewport({ scale: .15, rotation: S.rots[n] });
  const th = document.querySelector('.th[data-n="' + n + '"]');
  if (th) {
    const c = th.querySelector('canvas');
    c.width = vw.width; c.height = vw.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vw }).promise;
  }
  toast('🔄 Page ' + n + ' rotated ' + (dir === 'L' ? 'left' : 'right'));
}

function deletePage() {
  if (!S.doc || S.total < 2) { toast('⚠️ Cannot delete the only page'); return; }
  if (!confirm('Delete page ' + S.page + '?')) return;
  pushUndo();
  const n = S.page;

  // Remove DOM element
  const el = $('p' + n); if (el) el.remove();

  // Shift annotations: pages > n shift down by 1
  const newAnns = {};
  for (const [k, v] of Object.entries(S.anns)) {
    const ki = +k;
    if (ki < n)  newAnns[ki]   = v;
    if (ki > n)  newAnns[ki-1] = v;
    // ki === n: dropped
  }
  S.anns = newAnns;

  // Shift rotations
  const newRots = {};
  for (const [k, v] of Object.entries(S.rots)) {
    const ki = +k;
    if (ki < n)  newRots[ki]   = v;
    if (ki > n)  newRots[ki-1] = v;
  }
  S.rots = newRots;

  // Renumber DOM pages above deleted
  for (let i = n + 1; i <= S.total; i++) {
    const w = $('p' + i);
    if (w) {
      w.id = 'p' + (i - 1);
      const badge = w.querySelector('.pgnum');
      if (badge) badge.textContent = i - 1;
      const ov = w.querySelector('.ov');
      if (ov) ov.dataset.n = i - 1;
    }
  }

  S.total--;
  if (S.page > S.total) S.page = S.total;
  updateNav(); buildThumbs(); updateInfo();
  toast('🗑️ Page deleted');
}

function addBlankPage() {
  S.total++;
  const n   = S.total;
  const W   = Math.round(595 * S.zoom);
  const H   = Math.round(842 * S.zoom);

  const wrap = document.createElement('div');
  wrap.className = 'pgw';
  wrap.id = 'p' + n;
  wrap.style.width  = W + 'px';
  wrap.style.height = H + 'px';

  const rc = document.createElement('canvas');
  rc.className = 'rc'; rc.width = W; rc.height = H;
  const rctx = rc.getContext('2d');
  rctx.fillStyle = '#ffffff'; rctx.fillRect(0, 0, W, H);

  const dc = document.createElement('canvas');
  dc.className = 'dc'; dc.width = W; dc.height = H;
  dc.style.width = W + 'px'; dc.style.height = H + 'px';

  const ov = document.createElement('div');
  ov.className = 'ov'; ov.dataset.n = n;
  attachEvents(ov, n, dc);

  const badge = document.createElement('div');
  badge.className = 'pgnum'; badge.textContent = n;

  wrap.append(rc, dc, ov, badge);
  pgs.appendChild(wrap);

  S.total = n;
  updateNav(); buildThumbs(); goTo(n); updateInfo();
  toast('➕ Blank page inserted');
}

// ── Save PDF ──────────────────────────────────────────────────────
async function savePDF() {
  if (!S.total) { toast('⚠️ Nothing to save'); return; }
  toast('⏳ Building PDF…');
  progress(10);
  await tick();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'px', compress: true });
  doc.deletePage(1);

  for (let i = 1; i <= S.total; i++) {
    progress(10 + Math.round((i / S.total) * 80));
    const wrap = $('p' + i); if (!wrap) continue;
    const rc = wrap.querySelector('canvas.rc');
    const dc = wrap.querySelector('canvas.dc');
    const W = rc.width, H = rc.height;

    // Composite onto temp canvas
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(rc, 0, 0);
    if (dc) ctx.drawImage(dc, 0, 0);

    const orient = W > H ? 'l' : 'p';
    doc.addPage([W, H], orient);
    doc.addImage(tmp.toDataURL('image/jpeg', .93), 'JPEG', 0, 0, W, H);
    await tick();
  }

  const safeName = (S.name || 'document').replace(/\.pdf$/i, '');
  doc.save(safeName + '_edited.pdf');
  progress(100);
  setTimeout(() => progress(0), 600);
  toast('✅ PDF saved!');
}

// ── Compress ──────────────────────────────────────────────────────
async function compressPDF() {
  if (!S.total) { toast('⚠️ Open a PDF first'); return; }
  toast('⏳ Compressing…');
  progress(10);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'px', compress: true });
  doc.deletePage(1);
  for (let i = 1; i <= S.total; i++) {
    progress(10 + Math.round((i / S.total) * 80));
    const wrap = $('p' + i); if (!wrap) continue;
    const rc = wrap.querySelector('canvas.rc');
    const W = rc.width, H = rc.height;
    doc.addPage([W, H], W > H ? 'l' : 'p');
    doc.addImage(rc.toDataURL('image/jpeg', .42), 'JPEG', 0, 0, W, H);
    await tick();
  }
  doc.save((S.name || 'document').replace(/\.pdf$/i,'') + '_compressed.pdf');
  progress(100); setTimeout(() => progress(0), 600);
  toast('✅ Compressed PDF saved!');
}

// ── Watermark ─────────────────────────────────────────────────────
function applyWatermark() {
  const txt = $('wmTxt').value.trim();
  if (!txt) { toast('⚠️ Enter watermark text'); return; }
  S.wm = {
    text:     txt,
    opacity:  +$('wmOp').value,
    color:    $('wmCol').value,
    fontSize: +$('wmSz').value || 0,
  };
  closeModal('wmMod');
  redrawAll();
  toast('💧 Watermark applied to all pages');
}

// ── Extract pages ─────────────────────────────────────────────────
async function extractPages() {
  if (!S.total) { toast('⚠️ Open a PDF first'); return; }
  const raw = $('exRng').value.trim();
  let nums;
  if (!raw) {
    // Split all pages
    nums = Array.from({ length: S.total }, (_, i) => i + 1);
    toast('⏳ Splitting into ' + S.total + ' files…');
  } else {
    nums = parseRange(raw);
    if (!nums.length) { toast('❌ Invalid range'); return; }
    toast('⏳ Extracting pages…');
  }

  const { jsPDF } = window.jspdf;
  if (!raw) {
    // Individual files
    for (const n of nums) {
      const wrap = $('p' + n); if (!wrap) continue;
      const rc = wrap.querySelector('canvas.rc');
      const dc = wrap.querySelector('canvas.dc');
      const tmp = document.createElement('canvas');
      tmp.width = rc.width; tmp.height = rc.height;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(rc, 0, 0); if (dc) ctx.drawImage(dc, 0, 0);
      const d = new jsPDF({ unit:'px', compress:true });
      d.deletePage(1);
      d.addPage([rc.width, rc.height]);
      d.addImage(tmp.toDataURL('image/jpeg',.9), 'JPEG', 0, 0, rc.width, rc.height);
      d.save('page_' + n + '.pdf');
      await tick();
    }
  } else {
    const doc = new jsPDF({ unit:'px', compress:true });
    doc.deletePage(1);
    for (const n of nums) {
      const wrap = $('p' + n); if (!wrap) continue;
      const rc = wrap.querySelector('canvas.rc');
      const dc = wrap.querySelector('canvas.dc');
      const tmp = document.createElement('canvas');
      tmp.width = rc.width; tmp.height = rc.height;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(rc, 0, 0); if (dc) ctx.drawImage(dc, 0, 0);
      doc.addPage([rc.width, rc.height]);
      doc.addImage(tmp.toDataURL('image/jpeg',.9), 'JPEG', 0, 0, rc.width, rc.height);
    }
    doc.save('extracted.pdf');
  }

  closeModal('exMod');
  toast('✅ Done!');
}

function parseRange(s) {
  const out = new Set();
  s.split(',').forEach(p => {
    p = p.trim();
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number);
      for (let i = a; i <= Math.min(b, S.total); i++) if (i >= 1) out.add(i);
    } else {
      const n = +p;
      if (n >= 1 && n <= S.total) out.add(n);
    }
  });
  return [...out].sort((a, b) => a - b);
}

// ── PDF → Images ──────────────────────────────────────────────────
async function pdfToImages() {
  if (!S.total) { toast('⚠️ Open a PDF first'); return; }
  toast('⏳ Exporting pages as PNG…');
  for (let i = 1; i <= S.total; i++) {
    const wrap = $('p' + i); if (!wrap) continue;
    const rc = wrap.querySelector('canvas.rc');
    const dc = wrap.querySelector('canvas.dc');
    const tmp = document.createElement('canvas');
    tmp.width = rc.width; tmp.height = rc.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(rc, 0, 0); if (dc) ctx.drawImage(dc, 0, 0);
    const a = document.createElement('a');
    a.href     = tmp.toDataURL('image/png');
    a.download = (S.name.replace(/\.pdf$/i,'') || 'doc') + '_page' + i + '.png';
    a.click();
    await new Promise(r => setTimeout(r, 180));
  }
  toast('✅ Images downloaded!');
}

// ── Images → PDF ──────────────────────────────────────────────────
async function imagesToPDF(files) {
  if (!files.length) return;
  toast('⏳ Creating PDF from images…');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'px', compress: true });
  doc.deletePage(1);
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const img = await loadImg(url);
    const W = img.naturalWidth, H = img.naturalHeight;
    doc.addPage([W, H], W > H ? 'l' : 'p');
    const fmt = f.type.includes('png') ? 'PNG' : 'JPEG';
    doc.addImage(img, fmt, 0, 0, W, H);
    URL.revokeObjectURL(url);
    await tick();
  }
  doc.save('from_images.pdf');
  toast('✅ PDF created from ' + files.length + ' image(s)!');
}

// ── Merge PDFs ────────────────────────────────────────────────────
async function mergePDFs(files) {
  const pdfs = [...files].filter(f => f.name.match(/\.pdf$/i));
  if (pdfs.length < 2) { toast('⚠️ Select 2 or more PDF files'); return; }
  toast('⏳ Merging ' + pdfs.length + ' PDFs…');
  progress(5);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'px', compress: true });
  doc.deletePage(1);
  for (let fi = 0; fi < pdfs.length; fi++) {
    progress(5 + Math.round((fi / pdfs.length) * 88));
    const buf = await pdfs[fi].arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const vw = pg.getViewport({ scale: 1.5 });
      const c  = document.createElement('canvas');
      c.width = vw.width; c.height = vw.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vw }).promise;
      doc.addPage([vw.width, vw.height]);
      doc.addImage(c.toDataURL('image/jpeg', .88), 'JPEG', 0, 0, vw.width, vw.height);
      await tick();
    }
  }
  doc.save('merged.pdf');
  progress(100); setTimeout(() => progress(0), 600);
  toast('✅ Merged PDF saved!');
}

// ── Modals ────────────────────────────────────────────────────────
function openModal(id)  { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

// ── Tool → action map (from popup URL param) ──────────────────────
function activateTool(t) {
  const m = {
    annotate:  () => setMode('text'),
    text:      () => setMode('text'),
    draw:      () => setMode('draw'),
    highlight: () => setMode('highlight'),
    shape:     () => setMode('shape'),
    erase:     () => setMode('erase'),
    compress:  () => compressPDF(),
    rotate:    () => rotatePage('R'),
    watermark: () => openModal('wmMod'),
    extract:   () => openModal('exMod'),
    split:     () => openModal('exMod'),
    merge:     () => $('fi2').click(),
    pdf2img:   () => pdfToImages(),
    img2pdf:   () => $('fi3').click(),
  };
  if (m[t]) m[t]();
}

// ── Info panel ────────────────────────────────────────────────────
function updateInfo() {
  $('iFile').textContent  = S.name  || '—';
  $('iPages').textContent = S.total || '—';
  $('iSize').textContent  = S.size  ? fmtBytes(S.size) : '—';
  const total = Object.values(S.anns).reduce((s, a) => s + a.length, 0);
  $('iAnns').textContent  = total;
}

// ── Utilities ─────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });
}

function tick() { return new Promise(r => setTimeout(r, 0)); }

let _toastTid;
function toast(msg, dur = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTid);
  _toastTid = setTimeout(() => t.classList.remove('show'), dur);
}

// ── Property panel wiring ─────────────────────────────────────────
function wireProps() {
  // Range → label
  [[$('pSize'), $('pSizeV')], [$('pSW'), $('pSWV')], [$('pOp'), $('pOpV')]].forEach(([r, l]) =>
    r.addEventListener('input', () => l.textContent = r.value));

  // Color picker ↔ hex text
  [[$('pTC'), $('pTH')], [$('pSC'), $('pSH')], [$('pHC'), $('pHH')]].forEach(([p, h]) => {
    p.addEventListener('input', () => h.value = p.value.toUpperCase());
    h.addEventListener('change', () => { try { p.value = h.value; } catch {} });
  });
}

// ── Bind all events ───────────────────────────────────────────────
function bindAll() {
  // File inputs
  $('fi').addEventListener('change', e => { if (e.target.files[0]) { loadFile(e.target.files[0]); e.target.value=''; } });
  $('fi2').addEventListener('change', e => { mergePDFs(e.target.files); e.target.value=''; });
  $('fi3').addEventListener('change', e => { imagesToPDF([...e.target.files]); e.target.value=''; });

  // Drop on viewport
  vp.addEventListener('dragover', e => e.preventDefault());
  vp.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.name.match(/\.pdf$/i)) loadFile(f);
  });

  // Drop overlay
  $('dboxBtn').addEventListener('click', () => $('fi').click());
  const db = $('dbox');
  db.addEventListener('dragover', e => { e.preventDefault(); db.classList.add('on'); });
  db.addEventListener('dragleave', () => db.classList.remove('on'));
  db.addEventListener('drop', e => {
    e.preventDefault(); db.classList.remove('on');
    const f = e.dataTransfer.files[0]; if (f) loadFile(f);
  });

  // Topbar
  $('btnOpen').addEventListener('click',  () => $('fi').click());
  $('btnSave').addEventListener('click',  savePDF);
  $('btnUndo').addEventListener('click',  undo);
  $('btnRedo').addEventListener('click',  redo);
  $('btnPrint').addEventListener('click', () => window.print());

  // Zoom
  $('btnZO').addEventListener('click',     () => setZoom(S.zoom - .15));
  $('btnZI').addEventListener('click',     () => setZoom(S.zoom + .15));
  $('btnFit').addEventListener('click',    () => setZoom(1));
  $('btnZoom50').addEventListener('click', () => setZoom(.5));
  $('btnZoom100').addEventListener('click',() => setZoom(1));
  $('btnZoom150').addEventListener('click',() => setZoom(1.5));
  $('btnZoom200').addEventListener('click',() => setZoom(2));

  // Page nav
  $('btnPrev').addEventListener('click', () => goTo(S.page - 1));
  $('btnNext').addEventListener('click', () => goTo(S.page + 1));

  // Mode buttons
  document.querySelectorAll('.si[data-mode]').forEach(b =>
    b.addEventListener('click', () => setMode(b.dataset.mode)));

  // Sidebar tool buttons
  $('siRL').addEventListener('click',  () => rotatePage('L'));
  $('siRR').addEventListener('click',  () => rotatePage('R'));
  $('siDP').addEventListener('click',  deletePage);
  $('siAP').addEventListener('click',  addBlankPage);
  $('siMrg').addEventListener('click', () => $('fi2').click());
  $('siWM').addEventListener('click',  () => openModal('wmMod'));
  $('siCmp').addEventListener('click', compressPDF);
  $('siExt').addEventListener('click', () => openModal('exMod'));
  $('siP2I').addEventListener('click', pdfToImages);
  $('siI2P').addEventListener('click', () => $('fi3').click());

  // Right sidebar tabs
  document.querySelectorAll('.rtab').forEach(t =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.rtab,.rp').forEach(x => x.classList.remove('act'));
      t.classList.add('act');
      $('tab-' + t.dataset.tab).classList.add('act');
    }));

  // Modals
  $('wmApp').addEventListener('click',  applyWatermark);
  $('wmCan').addEventListener('click',  () => closeModal('wmMod'));
  $('exApp').addEventListener('click',  extractPages);
  $('exCan').addEventListener('click',  () => closeModal('exMod'));
  [$('wmMod'), $('exMod')].forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));

  // Scroll → track current page
  vp.addEventListener('scroll', () => {
    const wrappers = [...pgs.querySelectorAll('.pgw')];
    let cur = 1;
    for (const w of wrappers) {
      if (w.offsetTop - vp.scrollTop - 60 <= 0) cur = +w.id.replace('p', '');
    }
    if (cur !== S.page) {
      S.page = cur; updateNav();
      document.querySelectorAll('.th').forEach(t =>
        t.classList.toggle('act', +t.dataset.n === cur));
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.contentEditable === 'true' || e.target.tagName === 'INPUT') return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta) {
      if (e.key === 'z') { e.preventDefault(); undo(); }
      if (e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 's') { e.preventDefault(); savePDF(); }
      if (e.key === 'o') { e.preventDefault(); $('fi').click(); }
    } else {
      const km = { v:'select', t:'text', d:'draw', h:'highlight', s:'shape', e:'erase' };
      if (km[e.key]) setMode(km[e.key]);
    }
  });
}
