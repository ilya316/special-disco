// Синхронизация персонажей между устройствами через воркер Cloudflare (tools/cf-worker.js, база D1).
// Код синхронизации — общий «ключ» к данным: у кого он есть, тот видит и меняет персонажей.
//
// Схема: устройство помнит base — версию из облака, которую видело при прошлой синхронизации.
// Синхронизация = прочитать облако (rev) → трёхстороннее слияние base/local/remote → записать,
// только если rev не изменился (иначе повторить). Так изменения с разных устройств не затирают друг друга.
import { SYNC_URL } from './store.js';
import { mergeCharacters, eq } from './merge.js';

const CFG_KEY = 'spellbook.sync';
const BACKUP_KEY = 'spellbook.backups';
const BACKUPS_KEEP = 10;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

let cfg = loadCfg(); // { code, base: { characters, rev } | null, last }
let hooks = null; // { getState, apply, onStatus }
let timer = null;
let running = null;
let again = false;
let status = cfg.code ? 'pending' : 'off';
let lastError = '';

function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY)) || {};
    delete c.snaps; // от старой схемы синхронизации
    return c;
  } catch {
    return {};
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

const clone = (v) => JSON.parse(JSON.stringify(v));

export const syncInfo = () => ({ code: cfg.code || '', status, last: cfg.last || 0, error: lastError });

export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

export function normalizeCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '').match(/.{1,4}/g)?.join('-') || '';
}

async function post(body, code = cfg.code) {
  const r = await fetch(SYNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, code }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 409 && data.conflict) return data;
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

/* ---------- резервные копии на устройстве ---------- */

export function listBackups() {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_KEY)) || [];
  } catch {
    return [];
  }
}

export function backupLocal(characters, reason) {
  const list = listBackups();
  if (list[0] && eq(list[0].characters, characters)) return;
  list.unshift({ time: Date.now(), reason, characters: clone(characters) });
  // если места мало — храним меньше копий
  for (let n = BACKUPS_KEEP; n > 0; n--) {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(list.slice(0, n)));
      return;
    } catch {}
  }
}

/* ---------- синхронизация ---------- */

async function runSync() {
  const state = hooks.getState();
  for (let attempt = 0; attempt < 4; attempt++) {
    const local0 = clone(state.characters); // что было на устройстве в момент начала
    const remote = await post({ peek: true });
    if (!remote.existed && cfg.base) throw new Error('Данные в облаке не найдены');
    const merged = mergeCharacters(cfg.base ? cfg.base.characters : null, local0, remote.characters);

    let rev = remote.rev;
    if (!eq(merged, remote.characters) || !remote.existed) {
      const res = await post({ put: true, baseRev: remote.rev, characters: merged });
      if (res.conflict) continue; // кто-то записал раньше — пересчитываем
      rev = res.rev;
    }
    cfg.base = { characters: merged, rev };

    // пока шёл запрос, на устройстве могли что-то поменять — не теряем и это
    const now = state.characters;
    const result = eq(now, local0) ? merged : mergeCharacters(local0, now, merged);
    if (!eq(result, now)) {
      backupLocal(now, 'перед получением изменений с других устройств');
      hooks.apply(result, true);
    }
    if (!eq(result, merged)) again = true; // досинхронизировать то, что ввели во время запроса
    return;
  }
  throw new Error('Не удалось записать: данные постоянно меняются, попробуйте ещё раз');
}

export async function syncNow() {
  if (!cfg.code || !hooks) return;
  if (running) {
    again = true;
    return running;
  }
  clearTimeout(timer);
  running = (async () => {
    setStatus('syncing');
    try {
      await runSync();
      cfg.last = Date.now();
      saveCfg();
      setStatus('ok');
    } catch (e) {
      setStatus('error', navigator.onLine === false ? 'нет интернета' : e.message);
    } finally {
      running = null;
      if (again) {
        again = false;
        schedule();
      }
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
  cfg = { code: generateCode(), base: null };
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
  const peek = await post({ peek: true }, code);
  if (!peek.existed) throw new Error('По этому коду ничего не найдено. Проверьте код.');
  const state = hooks.getState();
  backupLocal(state.characters, 'перед подключением синхронизации');
  cfg = { code, base: null };
  if (mode === 'replace') {
    cfg.base = { characters: peek.characters, rev: peek.rev };
    hooks.apply(clone(peek.characters), true);
  }
  saveCfg();
  await syncNow();
  if (status === 'error') throw new Error(lastError);
}

export function disconnect() {
  clearTimeout(timer);
  cfg = {};
  saveCfg();
  setStatus('off');
}

/* ---------- история версий в облаке ---------- */

export async function listVersions() {
  return (await post({ history: true })).versions || [];
}

export async function getVersion(rev) {
  return post({ historyRev: rev });
}

// Вернуть персонажей к выбранной версии: она становится новой текущей везде
export async function restoreCharacters(characters) {
  const state = hooks.getState();
  backupLocal(state.characters, 'перед восстановлением версии');
  hooks.apply(clone(characters), true);
  if (!cfg.code) return;
  // считаем текущее облако «общим предком» — тогда восстановленная версия побеждает целиком
  const remote = await post({ peek: true });
  cfg.base = { characters: remote.characters, rev: remote.rev };
  saveCfg();
  await syncNow();
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
