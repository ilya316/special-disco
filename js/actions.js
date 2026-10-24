// Игровые действия над персонажем — общие для приложения (js/app.js) и MCP-сервера (tools/mcp).
// Чистые функции: меняют переданный объект персонажа и возвращают краткое описание результата.
// Никакого интерфейса здесь нет: подтверждения и сообщения — у вызывающего.
import { mod, restoreHitDice } from './rules.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (n, what = 'число') => {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`Нужно ${what}`);
  return Math.trunc(v);
};

/* ---------- хиты ---------- */

// Урон сначала снимает временные хиты
export function damage(c, n) {
  n = Math.max(0, num(n, 'число урона'));
  const hp = c.hp;
  const fromTemp = Math.min(hp.temp, n);
  hp.temp -= fromTemp;
  hp.cur = Math.max(0, hp.cur - (n - fromTemp));
  return { fromTemp, hp: { ...hp } };
}

export function heal(c, n) {
  n = Math.max(0, num(n, 'число лечения'));
  if (c.hp.cur === 0 && n > 0) c.deathSaves = { ok: 0, fail: 0 };
  c.hp.cur = Math.min(c.hp.max, c.hp.cur + n);
  return { hp: { ...c.hp } };
}

export function setTempHp(c, n) {
  c.hp.temp = Math.max(0, num(n));
  return { hp: { ...c.hp } };
}

export function setHp(c, { cur, max } = {}) {
  if (max !== undefined) {
    c.hp.max = Math.max(1, num(max));
    c.hp.cur = Math.min(c.hp.cur, c.hp.max);
  }
  if (cur !== undefined) c.hp.cur = clamp(num(cur), 0, c.hp.max);
  return { hp: { ...c.hp } };
}

// Спасброски от смерти: kind 'ok' | 'fail', count 0–3
export function setDeathSaves(c, kind, count) {
  if (kind !== 'ok' && kind !== 'fail') throw new Error('kind: ok или fail');
  c.deathSaves[kind] = clamp(num(count), 0, 3);
  return { deathSaves: { ...c.deathSaves } };
}

/* ---------- ячейки ---------- */

// delta > 0 — потратить, < 0 — вернуть
export function useSlot(c, level, delta = 1) {
  const s = c.slots[level];
  if (!s || !s.max) throw new Error(`Ячеек ${level} уровня нет`);
  s.used = clamp(s.used + num(delta), 0, s.max);
  return { level: Number(level), left: s.max - s.used, max: s.max };
}

export function usePact(c, delta = 1) {
  const p = c.pact;
  if (!p.max) throw new Error('Ячеек колдуна нет');
  p.used = clamp(p.used + num(delta), 0, p.max);
  return { level: p.level, left: p.max - p.used, max: p.max };
}

// Варианты сотворения заклинания (как в окне «Сотворить» приложения)
export function castOptions(c, spell) {
  const opts = [];
  for (let l = spell.level; l <= 9; l++) {
    const s = c.slots[l];
    if (s && s.max) opts.push({ how: String(l), label: `ячейка ${l} ур.`, left: s.max - s.used });
  }
  if (c.pact.max && c.pact.level >= spell.level) opts.push({ how: 'pact', label: `ячейка колдуна ${c.pact.level} ур.`, left: c.pact.max - c.pact.used });
  if (spell.freeMax) opts.push({ how: 'free', label: 'бесплатно', left: spell.freeMax - (spell.freeUsed || 0) });
  if (spell.ritual) opts.push({ how: 'ritual', label: 'как ритуал (+10 минут)', left: Infinity });
  opts.push({ how: 'nocost', label: spell.freeUnlimited ? 'бесплатно (неограниченно)' : 'ничего не тратя', left: Infinity });
  return opts;
}

// how: номер уровня ячейки ('1'…'9'), 'pact', 'free', 'free-reset', 'ritual', 'nocost'
export function castSpell(c, spell, how) {
  how = String(how);
  if (how === 'ritual') return { text: `${spell.name}: ритуал (+10 минут)` };
  if (how === 'nocost') return { text: `${spell.name}: сотворено без ячейки` };
  if (how === 'free-reset') {
    spell.freeUsed = 0;
    return { text: `${spell.name}: бесплатные использования восстановлены` };
  }
  if (how === 'free') {
    if (!spell.freeMax) throw new Error('У заклинания нет бесплатных использований');
    if ((spell.freeUsed || 0) >= spell.freeMax) throw new Error('Бесплатные использования закончились');
    spell.freeUsed = (spell.freeUsed || 0) + 1;
    return { text: `${spell.name}: бесплатно, осталось ${spell.freeMax - spell.freeUsed}` };
  }
  if (how === 'pact') {
    if (!c.pact.max || c.pact.level < spell.level) throw new Error('Ячейка колдуна не подходит');
    if (c.pact.used >= c.pact.max) throw new Error('Ячейки колдуна закончились');
    c.pact.used++;
    return { text: `${spell.name}: потрачена ячейка колдуна ${c.pact.level} ур.` };
  }
  const l = num(how, 'уровень ячейки');
  if (l < Math.max(1, spell.level) || l > 9) throw new Error(`Нужна ячейка ${Math.max(1, spell.level)}–9 уровня`);
  const s = c.slots[l];
  if (!s || s.used >= s.max) throw new Error(`Свободных ячеек ${l} уровня нет`);
  s.used++;
  return { text: `${spell.name}: потрачена ячейка ${l} ур.` };
}

/* ---------- кости хитов ---------- */

// roll — сколько выпало на кости (бросает игрок); к хитам добавляется мод. Телосложения
export function spendHitDie(c, index, roll) {
  const h = c.hitDice[index];
  if (!h) throw new Error('Такого типа костей хитов нет');
  if (h.used >= h.max) throw new Error(`Кости к${h.die} закончились`);
  const r = num(roll, 'выпавшее значение');
  const m = mod(c.abilities.con);
  const healed = Math.max(0, r + m);
  h.used++;
  c.hp.cur = Math.min(c.hp.max, c.hp.cur + healed);
  return { die: h.die, roll: r, mod: m, healed, text: `к${h.die}: ${r} ${m >= 0 ? '+' : '−'} ${Math.abs(m)} = ${healed} хитов` };
}

/* ---------- отдых ---------- */

export function shortRest(c) {
  c.pact.used = 0;
  c.resources.forEach((r) => { if (r.reset === 'short') r.cur = r.max; });
  c.spells.forEach((s) => { if (s.freeReset === 'short') s.freeUsed = 0; });
  return { text: 'Короткий отдых: восстановлены ячейки колдуна и ресурсы короткого отдыха' };
}

export function longRest(c) {
  c.hp.cur = c.hp.max;
  c.hp.temp = 0;
  c.deathSaves = { ok: 0, fail: 0 };
  for (const l in c.slots) c.slots[l].used = 0;
  c.pact.used = 0;
  c.resources.forEach((r) => { if (r.reset !== 'none') r.cur = r.max; });
  (c.creatures || []).forEach((cr) => { cr.hpCur = cr.hpMax; cr.hpTemp = 0; });
  c.spells.forEach((s) => { if (s.freeReset !== 'none') s.freeUsed = 0; });
  const hd = restoreHitDice(c);
  return { hitDice: hd, text: `Длинный отдых завершён${hd ? `, костей хитов восстановлено: ${hd}` : ''}` };
}

/* ---------- ресурсы ---------- */

export function resourceDelta(c, r, delta) {
  r.cur = clamp(r.cur + num(delta), 0, r.max);
  return { name: r.name, cur: r.cur, max: r.max };
}

export function resourceSet(c, r, value) {
  r.cur = clamp(num(value), 0, r.max);
  return { name: r.name, cur: r.cur, max: r.max };
}

/* ---------- существа ---------- */

export function creatureDamage(cr, n) {
  n = Math.max(0, num(n, 'число урона'));
  const fromTemp = Math.min(cr.hpTemp || 0, n);
  cr.hpTemp = (cr.hpTemp || 0) - fromTemp;
  cr.hpCur = Math.max(0, cr.hpCur - (n - fromTemp));
  return { name: cr.name, hpCur: cr.hpCur, hpMax: cr.hpMax, hpTemp: cr.hpTemp };
}

export function creatureHeal(cr, n) {
  cr.hpCur = Math.min(cr.hpMax, cr.hpCur + Math.max(0, num(n, 'число лечения')));
  return { name: cr.name, hpCur: cr.hpCur, hpMax: cr.hpMax };
}

export function creatureSetHp(cr, { cur, temp } = {}) {
  if (cur !== undefined) cr.hpCur = clamp(num(cur), 0, cr.hpMax);
  if (temp !== undefined) cr.hpTemp = Math.max(0, num(temp));
  return { name: cr.name, hpCur: cr.hpCur, hpMax: cr.hpMax, hpTemp: cr.hpTemp || 0 };
}
