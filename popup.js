'use strict';
// PDF Forge — Popup v2.0
// Fix: large files stored in IndexedDB (bypasses 10MB chrome.storage limit)

const dz     = document.getElementById('dz');
const fi     = document.getElementById('fi');
const fc     = document.getElementById('fc');
const fcName = document.getElementById('fcName');
const fcSize = document.getElementById('fcSize');
const fcX    = document.getElementById('fcX');
const openBtn= document.getElementById('openBtn');

// ── IndexedDB helper (no size limit unlike chrome.storage) ───────
const DB_NAME = 'PDFForge', DB_VER = 1, STORE = 'files';

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = res;
    tx.onerror = e => rej(e.target.error);
  });
}

// ── File handling ─────────────────────────────────────────────────
async function loadFile(file) {
  if (!file || !file.name.match(/\.pdf$/i)) {
    alert('Please select a PDF file.');
    return;
  }
  fcName.textContent = file.name;
  fcSize.textContent = fmt(file.size) + ' · PDF';
  dz.style.display = 'none';
  fc.classList.add('show');

  // Read as ArrayBuffer and store in IndexedDB — works for any size
  const buf = await file.arrayBuffer();
  await idbSet('pdf', { name: file.name, size: file.size, buf });
}

fcX.addEventListener('click', async () => {
  dz.style.display = '';
  fc.classList.remove('show');
  fi.value = '';
  await idbDel('pdf');
});

// ── File input & drag/drop ────────────────────────────────────────
document.getElementById('brBtn').addEventListener('click', () => fi.click());
fi.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });

dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('on'); });
dz.addEventListener('dragleave', () => dz.classList.remove('on'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('on');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

// ── Open editor ───────────────────────────────────────────────────
openBtn.addEventListener('click', () => launch(''));

document.querySelectorAll('[data-tool]').forEach(b =>
  b.addEventListener('click', () => launch('?tool=' + b.dataset.tool)));

function launch(query) {
  const url = chrome.runtime.getURL('editor.html') + query;
  chrome.tabs.create({ url });
}

// ── Format bytes ──────────────────────────────────────────────────
function fmt(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}
