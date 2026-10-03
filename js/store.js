// Хранение состояния в localStorage + бэкап в JSON.
const KEY = 'spellbook.v1';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const DEFAULT_PROXIES = [
  'https://api.allorigins.win/raw?url={url}',
  'https://api.codetabs.com/v1/proxy/?quest={url}',
  'https://corsproxy.io/?url={url}',
];

export function newCharacter(name = 'Новый персонаж') {
  const slots = {};
  for (let l = 1; l <= 9; l++) slots[l] = { max: 0, used: 0 };
  return {
    id: uid(),
    name,
    cls: '',
    level: 1,
    edition: '2014',
    hp: { cur: 10, max: 10, temp: 0 },
    deathSaves: { ok: 0, fail: 0 },
    slots,
    pact: { level: 1, max: 0, used: 0 },
    resources: [],
    spells: [],
    inventory: '',
  };
}

function defaults() {
  const c = newCharacter('Мой персонаж');
  return {
    activeId: c.id,
    characters: [c],
    settings: { customProxy: '', theme: 'auto' },
  };
}

function normalize(s) {
  if (!s || !Array.isArray(s.characters) || !s.characters.length) return defaults();
  const base = newCharacter();
  s.characters = s.characters.map((c) => ({
    ...base,
    ...c,
    hp: { ...base.hp, ...c.hp },
    deathSaves: { ...base.deathSaves, ...c.deathSaves },
    slots: { ...base.slots, ...c.slots },
    pact: { ...base.pact, ...c.pact },
    resources: c.resources || [],
    spells: c.spells || [],
    inventory: c.inventory || '',
  }));
  if (!s.characters.some((c) => c.id === s.activeId)) s.activeId = s.characters[0].id;
  s.settings = { customProxy: '', theme: 'auto', ...s.settings };
  return s;
}

export function load() {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return defaults();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    alert('Не удалось сохранить данные: ' + e.message);
  }
}

export function exportJson(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spellbook-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importJson(file) {
  const data = JSON.parse(await file.text());
  if (!data || !Array.isArray(data.characters)) throw new Error('Это не файл бэкапа книги заклинаний');
  return normalize(data);
}

export function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
