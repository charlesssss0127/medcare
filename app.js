/* ============================================================
   MedCare — medication tracking PWA
   Single-file app logic: IndexedDB, scheduler, views, camera, PIN
   ============================================================ */

'use strict';

/* ---------------- Constants ---------------- */

const DB_NAME = 'medcare';
const DB_VERSION = 1;
const STORES = ['profile', 'medications', 'schedule', 'records', 'settings'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SKIP_REASONS = [
  {
    id: 'refused', en: 'Refused', zh: '發脾氣拒絕',
    svg: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="27" fill="#ffcdd2" stroke="#c62828" stroke-width="2.5"/><path d="M17 23 L28 27" stroke="#c62828" stroke-width="3.5" stroke-linecap="round"/><path d="M47 23 L36 27" stroke="#c62828" stroke-width="3.5" stroke-linecap="round"/><circle cx="24" cy="33" r="2.8" fill="#c62828"/><circle cx="40" cy="33" r="2.8" fill="#c62828"/><path d="M23 47 Q32 40 41 47" fill="none" stroke="#c62828" stroke-width="3.5" stroke-linecap="round"/></svg>',
  },
  {
    id: 'asleep', en: 'Asleep', zh: '瞓咗',
    svg: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="30" cy="34" r="25" fill="#e3f0fb" stroke="#1565c0" stroke-width="2.5"/><path d="M17 32 Q22 37 27 32" fill="none" stroke="#1565c0" stroke-width="3" stroke-linecap="round"/><path d="M33 32 Q38 37 43 32" fill="none" stroke="#1565c0" stroke-width="3" stroke-linecap="round"/><circle cx="30" cy="44" r="3.5" fill="none" stroke="#1565c0" stroke-width="2.5"/><path d="M44 13 h9 l-9 9 h9" fill="none" stroke="#1565c0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    id: 'unwell', en: 'Feeling unwell', zh: '唔舒服',
    svg: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="27" fill="#e8f5e9" stroke="#2e7d32" stroke-width="2.5"/><path d="M18 31 Q23 28 28 31" fill="none" stroke="#2e7d32" stroke-width="3" stroke-linecap="round"/><path d="M36 31 Q41 28 46 31" fill="none" stroke="#2e7d32" stroke-width="3" stroke-linecap="round"/><path d="M22 45 q5 -5 10 0 t10 0" fill="none" stroke="#2e7d32" stroke-width="3" stroke-linecap="round"/></svg>',
  },
  {
    id: 'other', en: 'Other', zh: '其他',
    svg: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="27" fill="#eef1f5" stroke="#54677a" stroke-width="2.5"/><path d="M25 25 q0 -8 8 -8 q9 0 9 8 q0 6 -7 8 q-2 1 -2 5" fill="none" stroke="#54677a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="33" cy="45" r="2.8" fill="#54677a"/></svg>',
  },
];

const DELAY_OPTIONS = [15, 30, 60]; // minutes

/* ---------------- Global state ---------------- */

let db = null;
let state = {
  profile: null,
  medications: [],
  schedule: [],
  settings: null,
  todayRecords: [],      // records for today, keyed lookup below
  calMonth: null,        // Date for history calendar
  calSelected: null,     // 'YYYY-MM-DD'
};

let alarmAudio = null;   // Web Audio controller
let activeAlarmSession = null; // session id currently alarming
const snoozedUntil = {}; // sessionId -> timestamp ms

/* ============================================================
   IndexedDB layer
   ============================================================ */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('profile')) d.createObjectStore('profile', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('medications')) d.createObjectStore('medications', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('schedule')) d.createObjectStore('schedule', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('records')) {
        const rs = d.createObjectStore('records', { keyPath: 'id' });
        rs.createIndex('date', 'date', { unique: false });
      }
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function dbGet(store, key) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readonly').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function dbGetAll(store) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readonly').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

function dbPut(store, value) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readwrite').put(value);
    r.onsuccess = () => res(value);
    r.onerror = () => rej(r.error);
  });
}

function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readwrite').delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

/* ============================================================
   Utilities
   ============================================================ */

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fmtTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${pad2(m)} ${ap}`;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------- Image compression ---------- */

// Reads a File, downscales to max 1280px, returns a JPEG Blob (~quality 0.8)
function compressImage(file, maxDim = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('compress failed')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

// object URL cache for blobs so we don't leak
const _urlCache = new WeakMap();
function blobUrl(blob) {
  if (!blob) return null;
  if (_urlCache.has(blob)) return _urlCache.get(blob);
  const u = URL.createObjectURL(blob);
  _urlCache.set(blob, u);
  return u;
}

/* ============================================================
   Data load / seed
   ============================================================ */

async function loadState() {
  state.profile = await dbGet('profile', 'main');
  state.settings = await dbGet('settings', 'main');
  state.medications = await dbGetAll('medications');
  state.schedule = await dbGetAll('schedule');
  state.schedule.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
}

async function loadTodayRecords() {
  const today = ymd(new Date());
  const all = await dbGetAll('records');
  state.todayRecords = all.filter((r) => r.date === today);
}

async function seedSampleData() {
  const meds = [
    { id: uid('med'), nameEn: 'Amlodipine', nameZh: '血壓藥', dose: '5 mg · 1 tablet', note: 'For blood pressure · 降血壓', photo: null, active: true },
    { id: uid('med'), nameEn: 'Metformin', nameZh: '糖尿藥', dose: '500 mg · 1 tablet', note: 'After meal · 飯後食', photo: null, active: true },
    { id: uid('med'), nameEn: 'Atorvastatin', nameZh: '降膽固醇藥', dose: '10 mg · 1 tablet', note: 'At bedtime · 睡前', photo: null, active: true },
    { id: uid('med'), nameEn: 'Calcium + D3', nameZh: '鈣片', dose: '1 tablet', note: '', photo: null, active: true },
  ];
  for (const m of meds) await dbPut('medications', m);

  const sched = [
    { id: uid('ses'), nameEn: 'Morning', nameZh: '早上', time: '08:00', medIds: [meds[0].id, meds[1].id], days: [0, 1, 2, 3, 4, 5, 6] },
    { id: uid('ses'), nameEn: 'Noon', nameZh: '中午', time: '12:30', medIds: [meds[1].id, meds[3].id], days: [0, 1, 2, 3, 4, 5, 6] },
    { id: uid('ses'), nameEn: 'Evening', nameZh: '晚上', time: '18:00', medIds: [meds[1].id], days: [0, 1, 2, 3, 4, 5, 6] },
    { id: uid('ses'), nameEn: 'Bedtime', nameZh: '睡前', time: '21:00', medIds: [meds[2].id], days: [0, 1, 2, 3, 4, 5, 6] },
  ];
  for (const s of sched) await dbPut('schedule', s);
}

/* ============================================================
   Session status computation
   ============================================================ */

// Which sessions apply today, sorted by time, each with its record (if any)
function todaySessions() {
  const dow = new Date().getDay();
  return state.schedule
    .filter((s) => s.days.includes(dow) && isSessionActive(s))
    .map((s) => ({ session: s, record: state.todayRecords.find((r) => r.sessionId === s.id) || null }))
    .sort((a, b) => timeToMinutes(a.session.time) - timeToMinutes(b.session.time));
}

// A session shows up if it either lists specific meds, or is a "prepared" session
// (family already sorted the pills into a box — helper just confirms + photo).
function isSessionActive(s) {
  return s.prepared === true || (s.medIds && s.medIds.length > 0);
}

// status: 'done' | 'late' | 'skipped' | 'due' | 'upcoming' | 'missed'
const DUE_WINDOW = 60;      // minutes after scheduled time still "due" before missed
function sessionStatus(entry) {
  if (entry.record) {
    if (entry.record.status === 'skipped') return 'skipped';
    if (entry.record.status === 'taken-late') return 'late';
    return 'done';
  }
  const t = timeToMinutes(entry.session.time);
  const now = nowMinutes();
  const snz = snoozedUntil[entry.session.id];
  if (snz && Date.now() < snz) return 'upcoming';
  if (now < t) return 'upcoming';
  if (now <= t + DUE_WINDOW) return 'due';
  return 'missed';
}

function medsFor(session) {
  return session.medIds.map((id) => state.medications.find((m) => m.id === id)).filter(Boolean);
}

/* ============================================================
   Rendering — Today
   ============================================================ */

function renderToday() {
  const list = document.getElementById('todayList');
  list.innerHTML = '';
  const sessions = todaySessions();

  if (sessions.length === 0) {
    list.appendChild(el('div', { class: 'empty-note' },
      'No medications scheduled today. · 今日冇安排食藥。'));
    return;
  }

  for (const entry of sessions) {
    const status = sessionStatus(entry);
    const s = entry.session;
    const meds = medsFor(s);

    const badge = {
      done: el('span', { class: 'badge badge-green' }, '✅ Taken · 已食'),
      late: el('span', { class: 'badge badge-amber' }, '🕐 Late · 遲咗食'),
      skipped: el('span', { class: 'badge badge-red' }, '⚠️ Skipped · 跳過'),
      due: el('span', { class: 'badge badge-amber' }, '⏰ Due now · 到鐘'),
      upcoming: el('span', { class: 'badge badge-gray' }, '🕒 Upcoming · 未到'),
      missed: el('span', { class: 'badge badge-red' }, '❗ Missed · 未記錄'),
    }[status];

    const medList = el('div', { class: 'med-list' });
    if (meds.length === 0) {
      medList.appendChild(el('div', { class: 'med-row' },
        el('div', { class: 'med-thumb ph' }, '📦'),
        el('div', {},
          el('span', { class: 'med-name' }, 'Prepared medicine'),
          el('span', { class: 'zh' }, ' 家人準備好嘅藥'),
          el('div', { class: 'med-dose' }, 'Take from the pill box · 食藥盒入面嗰格')
        )
      ));
    }
    for (const m of meds) {
      const thumb = m.photo
        ? el('img', { class: 'med-thumb', src: blobUrl(m.photo), alt: '' })
        : el('div', { class: 'med-thumb ph' }, '💊');
      medList.appendChild(el('div', { class: 'med-row' },
        thumb,
        el('div', {},
          el('span', { class: 'med-name' }, m.nameEn),
          el('span', { class: 'zh' }, ' ' + (m.nameZh || '')),
          el('div', { class: 'med-dose' }, m.dose || '')
        )
      ));
    }

    const card = el('div', {
      class: 'card session-card' + (status === 'due' || status === 'missed' ? ' due' : ''),
      onclick: () => openSessionFlow(s.id),
    },
      el('div', { class: 'session-time' },
        el('div', { class: 't' }, fmtTime12(s.time).replace(/ (AM|PM)/, '')),
        el('div', { class: 'n' }, fmtTime12(s.time).slice(-2))
      ),
      el('div', { class: 'session-body' },
        el('div', { class: 'session-head' },
          el('span', { class: 'session-name' }, s.nameEn),
          el('span', { class: 'zh', style: 'font-size:1.05rem' }, s.nameZh || ''),
          badge
        ),
        medList,
        entry.record && entry.record.status === 'skipped'
          ? el('div', { class: 'rec-note', style: 'margin-top:0.5rem' },
            'Reason · 原因: ' + skipReasonLabel(entry.record.skipReason) +
            (entry.record.skipNote ? ' — ' + entry.record.skipNote : ''))
          : null
      )
    );
    list.appendChild(card);
  }
}

function skipReasonLabel(id) {
  const r = SKIP_REASONS.find((x) => x.id === id);
  return r ? `${r.en} · ${r.zh}` : (id || '—');
}

// Label for a record's medicines — handles "prepared" sessions with no specific list
function recMedsLabel(r) {
  if (r.prepared || !r.medNames || r.medNames.length === 0) return 'Prepared medicine · 家人準備好嘅藥';
  return r.medNames.join(', ');
}

/* ============================================================
   Overlays helper
   ============================================================ */

function showOverlay(node) {
  const root = document.getElementById('overlayRoot');
  root.innerHTML = '';
  root.appendChild(node);
}

function closeOverlay() {
  document.getElementById('overlayRoot').innerHTML = '';
}

/* ============================================================
   Session recording flow
   ============================================================ */

let flowState = null; // { sessionId, checked:Set, photoBlob }

function openSessionFlow(sessionId) {
  const s = state.schedule.find((x) => x.id === sessionId);
  if (!s) return;
  const rec = state.todayRecords.find((r) => r.sessionId === sessionId);
  if (rec) { openRecordDetail(rec); return; }  // already recorded → view only (immutable)

  flowState = { sessionId, checked: new Set(), photoBlob: null };
  renderFlowStep1();
}

function renderFlowStep1() {
  const s = state.schedule.find((x) => x.id === flowState.sessionId);
  const meds = medsFor(s);
  const prepared = meds.length === 0;

  const checklist = el('div', {});
  if (prepared) {
    checklist.appendChild(el('div', { class: 'check-row', style: 'cursor:default' },
      el('div', { class: 'med-thumb ph', style: 'width:52px;height:52px' }, '📦'),
      el('div', { class: 'grow' },
        el('div', { class: 'med-name', style: 'font-size:1.2rem' }, 'Prepared medicine '),
        el('span', { class: 'zh' }, '家人準備好嘅藥'),
        el('div', { class: 'rec-note' }, 'Give the pills from the box, then take a photo · 俾藥盒嗰格啲藥，然後影相')
      )
    ));
  }
  for (const m of meds) {
    const row = el('div', {
      class: 'check-row' + (flowState.checked.has(m.id) ? ' checked' : ''),
      onclick: function () {
        if (flowState.checked.has(m.id)) flowState.checked.delete(m.id);
        else flowState.checked.add(m.id);
        this.classList.toggle('checked');
        this.querySelector('.checkbox').textContent = flowState.checked.has(m.id) ? '✓' : '';
      },
    },
      el('div', { class: 'checkbox' }, flowState.checked.has(m.id) ? '✓' : ''),
      m.photo ? el('img', { class: 'med-thumb', src: blobUrl(m.photo) }) : el('div', { class: 'med-thumb ph' }, '💊'),
      el('div', { class: 'grow' },
        el('div', { class: 'med-name', style: 'font-size:1.2rem' }, m.nameEn + ' '),
        el('span', { class: 'zh' }, m.nameZh || ''),
        el('div', { class: 'med-dose' }, m.dose || ''),
        m.note ? el('div', { class: 'rec-note' }, m.note) : null
      )
    );
    checklist.appendChild(row);
  }

  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: closeOverlay }, '✕'),
    el('h2', {}, `${s.nameEn} · ${s.nameZh || ''}`),
    el('div', { class: 'sub' }, prepared
      ? `${fmtTime12(s.time)} — Confirm the prepared medicine · 確認食咗準備好嘅藥`
      : `${fmtTime12(s.time)} — Check each medicine · 逐隻藥剔一剔`),
    checklist,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-green btn-block', onclick: () => renderFlowPhoto() }, '✓ Take now · 而家食'),
    ),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-amber', onclick: () => renderFlowDelay() }, '⏰ Delay · 延遲'),
      el('button', { class: 'btn btn-danger', onclick: () => renderFlowSkip() }, '✗ Skip · 跳過'),
    )
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

function renderFlowDelay() {
  const s = state.schedule.find((x) => x.id === flowState.sessionId);
  const btns = DELAY_OPTIONS.map((min) =>
    el('button', {
      class: 'btn btn-amber btn-xl', style: 'margin-bottom:0.8rem',
      onclick: () => {
        snoozedUntil[s.id] = Date.now() + min * 60000;
        stopAlarm();
        closeOverlay();
        toast(`Reminder in ${min} min · ${min} 分鐘後再提`);
        refreshCurrentTab();
      },
    }, `⏰ ${min} minutes · ${min} 分鐘`)
  );

  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: renderFlowStep1 }, '‹'),
    el('h2', {}, 'Delay reminder · 延遲提示'),
    el('div', { class: 'sub' }, 'Remind again later · 遲啲再提醒'),
    ...btns
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

function renderFlowSkip() {
  let selected = null;
  let noteText = '';

  const grid = el('div', { class: 'reason-grid' });
  const noteField = el('div', { class: 'field', style: 'display:none;margin-top:0.9rem' },
    el('label', {}, 'Please describe · 請說明'),
    el('textarea', { id: 'skipNote', placeholder: 'Optional note · 補充' })
  );
  const confirmBtn = el('button', { class: 'btn btn-danger btn-xl', disabled: '' }, 'Confirm skip · 確認跳過');

  for (const r of SKIP_REASONS) {
    const b = el('button', { class: 'reason-btn' },
      el('div', { class: 'reason-ill', html: r.svg }),
      el('div', { class: 'reason-en' }, r.en),
      el('div', { class: 'zh' }, r.zh));
    b.addEventListener('click', () => {
      selected = r.id;
      grid.querySelectorAll('.reason-btn').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      noteField.style.display = r.id === 'other' ? 'block' : 'none';
      confirmBtn.disabled = false;
    });
    grid.appendChild(b);
  }

  confirmBtn.addEventListener('click', async () => {
    if (!selected) return;
    const nt = document.getElementById('skipNote');
    noteText = nt ? nt.value.trim() : '';
    await saveRecord({ status: 'skipped', skipReason: selected, skipNote: noteText, photoBlob: null });
    stopAlarm();
    closeOverlay();
    toast('Recorded · 已記錄');
    refreshCurrentTab();
  });

  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: renderFlowStep1 }, '‹'),
    el('h2', {}, 'Why skipped? · 點解跳過？'),
    el('div', { class: 'sub' }, 'A reason is required · 必須揀原因'),
    grid, noteField,
    el('div', { style: 'margin-top:1rem' }, confirmBtn)
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

function renderFlowPhoto() {
  const s = state.schedule.find((x) => x.id === flowState.sessionId);
  const frame = el('div', { class: 'photo-frame' });
  const input = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: '' });
  const confirmBtn = el('button', { class: 'btn btn-green btn-xl', disabled: '' }, '✓ Confirm · 確認記錄');

  function paintEmpty() {
    frame.innerHTML = '';
    frame.appendChild(el('div', { class: 'cam-icon' }, '📷'));
    frame.appendChild(el('div', {}, 'Tap to take photo · 影一張相'));
  }
  paintEmpty();

  frame.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (!input.files || !input.files[0]) return;
    frame.innerHTML = '<div>Processing… · 處理緊…</div>';
    try {
      flowState.photoBlob = await compressImage(input.files[0]);
      frame.innerHTML = '';
      frame.appendChild(el('img', { src: blobUrl(flowState.photoBlob) }));
      confirmBtn.disabled = false;
    } catch (e) {
      paintEmpty();
      toast('Photo error · 相片出錯');
    }
  });

  confirmBtn.addEventListener('click', async () => {
    if (!flowState.photoBlob) return;
    const now = new Date();
    const late = timeToMinutes(s.time) + DUE_WINDOW < nowMinutes();
    await saveRecord({
      status: late ? 'taken-late' : 'taken',
      photoBlob: flowState.photoBlob,
      checkedMedIds: Array.from(flowState.checked),
    });
    stopAlarm();
    renderSuccess(s);
    refreshCurrentTab();
  });

  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: renderFlowStep1 }, '‹'),
    el('h2', {}, 'Take a photo · 影相為證'),
    el('div', { class: 'sub' }, 'Photo of grandma taking the medicine is required · 必須影低長者食藥嘅相'),
    frame, input,
    el('div', { style: 'margin-top:1rem' }, confirmBtn)
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

function renderSuccess(s) {
  const modal = el('div', { class: 'modal' },
    el('div', { class: 'success-screen' },
      el('div', { class: 'big' }, '✅'),
      el('h2', {}, 'Recorded! · 已記錄！'),
      el('p', { class: 'sub' }, `${s.nameEn} · ${s.nameZh || ''} — ${fmtTime12(s.time)}`),
      el('button', { class: 'btn btn-primary btn-xl', style: 'margin-top:1rem', onclick: closeOverlay }, 'Done · 完成')
    )
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

/* ---------- Save record (immutable) ---------- */

async function saveRecord({ status, photoBlob, skipReason, skipNote, checkedMedIds }) {
  const s = state.schedule.find((x) => x.id === flowState.sessionId);
  const now = new Date();
  const record = {
    id: uid('rec'),
    date: ymd(now),
    sessionId: s.id,
    sessionNameEn: s.nameEn,
    sessionNameZh: s.nameZh || '',
    scheduledTime: s.time,
    status,
    actualTime: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    createdAt: now.toISOString(),
    medIds: s.medIds.slice(),
    medNames: medsFor(s).map((m) => m.nameEn),
    prepared: medsFor(s).length === 0,
    checkedMedIds: checkedMedIds || [],
    skipReason: skipReason || null,
    skipNote: skipNote || '',
    photo: photoBlob || null,
    snoozeCount: snoozedUntil[s.id] ? 1 : 0,
  };
  await dbPut('records', record);
  delete snoozedUntil[s.id];
  await loadTodayRecords();
}

/* ============================================================
   Alarm (Web Audio)
   ============================================================ */

function initAudio() {
  if (alarmAudio) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  alarmAudio = { ctx, timer: null, nodes: [] };
}

function beep() {
  if (!alarmAudio) return;
  const { ctx } = alarmAudio;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.42);
}

function startAlarm() {
  initAudio();
  if (!alarmAudio) return;
  if (alarmAudio.ctx.state === 'suspended') alarmAudio.ctx.resume();
  if (alarmAudio.timer) return;
  beep();
  alarmAudio.timer = setInterval(() => { beep(); setTimeout(beep, 500); }, 1600);
}

function stopAlarm() {
  activeAlarmSession = null;
  if (alarmAudio && alarmAudio.timer) {
    clearInterval(alarmAudio.timer);
    alarmAudio.timer = null;
  }
  const ao = document.getElementById('alarmOverlay');
  if (ao) ao.remove();
}

function showAlarmOverlay(entry) {
  const s = entry.session;
  const meds = medsFor(s);
  const medsText = meds.length === 0
    ? '📦 Prepared medicine · 家人準備好嘅藥'
    : meds.map((m) => `${m.nameEn} ${m.nameZh || ''} — ${m.dose || ''}`).join('<br />');

  const overlay = el('div', { class: 'alarm-overlay', id: 'alarmOverlay' },
    el('div', { class: 'bell' }, '🔔'),
    el('h1', {}, 'Medication time!'),
    el('div', { style: 'font-size:1.6rem;margin-bottom:0.3rem' }, '食藥時間到！'),
    el('div', { class: 'alarm-time' }, `${s.nameEn} · ${s.nameZh || ''} — ${fmtTime12(s.time)}`),
    el('div', { class: 'alarm-meds', html: medsText || '—' }),
    el('div', { class: 'alarm-actions' },
      el('button', {
        class: 'btn btn-white', onclick: () => { stopAlarm(); openSessionFlow(s.id); },
      }, '✓ Record now · 記錄食藥'),
      el('button', {
        class: 'btn btn-outline', onclick: () => { stopAlarm(); flowState = { sessionId: s.id, checked: new Set(), photoBlob: null }; renderFlowDelay(); },
      }, '⏰ Delay · 延遲'),
      el('button', {
        class: 'btn btn-outline', onclick: () => { stopAlarm(); flowState = { sessionId: s.id, checked: new Set(), photoBlob: null }; renderFlowSkip(); },
      }, '✗ Skip · 跳過')
    )
  );
  document.body.appendChild(overlay);
  startAlarm();
}

/* ============================================================
   Scheduler tick (every 30s)
   ============================================================ */

function tick() {
  updateClock();
  if (!state.profile) return;

  // find a due session that is not recorded, not snoozed, and not already alarming
  if (!activeAlarmSession && !document.getElementById('alarmOverlay') && !document.querySelector('.overlay')) {
    for (const entry of todaySessions()) {
      if (sessionStatus(entry) === 'due') {
        const sid = entry.session.id;
        const snz = snoozedUntil[sid];
        if (snz && Date.now() < snz) continue;
        activeAlarmSession = sid;
        showAlarmOverlay(entry);
        break;
      }
    }
  }

  // keep Today fresh so badges update
  if (currentTab === 'today' && !document.querySelector('.overlay')) renderToday();
}

function updateClock() {
  const d = new Date();
  const clock = document.getElementById('barClock');
  const date = document.getElementById('barDate');
  if (clock) clock.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (date) date.textContent = `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} · 星期${DOW_ZH[d.getDay()]}`;
}

/* ============================================================
   History view
   ============================================================ */

async function renderHistory() {
  const all = await dbGetAll('records');
  renderStats(all);
  renderCalendar(all);
}

function adherenceForDays(all, days) {
  const today = new Date();
  let expected = 0, taken = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const dstr = ymd(d);
    const dow = d.getDay();
    const sessions = state.schedule.filter((s) => s.days.includes(dow) && isSessionActive(s));
    for (const s of sessions) {
      // only count sessions whose time has passed (for today)
      if (i === 0 && timeToMinutes(s.time) > nowMinutes()) continue;
      expected++;
      const rec = all.find((r) => r.date === dstr && r.sessionId === s.id);
      if (rec && (rec.status === 'taken' || rec.status === 'taken-late')) taken++;
    }
  }
  if (expected === 0) return null;
  return Math.round((taken / expected) * 100);
}

function renderStats(all) {
  const a7 = adherenceForDays(all, 7);
  const a30 = adherenceForDays(all, 30);
  document.getElementById('stat7').textContent = a7 == null ? '–' : a7 + '%';
  document.getElementById('stat30').textContent = a30 == null ? '–' : a30 + '%';
}

function renderCalendar(all) {
  if (!state.calMonth) state.calMonth = new Date();
  const m = state.calMonth;
  document.getElementById('calTitle').textContent = `${MONTHS[m.getMonth()]} ${m.getFullYear()}`;

  const dowRow = document.getElementById('calDow');
  dowRow.innerHTML = '';
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => dowRow.appendChild(el('div', { class: 'cal-dow' }, d)));

  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const todayStr = ymd(new Date());

  for (let i = 0; i < first.getDay(); i++) grid.appendChild(el('div', { class: 'cal-cell empty' }));

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(m.getFullYear(), m.getMonth(), day);
    const dstr = ymd(d);
    const isFuture = d > new Date(new Date().setHours(23, 59, 59, 999));
    const recs = all.filter((r) => r.date === dstr);

    let dotClass = 'dot-gray';
    if (recs.length) {
      if (recs.some((r) => r.status === 'skipped')) dotClass = 'dot-red';
      else if (recs.some((r) => r.status === 'taken-late')) dotClass = 'dot-amber';
      else dotClass = 'dot-green';
    }

    const cell = el('div', {
      class: 'cal-cell' + (dstr === todayStr ? ' today' : '') +
        (dstr === state.calSelected ? ' selected' : '') + (isFuture ? ' future' : ''),
      onclick: isFuture ? null : () => { state.calSelected = dstr; renderHistory(); renderDayDetail(dstr); },
    },
      el('div', {}, String(day)),
      recs.length ? el('div', { class: 'dot ' + dotClass }) : el('div', { style: 'height:12px' })
    );
    grid.appendChild(cell);
  }

  if (state.calSelected) renderDayDetail(state.calSelected);
}

async function renderDayDetail(dstr) {
  const wrap = document.getElementById('dayDetail');
  const all = await dbGetAll('records');
  const recs = all.filter((r) => r.date === dstr).sort((a, b) => timeToMinutes(a.scheduledTime) - timeToMinutes(b.scheduledTime));

  const [y, mo, d] = dstr.split('-').map(Number);
  const dateObj = new Date(y, mo - 1, d);
  wrap.innerHTML = '';
  wrap.appendChild(el('div', { class: 'section-title' },
    `${DOW[dateObj.getDay()]}, ${MONTHS[dateObj.getMonth()]} ${d} · 記錄`));

  if (recs.length === 0) {
    wrap.appendChild(el('div', { class: 'empty-note' }, 'No records this day · 呢日冇記錄'));
    return;
  }

  for (const r of recs) {
    const statusBadge = {
      'taken': el('span', { class: 'badge badge-green' }, '✅ Taken · 已食'),
      'taken-late': el('span', { class: 'badge badge-amber' }, '🕐 Late · 遲咗'),
      'skipped': el('span', { class: 'badge badge-red' }, '⚠️ Skipped · 跳過'),
    }[r.status];

    const photo = r.photo
      ? el('img', { class: 'rec-photo', src: blobUrl(r.photo), onclick: () => openPhotoViewer(r) })
      : el('div', { class: 'rec-photo', style: 'display:flex;align-items:center;justify-content:center;font-size:2rem;cursor:default' }, '—');

    const card = el('div', { class: 'card' },
      el('div', { class: 'day-record' },
        photo,
        el('div', { class: 'rec-meta' },
          el('div', { class: 'line' }, el('b', {}, `${r.sessionNameEn} · ${r.sessionNameZh}`)),
          el('div', { class: 'line' }, statusBadge),
          el('div', { class: 'line' }, `Scheduled ${fmtTime12(r.scheduledTime)} · Recorded ${fmtTime12(r.actualTime)}`),
          el('div', { class: 'rec-note' }, 'Meds · 藥物: ' + recMedsLabel(r)),
          r.status === 'skipped'
            ? el('div', { class: 'rec-note' }, 'Reason · 原因: ' + skipReasonLabel(r.skipReason) + (r.skipNote ? ' — ' + r.skipNote : ''))
            : null
        )
      )
    );
    wrap.appendChild(card);
  }
}

function openRecordDetail(r) {
  const statusText = {
    'taken': '✅ Taken · 已食', 'taken-late': '🕐 Late · 遲咗食', 'skipped': '⚠️ Skipped · 跳過',
  }[r.status];
  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: closeOverlay }, '✕'),
    el('h2', {}, `${r.sessionNameEn} · ${r.sessionNameZh}`),
    el('div', { class: 'sub' }, statusText + ` — recorded ${fmtTime12(r.actualTime)}`),
    r.photo ? el('img', { style: 'width:100%;border-radius:14px;margin-bottom:0.8rem', src: blobUrl(r.photo) }) : null,
    el('div', { class: 'rec-note' }, 'Meds · 藥物: ' + recMedsLabel(r)),
    r.status === 'skipped' ? el('div', { class: 'rec-note' }, 'Reason · 原因: ' + skipReasonLabel(r.skipReason) + (r.skipNote ? ' — ' + r.skipNote : '')) : null,
    el('div', { class: 'rec-note', style: 'margin-top:0.6rem;font-size:0.9rem' }, '🔒 This record is locked and cannot be edited · 記錄已鎖定，不可修改')
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

function openPhotoViewer(r) {
  const viewer = el('div', { class: 'photo-viewer', onclick: closeOverlay },
    el('img', { src: blobUrl(r.photo) }),
    el('div', { class: 'cap' },
      `${r.sessionNameEn} · ${r.sessionNameZh} — ${r.date} ${fmtTime12(r.actualTime)}`)
  );
  showOverlay(viewer);
}

/* ============================================================
   Admin (PIN-protected)
   ============================================================ */

let adminUnlocked = false;
let pinEntry = '';
let pinFailCount = 0;
let pinLockUntil = 0;

function renderAdmin() {
  const main = document.getElementById('adminMain');
  main.innerHTML = '';
  if (adminUnlocked) renderAdminPanel(main);
  else renderPinPad(main);
}

function renderPinPad(main) {
  main.appendChild(el('h1', {}, 'Manage · 家人管理'));
  const locked = Date.now() < pinLockUntil;

  const dots = el('div', { class: 'pin-dots' });
  for (let i = 0; i < 4; i++) dots.appendChild(el('div', { class: 'pin-dot' + (i < pinEntry.length ? ' filled' : '') }));

  const errBox = el('div', { class: 'pin-error' },
    locked ? 'Too many tries. Wait a moment. · 錯太多次，請稍候' : '');

  const pad = el('div', { class: 'pin-pad' });
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];
  for (const k of keys) {
    const key = el('button', { class: 'pin-key' }, k);
    key.addEventListener('click', async () => {
      if (Date.now() < pinLockUntil) return;
      if (k === '⌫') { pinEntry = pinEntry.slice(0, -1); renderAdmin(); return; }
      if (k === '✓') { await tryPin(); return; }
      if (pinEntry.length < 4) pinEntry += k;
      if (pinEntry.length === 4) { await tryPin(); return; }
      renderAdmin();
    });
    pad.appendChild(key);
  }

  main.appendChild(el('div', { class: 'card pin-wrap' },
    el('div', { class: 'section-title', style: 'text-align:center' }, 'Enter Family PIN · 輸入密碼'),
    dots, pad, errBox
  ));
}

async function tryPin() {
  if (pinEntry.length !== 4) return;
  const hash = await sha256(pinEntry);
  if (hash === state.settings.pinHash) {
    adminUnlocked = true; pinEntry = ''; pinFailCount = 0;
    renderAdmin();
  } else {
    pinFailCount++;
    pinEntry = '';
    if (pinFailCount >= 5) { pinLockUntil = Date.now() + 60000; pinFailCount = 0; }
    renderAdmin();
    const err = document.querySelector('.pin-error');
    if (err && Date.now() >= pinLockUntil) err.textContent = 'Wrong PIN · 密碼錯誤';
  }
}

function renderAdminPanel(main) {
  main.appendChild(el('div', { style: 'display:flex;align-items:center;gap:1rem;margin-bottom:0.5rem' },
    el('h1', { style: 'margin:0;flex:1' }, 'Manage · 管理'),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { adminUnlocked = false; renderAdmin(); } }, '🔒 Lock · 鎖定')
  ));

  // Medications
  main.appendChild(el('div', { class: 'section-title' }, 'Medications · 藥物'));
  const medCard = el('div', { class: 'card' });
  if (state.medications.length === 0) medCard.appendChild(el('div', { class: 'empty-note', style: 'padding:1rem' }, 'No medications · 未有藥物'));
  for (const m of state.medications) {
    medCard.appendChild(el('div', { class: 'admin-item' + (m.active === false ? ' inactive-note' : '') },
      m.photo ? el('img', { class: 'med-thumb', src: blobUrl(m.photo) }) : el('div', { class: 'med-thumb ph' }, '💊'),
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, m.nameEn + ' ', el('span', { class: 'zh' }, m.nameZh || '')),
        el('div', { class: 'sub' }, (m.dose || '') + (m.active === false ? ' · (inactive · 停用)' : ''))
      ),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => editMedication(m) }, 'Edit · 改')
    ));
  }
  main.appendChild(medCard);
  main.appendChild(el('button', { class: 'btn btn-primary btn-block', style: 'margin-bottom:1.5rem', onclick: () => editMedication(null) }, '+ Add medication · 加藥'));

  // Schedule
  main.appendChild(el('div', { class: 'section-title' }, 'Schedule · 時間表'));
  const schedCard = el('div', { class: 'card' });
  if (state.schedule.length === 0) schedCard.appendChild(el('div', { class: 'empty-note', style: 'padding:1rem' }, 'No sessions · 未有時段'));
  for (const s of state.schedule) {
    const medNames = s.prepared
      ? '📦 Prepared medicine · 家人準備好嘅藥'
      : (medsFor(s).map((m) => m.nameEn).join(', ') || '(no meds · 未揀藥)');
    const daysLabel = s.days.length === 7 ? 'Every day · 每日' : s.days.map((d) => DOW[d]).join(' ');
    schedCard.appendChild(el('div', { class: 'admin-item' },
      el('div', { style: 'text-align:center;min-width:80px' },
        el('div', { class: 'title', style: 'font-size:1.3rem' }, fmtTime12(s.time).replace(/ (AM|PM)/, '')),
        el('div', { class: 'sub' }, fmtTime12(s.time).slice(-2))),
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, s.nameEn + ' ', el('span', { class: 'zh' }, s.nameZh || '')),
        el('div', { class: 'sub' }, medNames),
        el('div', { class: 'sub' }, daysLabel)),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => editSession(s) }, 'Edit · 改')
    ));
  }
  main.appendChild(schedCard);
  main.appendChild(el('button', { class: 'btn btn-primary btn-block', style: 'margin-bottom:1.5rem', onclick: () => editSession(null) }, '+ Add session · 加時段'));

  // Patient profile
  main.appendChild(el('div', { class: 'section-title' }, 'Patient · 長者資料'));
  main.appendChild(el('div', { class: 'card' },
    el('div', { class: 'admin-item' },
      state.profile.photo ? el('img', { class: 'avatar', src: blobUrl(state.profile.photo) }) : el('div', { class: 'avatar avatar-placeholder' }, '👤'),
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, state.profile.nameEn),
        el('div', { class: 'sub' }, state.profile.nameZh || '')),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: editProfile }, 'Edit · 改'))
  ));

  // Data / settings
  main.appendChild(el('div', { class: 'section-title' }, 'Data & Security · 資料同安全'));
  main.appendChild(el('div', { class: 'card' },
    el('button', { class: 'btn btn-ghost btn-block', style: 'margin-bottom:0.7rem', onclick: exportBackup }, '⬇️ Export backup · 匯出備份'),
    el('button', { class: 'btn btn-ghost btn-block', onclick: changePin }, '🔑 Change PIN · 改密碼')
  ));
}

/* ---------- Photo picker helper for forms ---------- */

function photoPicker(currentBlob, onPicked) {
  let blob = currentBlob || null;
  const frame = el('div', { class: 'photo-frame', style: 'aspect-ratio:3/2' });
  const input = el('input', { type: 'file', accept: 'image/*', hidden: '' });
  function paint() {
    frame.innerHTML = '';
    if (blob) frame.appendChild(el('img', { src: blobUrl(blob) }));
    else { frame.appendChild(el('div', { class: 'cam-icon' }, '📷')); frame.appendChild(el('div', {}, 'Tap to add photo · 影相')); }
  }
  paint();
  frame.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (!input.files || !input.files[0]) return;
    try { blob = await compressImage(input.files[0], 800, 0.8); paint(); onPicked(blob); }
    catch (e) { toast('Photo error · 相片出錯'); }
  });
  return { frame, input, getBlob: () => blob };
}

/* ---------- Medication editor ---------- */

function editMedication(med) {
  const isNew = !med;
  const m = med || { id: uid('med'), nameEn: '', nameZh: '', dose: '', note: '', photo: null, active: true };
  const pk = photoPicker(m.photo, () => {});

  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: () => { closeOverlay(); } }, '✕'),
    el('h2', {}, isNew ? 'Add medication · 加藥' : 'Edit medication · 改藥'),
    el('div', { class: 'field' }, el('label', {}, 'Name (English) · 英文名'), el('input', { type: 'text', id: 'medEn', value: m.nameEn })),
    el('div', { class: 'field' }, el('label', {}, '藥名 (中文)'), el('input', { type: 'text', id: 'medZh', value: m.nameZh })),
    el('div', { class: 'field' }, el('label', {}, 'Dose · 劑量'), el('input', { type: 'text', id: 'medDose', value: m.dose, placeholder: 'e.g. 5 mg · 1 tablet' })),
    el('div', { class: 'field' }, el('label', {}, 'Note · 備註'), el('input', { type: 'text', id: 'medNote', value: m.note, placeholder: 'After meal · 飯後' })),
    el('div', { class: 'field' }, el('label', {}, 'Pill photo · 藥丸相 (for reference · 執藥對照)'), pk.frame, pk.input),
    el('div', { class: 'field' },
      el('label', {}, el('input', { type: 'checkbox', id: 'medActive', style: 'width:auto;min-height:auto;transform:scale(1.5);margin-right:0.6rem', ...(m.active !== false ? { checked: 'checked' } : {}) }), ' Active · 使用中')),
    el('div', { class: 'btn-row' },
      !isNew ? el('button', { class: 'btn btn-ghost', onclick: async () => { if (confirm('Delete this medication? · 刪除此藥？')) { await dbDelete('medications', m.id); await refreshMeds(); closeOverlay(); } } }, 'Delete · 刪除') : null,
      el('button', {
        class: 'btn btn-primary', onclick: async () => {
          m.nameEn = document.getElementById('medEn').value.trim();
          m.nameZh = document.getElementById('medZh').value.trim();
          m.dose = document.getElementById('medDose').value.trim();
          m.note = document.getElementById('medNote').value.trim();
          m.active = document.getElementById('medActive').checked;
          m.photo = pk.getBlob();
          if (!m.nameEn && !m.nameZh) { toast('Name required · 請輸入藥名'); return; }
          await dbPut('medications', m);
          await refreshMeds();
          closeOverlay();
          toast('Saved · 已儲存');
        },
      }, 'Save · 儲存')
    )
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

/* ---------- Session editor ---------- */

function editSession(session) {
  const isNew = !session;
  const s = session
    ? JSON.parse(JSON.stringify(session))
    : { id: uid('ses'), nameEn: '', nameZh: '', time: '08:00', medIds: [], days: [0, 1, 2, 3, 4, 5, 6] };
  // restore photo-free clone keeps medIds/days arrays

  const medChips = el('div', { class: 'chip-row' });
  for (const m of state.medications.filter((x) => x.active !== false)) {
    const chip = el('button', { class: 'chip' + (s.medIds.includes(m.id) ? ' selected' : '') },
      m.nameEn + ' ', el('span', { class: 'zh' }, m.nameZh || ''));
    chip.addEventListener('click', () => {
      if (s.medIds.includes(m.id)) s.medIds = s.medIds.filter((x) => x !== m.id);
      else s.medIds.push(m.id);
      chip.classList.toggle('selected');
    });
    medChips.appendChild(chip);
  }

  const dayChips = el('div', { class: 'chip-row' });
  for (let i = 0; i < 7; i++) {
    const chip = el('button', { class: 'chip' + (s.days.includes(i) ? ' selected' : ''), style: 'min-width:56px;justify-content:center' },
      DOW[i]);
    chip.addEventListener('click', () => {
      if (s.days.includes(i)) s.days = s.days.filter((x) => x !== i);
      else s.days.push(i);
      chip.classList.toggle('selected');
    });
    dayChips.appendChild(chip);
  }

  // Medicines field (hidden when the session uses pre-prepared medicine)
  const medField = el('div', { class: 'field' }, el('label', {}, 'Medicines · 藥物'), medChips);
  const medHint = el('div', { class: 'hint' }, 'Pick which medicines are taken at this time · 揀呢個時段要食嘅藥');
  medField.appendChild(medHint);

  const preparedBox = el('input', {
    type: 'checkbox', id: 'sesPrepared',
    style: 'width:auto;min-height:auto;transform:scale(1.5);margin-right:0.6rem',
    ...(s.prepared ? { checked: 'checked' } : {}),
  });
  preparedBox.addEventListener('change', () => {
    medField.style.display = preparedBox.checked ? 'none' : 'block';
  });
  if (s.prepared) medField.style.display = 'none';

  const preparedField = el('div', { class: 'field' },
    el('label', { style: 'display:flex;align-items:center' }, preparedBox,
      el('span', {}, '📦 Medicine already prepared · 藥物已準備好')),
    el('div', { class: 'hint' },
      'Turn on when family pre-sorts the pills into a box — no need to list each medicine. The helper just confirms + takes a photo. · 屋企人已將藥分格執好時開啟，唔使揀個別藥，姐姐確認同影相就得。')
  );

  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: closeOverlay }, '✕'),
    el('h2', {}, isNew ? 'Add session · 加時段' : 'Edit session · 改時段'),
    el('div', { class: 'field' }, el('label', {}, 'Time · 時間'), el('input', { type: 'time', id: 'sesTime', value: s.time })),
    el('div', { class: 'field' }, el('label', {}, 'Name (English) · 名'), el('input', { type: 'text', id: 'sesEn', value: s.nameEn, placeholder: 'Morning' })),
    el('div', { class: 'field' }, el('label', {}, '名 (中文)'), el('input', { type: 'text', id: 'sesZh', value: s.nameZh, placeholder: '早上' })),
    preparedField,
    medField,
    el('div', { class: 'field' }, el('label', {}, 'Days · 星期'), dayChips),
    el('div', { class: 'btn-row' },
      !isNew ? el('button', { class: 'btn btn-ghost', onclick: async () => { if (confirm('Delete this session? · 刪除此時段？')) { await dbDelete('schedule', s.id); await refreshSched(); closeOverlay(); } } }, 'Delete · 刪除') : null,
      el('button', {
        class: 'btn btn-primary', onclick: async () => {
          s.time = document.getElementById('sesTime').value || '08:00';
          s.nameEn = document.getElementById('sesEn').value.trim() || 'Session';
          s.nameZh = document.getElementById('sesZh').value.trim();
          s.prepared = document.getElementById('sesPrepared').checked;
          if (s.prepared) s.medIds = [];
          if (s.days.length === 0) { toast('Pick at least one day · 揀最少一日'); return; }
          if (!s.prepared && s.medIds.length === 0) { toast('Pick medicines, or turn on "prepared" · 揀藥，或開啟「已準備好」'); return; }
          await dbPut('schedule', s);
          await refreshSched();
          closeOverlay();
          toast('Saved · 已儲存');
        },
      }, 'Save · 儲存')
    )
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

/* ---------- Profile editor ---------- */

function editProfile() {
  const p = state.profile;
  const pk = photoPicker(p.photo, () => {});
  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: closeOverlay }, '✕'),
    el('h2', {}, 'Patient · 長者資料'),
    el('div', { class: 'field' }, el('label', {}, 'Name (English) · 英文名'), el('input', { type: 'text', id: 'pfEn', value: p.nameEn })),
    el('div', { class: 'field' }, el('label', {}, '名字 (中文)'), el('input', { type: 'text', id: 'pfZh', value: p.nameZh })),
    el('div', { class: 'field' }, el('label', {}, 'Photo · 相片'), pk.frame, pk.input),
    el('div', { style: 'margin-top:0.5rem' },
      el('button', {
        class: 'btn btn-primary btn-block', onclick: async () => {
          p.nameEn = document.getElementById('pfEn').value.trim() || p.nameEn;
          p.nameZh = document.getElementById('pfZh').value.trim();
          p.photo = pk.getBlob();
          await dbPut('profile', p);
          state.profile = p;
          renderPatientBar();
          renderAdmin();
          closeOverlay();
          toast('Saved · 已儲存');
        },
      }, 'Save · 儲存'))
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

/* ---------- Change PIN ---------- */

function changePin() {
  const modal = el('div', { class: 'modal' },
    el('button', { class: 'modal-close', onclick: closeOverlay }, '✕'),
    el('h2', {}, 'Change PIN · 改密碼'),
    el('div', { class: 'field' }, el('label', {}, 'New 4-digit PIN · 新密碼'), el('input', { type: 'password', id: 'np1', inputmode: 'numeric', maxlength: '4' })),
    el('div', { class: 'field' }, el('label', {}, 'Confirm · 再輸入'), el('input', { type: 'password', id: 'np2', inputmode: 'numeric', maxlength: '4' })),
    el('button', {
      class: 'btn btn-primary btn-block', onclick: async () => {
        const a = document.getElementById('np1').value, b = document.getElementById('np2').value;
        if (!/^\d{4}$/.test(a)) { toast('4 digits required · 要 4 位數字'); return; }
        if (a !== b) { toast('PIN not match · 兩次唔一致'); return; }
        state.settings.pinHash = await sha256(a);
        await dbPut('settings', state.settings);
        closeOverlay();
        toast('PIN changed · 密碼已改');
      },
    }, 'Save · 儲存')
  );
  showOverlay(el('div', { class: 'overlay' }, modal));
}

/* ---------- Export backup ---------- */

async function exportBackup() {
  const all = await dbGetAll('records');
  async function blobToDataUrl(blob) {
    if (!blob) return null;
    return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  }
  const data = {
    exportedAt: new Date().toISOString(),
    profile: { ...state.profile, photo: await blobToDataUrl(state.profile.photo) },
    medications: await Promise.all(state.medications.map(async (m) => ({ ...m, photo: await blobToDataUrl(m.photo) }))),
    schedule: state.schedule,
    records: await Promise.all(all.map(async (r) => ({ ...r, photo: await blobToDataUrl(r.photo) }))),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `medcare-backup-${ymd(new Date())}.json` });
  document.body.appendChild(a); a.click(); a.remove();
  toast('Backup downloaded · 已匯出備份');
}

/* ---------- Admin data refresh ---------- */

async function refreshMeds() { state.medications = await dbGetAll('medications'); renderAdmin(); }
async function refreshSched() {
  state.schedule = await dbGetAll('schedule');
  state.schedule.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  renderAdmin();
}

/* ============================================================
   Tabs / navigation
   ============================================================ */

let currentTab = 'today';

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('todayView').classList.toggle('active', tab === 'today');
  document.getElementById('historyView').classList.toggle('active', tab === 'history');
  document.getElementById('adminView').classList.toggle('active', tab === 'admin');
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (currentTab === 'today') renderToday();
  else if (currentTab === 'history') renderHistory();
  else if (currentTab === 'admin') renderAdmin();
}

function renderPatientBar() {
  const p = state.profile;
  const av = document.getElementById('barAvatar');
  if (p.photo) { av.src = blobUrl(p.photo); av.style.display = ''; }
  else { av.replaceWith(el('div', { class: 'avatar avatar-placeholder', id: 'barAvatar' }, '👤')); }
  document.getElementById('barName').textContent = p.nameEn + (p.nameZh ? ` · ${p.nameZh}` : '');
}

/* ============================================================
   Setup flow
   ============================================================ */

function initSetup() {
  let photoBlob = null;
  const frame = document.getElementById('setupPhotoFrame');
  const input = document.getElementById('setupPhotoInput');
  frame.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (!input.files || !input.files[0]) return;
    try {
      photoBlob = await compressImage(input.files[0], 800, 0.85);
      frame.innerHTML = '';
      frame.appendChild(el('img', { src: blobUrl(photoBlob) }));
    } catch (e) { toast('Photo error · 相片出錯'); }
  });

  document.getElementById('setupSaveBtn').addEventListener('click', async () => {
    const nameEn = document.getElementById('setupNameEn').value.trim();
    const nameZh = document.getElementById('setupNameZh').value.trim();
    const p1 = document.getElementById('setupPin1').value;
    const p2 = document.getElementById('setupPin2').value;
    if (!nameEn && !nameZh) { toast('Enter a name · 請輸入名字'); return; }
    if (!/^\d{4}$/.test(p1)) { toast('PIN must be 4 digits · 密碼要 4 位數字'); return; }
    if (p1 !== p2) { toast('PIN not match · 兩次密碼唔一致'); return; }

    await dbPut('profile', { id: 'main', nameEn: nameEn || nameZh, nameZh, photo: photoBlob });
    await dbPut('settings', { id: 'main', pinHash: await sha256(p1) });
    await seedSampleData();
    await boot(); // reload into app
  });
}

/* ============================================================
   Boot
   ============================================================ */

async function boot() {
  await loadState();

  if (!state.profile || !state.settings) {
    document.getElementById('appView').classList.remove('active');
    document.getElementById('setupView').classList.add('active');
    initSetup();
    return;
  }

  await loadTodayRecords();
  document.getElementById('setupView').classList.remove('active');
  document.getElementById('appView').classList.add('active');

  renderPatientBar();
  updateClock();
  renderToday();

  // tab buttons
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => switchTab(t.dataset.tab);
  });

  // history calendar nav
  document.getElementById('calPrev').onclick = () => { state.calMonth.setMonth(state.calMonth.getMonth() - 1); renderHistory(); };
  document.getElementById('calNext').onclick = () => { state.calMonth.setMonth(state.calMonth.getMonth() + 1); renderHistory(); };
}

async function main() {
  try {
    db = await openDB();
  } catch (e) {
    document.body.innerHTML = '<div class="empty-note">Storage unavailable. Please use Safari (not private mode). · 無法儲存資料，請用 Safari（非無痕模式）。</div>';
    return;
  }

  // persist storage so Safari doesn't evict data
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) { /* ignore */ }
  }

  await boot();

  // scheduler tick
  setInterval(tick, 30000);
  tick();

  // unlock audio on first user gesture (iOS requires it)
  const unlock = () => { initAudio(); if (alarmAudio && alarmAudio.ctx.state === 'suspended') alarmAudio.ctx.resume(); };
  document.addEventListener('touchstart', unlock, { once: true });
  document.addEventListener('click', unlock, { once: true });

  // register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
  }

  // reload day boundary handling: refresh records when app regains focus
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && state.profile) { await loadTodayRecords(); refreshCurrentTab(); }
  });
}

main();
