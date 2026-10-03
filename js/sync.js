// Синхронизация персонажей между устройствами через воркер Cloudflare (tools/cf-worker.js, база D1).
// Код синхронизации — общий «ключ» к данным: у кого он есть, тот видит и меняет персонажей.
import { SYNC_URL } from './store.js';

const CFG_KEY = 'spellbook.sync';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

let cfg = loadCfg(); // { code, snaps: {id: json}, last }
let hooks = null; // { getState, apply, onStatus }
let timer = null;
let running = null;
let status = cfg.code ? 'pending' : 'off';
let lastError = '';

function loadCfg() {
  try {
    return { snaps: {}, ...JSON.parse(localStorage.getItem(CFG_KEY)) };
  } catch {
    return { snaps: {} };
  }
}
function saveCfg() {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {}
}
function setStatus(s, err = '') {
  status = s;
  lastError = err;
  hooks?.onStatus?.(s);
}

const strip = (c) => JSON.stringify({ ...c, updatedAt: undefined });

export const syncInfo = () => ({ code: cfg.code || '', status, last: cfg.last || 0, error: lastError });

export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

export function normalizeCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '').match(/.{1,4}/g)?.join('-') || '';
}

async function post(body) {
  const r = await fetch(SYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

function applyRemote(merged) {
  const state = hooks.getState();
  const order = new Map(state.characters.map((c, i) => [c.id, i]));
  const chars = [...merged.characters].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  const changed = JSON.stringify(chars) !== JSON.stringify(state.characters);
  cfg.snaps = Object.fromEntries(chars.map((c) => [c.id, strip(c)]));
  hooks.apply(chars, merged.deleted || {}, changed);
}

export async function syncNow() {
  if (!cfg.code || !hooks) return;
  if (running) return running;
  clearTimeout(timer);
  running = (async () => {
    setStatus('syncing');
    try {
      const state = hooks.getState();
      const now = Date.now();
      for (const c of state.characters) {
        if (strip(c) !== cfg.snaps[c.id]) c.updatedAt = now;
      }
      const merged = await post({ code: cfg.code, characters: state.characters, deleted: state.deleted || {} });
      applyRemote(merged);
      cfg.last = Date.now();
      saveCfg();
      setStatus('ok');
    } catch (e) {
      setStatus('error', navigator.onLine === false ? 'нет интернета' : e.message);
    } finally {
      running = null;
    }
  })();
  return running;
}

// Вызывается после каждого сохранения: отправка через 2 с после последнего изменения
export function schedule() {
  if (!cfg.code) return;
  setStatus('pending');
  clearTimeout(timer);
  timer = setTimeout(syncNow, 2000);
}

export async function createSync() {
  cfg = { code: generateCode(), snaps: {} };
  saveCfg();
  await syncNow();
  if (status === 'error') {
    const err = lastError;
    disconnect();
    throw new Error(err);
  }
  return cfg.code;
}

// mode: 'replace' — взять данные из облака вместо местных; 'merge' — объединить
export async function connect(rawCode, mode) {
  const code = normalizeCode(rawCode);
  const peek = await post({ code, peek: true });
  if (!peek.existed) throw new Error('По этому коду ничего не найдено. Проверьте код.');
  cfg = { code, snaps: {} };
  if (mode === 'replace') {
    applyRemote(peek);
  }
  saveCfg();
  await syncNow();
  if (status === 'error') throw new Error(lastError);
}

export function disconnect() {
  clearTimeout(timer);
  cfg = { snaps: {} };
  saveCfg();
  setStatus('off');
}

export function initSync(h) {
  hooks = h;
  syncNow();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('online', () => syncNow());
  setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, 30000);
}
