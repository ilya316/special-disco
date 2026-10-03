// Правила D&D 5e: характеристики, навыки, грузоподъёмность, прыжки, кости хитов, монеты.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const ABILITIES = [
  ['str', 'СИЛ', 'Сила'],
  ['dex', 'ЛОВ', 'Ловкость'],
  ['con', 'ТЕЛ', 'Телосложение'],
  ['int', 'ИНТ', 'Интеллект'],
  ['wis', 'МДР', 'Мудрость'],
  ['cha', 'ХАР', 'Харизма'],
];
export const ABIL_SHORT = Object.fromEntries(ABILITIES.map(([k, s]) => [k, s]));

export const SKILLS = [
  ['athletics', 'Атлетика', 'str'],
  ['acrobatics', 'Акробатика', 'dex'],
  ['sleight', 'Ловкость рук', 'dex'],
  ['stealth', 'Скрытность', 'dex'],
  ['investigation', 'Анализ', 'int'],
  ['history', 'История', 'int'],
  ['arcana', 'Магия', 'int'],
  ['nature', 'Природа', 'int'],
  ['religion', 'Религия', 'int'],
  ['perception', 'Внимательность', 'wis'],
  ['survival', 'Выживание', 'wis'],
  ['medicine', 'Медицина', 'wis'],
  ['insight', 'Проницательность', 'wis'],
  ['animal', 'Уход за животными', 'wis'],
  ['performance', 'Выступление', 'cha'],
  ['intimidation', 'Запугивание', 'cha'],
  ['deception', 'Обман', 'cha'],
  ['persuasion', 'Убеждение', 'cha'],
];

export const mod = (score) => Math.floor(((Number(score) || 10) - 10) / 2);
export const fmtMod = (m) => (m >= 0 ? '+' : '−') + Math.abs(m);
export const profBonus = (level) => 2 + Math.floor((clamp(Number(level) || 1, 1, 20) - 1) / 4);

// Владение навыком: 0 — нет, 1 — владение, 2 — компетентность
export function skillBonus(c, key, abil) {
  const p = profBonus(c.level);
  const lvl = c.skills[key] || 0;
  let b = mod(c.abilities[abil]);
  if (lvl === 1) b += p;
  else if (lvl === 2) b += 2 * p;
  else if (c.jack) b += Math.floor(p / 2);
  return b;
}

export const saveBonus = (c, a) => mod(c.abilities[a]) + (c.saves[a] ? profBonus(c.level) : 0);

export const SIZES = [
  ['tiny', 'Крошечный', 0.5],
  ['small', 'Маленький', 1],
  ['medium', 'Средний', 1],
  ['large', 'Большой', 2],
  ['huge', 'Огромный', 4],
  ['gargantuan', 'Громадный', 8],
];

// Грузоподъёмность в фунтах. «Мощное телосложение» считает существо на размер больше.
export function capacity(c) {
  let i = SIZES.findIndex((s) => s[0] === c.size);
  if (i < 0) i = 2;
  i = clamp(i + (c.powerfulBuild ? 1 : 0), 0, SIZES.length - 1);
  const k = SIZES[i][2];
  const str = Number(c.abilities.str) || 0;
  return {
    carry: str * 15 * k,
    push: str * 30 * k,
    encumbered: str * 5 * k, // вариант правил «Нагрузка» (PHB 2014)
    heavy: str * 10 * k,
  };
}

// Прыжки в футах: в длину = Сила (с разбега 10 фт), в высоту = 3 + мод. Силы; с места — вдвое меньше.
export function jumps(c) {
  const str = Number(c.abilities.str) || 0;
  const high = Math.max(0, 3 + mod(str));
  return {
    longRun: str,
    longStand: Math.floor(str / 2),
    highRun: high,
    highStand: Math.floor(high / 2),
  };
}

export const COINS = [
  ['cp', 'ММ', 0.01],
  ['sp', 'СМ', 0.1],
  ['ep', 'ЭМ', 0.5],
  ['gp', 'ЗМ', 1],
  ['pp', 'ПМ', 10],
];
export const COIN_RATE = Object.fromEntries(COINS.map(([k, , r]) => [k, r]));
export const COIN_NAME = Object.fromEntries(COINS.map(([k, n]) => [k, n.toLowerCase()]));

export function coinsTotal(coins) {
  return COINS.reduce((s, [k, , r]) => s + (Number(coins[k]) || 0) * r, 0);
}
export function coinsCount(coins) {
  return COINS.reduce((s, [k]) => s + (Number(coins[k]) || 0), 0);
}

// Вес, который персонаж несёт сейчас (монеты: 50 шт = 1 фунт)
export function carried(c) {
  const items = c.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.weight) || 0), 0);
  const coins = c.coinsWeight ? coinsCount(c.coins) / 50 : 0;
  return { items, coins, total: items + coins };
}

export function itemsValue(c) {
  return c.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.cost) || 0) * (COIN_RATE[it.cur] ?? 1), 0);
}

export const fmtNum = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

// Длинный отдых: 2014 — половина костей хитов (минимум 1), 2024 — все.
export function restoreHitDice(c) {
  const total = c.hitDice.reduce((s, h) => s + h.max, 0);
  let n = c.edition === '2024' ? total : Math.max(1, Math.floor(total / 2));
  const restored = n;
  for (const h of [...c.hitDice].sort((a, b) => b.die - a.die)) {
    const back = Math.min(h.used, n);
    h.used -= back;
    n -= back;
  }
  return restored - n;
}
