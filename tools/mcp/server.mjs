#!/usr/bin/env node
// MCP-сервер «Книги заклинаний»: Claude читает и меняет персонажей.
// Данные — в облаке синхронизации (воркер Cloudflare /sync, база D1) по коду синхронизации;
// приложение на устройствах получает изменения само (трёхстороннее слияние, js/merge.js).
// Логика — общая с приложением: js/actions.js (игровые действия), js/store.js, js/parser.js, js/creature.js, js/export.js.
import './dom.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { SYNC_URL, uid, newCharacter, normalizeCharacter } from '../../js/store.js';
import { parseHtml, parseText, emptySpell } from '../../js/parser.js';
import { parseCreatureHtml, parseCreatureText, emptyCreature } from '../../js/creature.js';
import { sanitizeHtml, textToHtml } from '../../js/richtext.js';
import { normalizeDndUrl } from '../../js/import.js';
import { toLss } from '../../js/export.js';
import * as act from '../../js/actions.js';
import {
  ABILITIES, SKILLS, mod, fmtMod, profBonus, skillBonus, saveBonus, capacity, carried, coinsTotal, fmtNum,
} from '../../js/rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_FILE = path.join(HERE, 'sync-code.txt');
const LISTS = ['spells', 'items', 'resources', 'creatures'];
const LIST_RU = { spells: 'заклинание', items: 'предмет', resources: 'ресурс', creatures: 'существо' };

/* ================= облако ================= */

const normalizeCode = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '').match(/.{1,4}/g)?.join('-') || '';

async function syncCode() {
  if (process.env.SPELLBOOK_SYNC_CODE) return normalizeCode(process.env.SPELLBOOK_SYNC_CODE);
  try {
    return normalizeCode(await fs.readFile(CODE_FILE, 'utf8'));
  } catch {
    throw new Error('Код синхронизации не указан. Возьмите его в приложении (имя персонажа → «Синхронизация») и передайте в инструмент set_sync_code.');
  }
}

async function cloud(body, code) {
  code = code || (await syncCode());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, code }),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409 && data.conflict) return data;
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Сервер синхронизации не ответил за 20 секунд');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readAll() {
  const r = await cloud({ peek: true });
  if (!r.existed) throw new Error('По этому коду синхронизации данных нет');
  return { characters: (r.characters || []).map(normalizeCharacter), rev: r.rev };
}

// Прочитать → изменить → записать, только если никто не записал раньше (иначе повторить с новыми данными)
async function mutate(fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { characters, rev } = await readAll();
    const result = await fn(characters);
    const res = await cloud({ put: true, baseRev: rev, characters });
    if (res.conflict) continue;
    return result;
  }
  throw new Error('Не удалось записать: данные одновременно меняют с другого устройства, попробуйте ещё раз');
}

/* ================= поиск ================= */

function findIn(list, ref, what) {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) throw new Error(`Укажите ${what}`);
  const byId = list.find((x) => x.id === ref);
  if (byId) return byId;
  const exact = list.filter((x) => String(x.name || '').toLowerCase() === r);
  if (exact.length === 1) return exact[0];
  const part = list.filter((x) => String(x.name || '').toLowerCase().includes(r));
  if (part.length === 1) return part[0];
  const names = (exact.length ? exact : part.length ? part : list).map((x) => `«${x.name}» (${x.id})`).join(', ');
  throw new Error(exact.length || part.length ? `Неоднозначно, подходят: ${names}` : `Не найдено: «${ref}». Есть: ${names || 'ничего'}`);
}
const findChar = (chars, ref) => findIn(chars, ref, 'персонажа (имя или id)');

/* ================= сводка персонажа ================= */

const initiative = (c) => mod(c.abilities.dex) + (Number(c.initBonus) || 0);
const plain = (html) => String(html || '').replace(/<\/(p|div|h3|li|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

function summary(c) {
  const pb = profBonus(c.level);
  const L = [];
  L.push(`# ${c.name} (id ${c.id}) — ${[c.cls, `${c.level} ур.`, `D&D ${c.edition}`].filter(Boolean).join(', ')}`);
  const b = c.bio || {};
  const bio = [b.race, b.background, b.alignment].filter(Boolean).join(' · ');
  if (bio) L.push(bio);
  L.push(`Хиты ${c.hp.cur}/${c.hp.max}${c.hp.temp ? ` (+${c.hp.temp} врем.)` : ''} · КД ${c.ac} · Инициатива ${fmtMod(initiative(c))} · Скорость ${c.speed} фт. · Бонус мастерства ${fmtMod(pb)} · Вдохновение: ${c.inspiration ? 'есть' : 'нет'}`);
  if (c.hp.cur <= 0) L.push(`Спасброски от смерти: успехи ${c.deathSaves.ok}, провалы ${c.deathSaves.fail}`);
  L.push('Характеристики: ' + ABILITIES.map(([k, s]) => `${s} ${c.abilities[k]} (${fmtMod(mod(c.abilities[k]))}, спас ${fmtMod(saveBonus(c, k))}${c.saves[k] ? '●' : ''})`).join(', '));
  const sk = SKILLS.filter(([k]) => c.skills[k]).map(([k, n, a]) => `${n} ${fmtMod(skillBonus(c, k, a))}${c.skills[k] === 2 ? ' (компетентность)' : ''}`);
  L.push(`Навыки с владением: ${sk.join(', ') || 'нет'}${c.jack ? ' · мастер на все руки' : ''}`);
  L.push('Кости хитов: ' + c.hitDice.map((h, i) => `[${i}] к${h.die} ${h.max - h.used}/${h.max}`).join(', '));
  const slots = Object.entries(c.slots).filter(([, s]) => s.max).map(([l, s]) => `${l} ур. ${s.max - s.used}/${s.max}`);
  if (c.pact.max) slots.push(`колдун (${c.pact.level} ур.) ${c.pact.max - c.pact.used}/${c.pact.max}`);
  L.push(`Ячейки: ${slots.join(', ') || 'нет'}`);
  if (c.resources.length) L.push('Ресурсы: ' + c.resources.map((r) => `${r.name} ${r.cur}/${r.max} (${r.reset}) [${r.id}]`).join(', '));
  if (c.spells.length) {
    L.push(`Заклинания (${c.spells.length}):`);
    for (const s of [...c.spells].sort((a, b2) => a.level - b2.level || a.name.localeCompare(b2.name, 'ru'))) {
      const tags = [s.prepared ? 'подготовлено' : '', s.concentration ? 'К' : '', s.ritual ? 'Р' : '',
        s.freeUnlimited ? 'бесплатно ∞' : s.freeMax ? `бесплатно ${s.freeMax - (s.freeUsed || 0)}/${s.freeMax}` : ''].filter(Boolean).join(', ');
      L.push(`  - [${s.level}] ${s.name}${tags ? ` (${tags})` : ''} [${s.id}]`);
    }
  }
  const w = carried(c);
  L.push(`Монеты: ${Object.entries(c.coins).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'нет'} (≈ ${fmtNum(coinsTotal(c.coins))} зм) · Груз ${fmtNum(w.total)}/${fmtNum(capacity(c).carry)} фнт.`);
  if (c.items.length) L.push('Предметы: ' + c.items.map((it) => `${it.name}${Number(it.qty) !== 1 ? ` ×${fmtNum(it.qty)}` : ''} [${it.id}]`).join(', '));
  if ((c.inventory || '').trim()) L.push(`Прочее снаряжение: ${c.inventory.trim().replace(/\n/g, '; ')}`);
  if (c.creatures.length) L.push('Существа: ' + c.creatures.map((cr) => `${cr.name} (${cr.role || '—'}) хиты ${cr.hpCur}/${cr.hpMax}${cr.hpTemp ? ` +${cr.hpTemp}` : ''}, КД ${cr.ac} [${cr.id}]`).join(', '));
  const p = c.prof || {};
  const prof = [['armor', 'Доспехи'], ['weapons', 'Оружие'], ['tools', 'Инструменты'], ['languages', 'Языки']].filter(([k]) => p[k]).map(([k, n]) => `${n}: ${p[k]}`);
  if (prof.length) L.push(prof.join(' · '));
  const notes = plain(c.notesHtml);
  if (notes) L.push(`Заметки (${notes.length} симв.): ${notes.slice(0, 300)}${notes.length > 300 ? '…' : ''}`);
  return L.join('\n');
}

/* ================= правки ================= */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// JSON merge patch (RFC 7396): объекты сливаются, null удаляет поле, массивы и значения заменяются
function mergePatch(target, patch) {
  if (!isObj(patch)) return patch;
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

function patchCharacter(chars, c, patch) {
  if ('id' in patch) throw new Error('id менять нельзя');
  if (typeof patch.notesHtml === 'string') patch = { ...patch, notesHtml: sanitizeHtml(patch.notesHtml) };
  const next = normalizeCharacter(mergePatch(c, patch));
  chars[chars.indexOf(c)] = next;
  return next;
}

function newEntry(list, entry) {
  const base = {
    spells: { ...emptySpell(), prepared: false },
    items: { name: '', qty: 1, weight: 0, cost: 0, cur: 'gp', note: '' },
    resources: { name: '', max: 1, reset: 'long' },
    creatures: emptyCreature(),
  }[list];
  const e = { ...base, ...entry, id: uid() };
  if (list === 'resources' && e.cur === undefined) e.cur = e.max;
  if (list === 'creatures' && entry.hpCur === undefined) e.hpCur = e.hpMax;
  if (!String(e.name || '').trim()) throw new Error('Нужно название (name)');
  return e;
}

async function fetchPage(url, kind) {
  const target = normalizeDndUrl(url, kind);
  const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (spellbook-mcp)', 'Accept-Language': 'ru-RU,ru;q=0.9' } });
  if (!r.ok) throw new Error(`dnd.su ответил HTTP ${r.status}`);
  return { html: await r.text(), target };
}

/* ================= сервер ================= */

const server = new McpServer({ name: 'spellbook', version: '1.0.0' });

const ok = (text) => ({ content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] });
function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return { content: [{ type: 'text', text: `Ошибка: ${e.message}` }], isError: true };
    }
  });
}

const CHAR = z.string().describe('Имя персонажа (можно часть) или его id');
const LIST = z.enum(LISTS).describe('Список: spells — заклинания, items — предметы, resources — ресурсы, creatures — существа');
const ENTRY = z.string().describe('Название (можно часть) или id элемента списка');

// --- служебное ---
tool('set_sync_code', 'Указать код синхронизации (из приложения: имя персонажа → «Синхронизация»). Проверяет код и сохраняет его локально.',
  { code: z.string() }, async ({ code }) => {
    const c = normalizeCode(code);
    const r = await cloud({ peek: true }, c);
    if (!r.existed) throw new Error('По этому коду данных нет — проверьте код');
    await fs.writeFile(CODE_FILE, c + '\n', 'utf8');
    return `Код сохранён. Персонажей в облаке: ${(r.characters || []).length}.`;
  });

tool('sync_status', 'Проверить связь с облаком синхронизации: указан ли код, сколько персонажей, номер версии.', {}, async () => {
  const { characters, rev } = await readAll();
  return `Облако доступно. Версия данных ${rev}, персонажей ${characters.length}: ${characters.map((c) => c.name).join(', ')}`;
});

// --- персонажи ---
tool('list_characters', 'Список персонажей.', {}, async () => {
  const { characters } = await readAll();
  return characters.map((c) => `${c.name} [${c.id}] — ${[c.cls, `${c.level} ур.`].filter(Boolean).join(', ')}, хиты ${c.hp.cur}/${c.hp.max}, заклинаний ${c.spells.length}, предметов ${c.items.length}`).join('\n') || 'Персонажей нет';
});

tool('get_character', 'Сводка персонажа с вычисленными бонусами. full=true — весь объект персонажа (JSON), чтобы увидеть все поля для update_character.',
  { character: CHAR, full: z.boolean().optional() }, async ({ character, full }) => {
    const { characters } = await readAll();
    const c = findChar(characters, character);
    return full ? JSON.stringify(c, null, 2) : summary(c);
  });

tool('create_character', 'Создать персонажа. fields — любые поля как в get_character(full) (cls, level, edition, abilities, hp, bio…).',
  { name: z.string(), fields: z.record(z.any()).optional() }, async ({ name, fields }) => mutate((chars) => {
    let c = newCharacter(name);
    if (fields) {
      const { id: _ignored, ...rest } = fields;
      c = normalizeCharacter(mergePatch(c, rest));
    }
    c.name = name;
    chars.push(c);
    return `Создан «${c.name}» [${c.id}]`;
  }));

tool('delete_character', 'Удалить персонажа. Нужно confirm=true. Удаление можно откатить через историю версий.',
  { character: CHAR, confirm: z.literal(true) }, async ({ character }) => mutate((chars) => {
    const c = findChar(chars, character);
    if (chars.length === 1) throw new Error('Нельзя удалить единственного персонажа');
    chars.splice(chars.indexOf(c), 1);
    return `Удалён «${c.name}»`;
  }));

tool('update_character',
  'Изменить поля персонажа частичным патчем (JSON merge patch): {"level":6,"hp":{"max":40},"abilities":{"str":16},"bio":{"backstory":"…"},"skills":{"stealth":1},"coins":{"gp":120},"inventory":"…"}. null удаляет поле. Списки целиком так не менять — для них add_entry/update_entry/remove_entry. Структура полей — get_character(full=true).',
  { character: CHAR, patch: z.record(z.any()) }, async ({ character, patch }) => mutate((chars) => {
    const c = patchCharacter(chars, findChar(chars, character), patch);
    return `Сохранено.\n\n${summary(c)}`;
  }));

// --- списки ---
tool('add_entry', 'Добавить элемент в список персонажа. Поля: spells — как в get_character(full) (name, level, school, castTime, range, components, duration, text, higher, concentration, ritual, prepared, freeMax, freeReset…); items — name, qty, weight, cost, cur (cp/sp/ep/gp/pp), note; resources — name, max, cur, reset (short/long/none); creatures — name, role, ac, hpMax, speed, abilities, props, sections, notes.',
  { character: CHAR, list: LIST, entry: z.record(z.any()) }, async ({ character, list, entry }) => mutate((chars) => {
    const c = findChar(chars, character);
    const e = newEntry(list, entry);
    c[list].push(e);
    return `Добавлено ${LIST_RU[list]} «${e.name}» [${e.id}] персонажу «${c.name}»`;
  }));

tool('update_entry', 'Изменить элемент списка частичным патчем (например {"qty":3} у предмета, {"prepared":true} у заклинания).',
  { character: CHAR, list: LIST, entry: ENTRY, patch: z.record(z.any()) }, async ({ character, list, entry, patch }) => mutate((chars) => {
    const c = findChar(chars, character);
    const e = findIn(c[list], entry, LIST_RU[list]);
    if ('id' in patch) throw new Error('id менять нельзя');
    c[list][c[list].indexOf(e)] = mergePatch(e, patch);
    return `Изменено ${LIST_RU[list]} «${e.name}»: ${JSON.stringify(patch)}`;
  }));

tool('remove_entry', 'Удалить элемент списка.', { character: CHAR, list: LIST, entry: ENTRY }, async ({ character, list, entry }) => mutate((chars) => {
  const c = findChar(chars, character);
  const e = findIn(c[list], entry, LIST_RU[list]);
  c[list].splice(c[list].indexOf(e), 1);
  return `Удалено ${LIST_RU[list]} «${e.name}»`;
}));

tool('add_spell_from_dndsu', 'Загрузить заклинание со страницы dnd.su или next.dnd.su (ссылка вида dnd.su/spells/205-fireball/) и добавить персонажу.',
  { character: CHAR, url: z.string(), prepared: z.boolean().optional() }, async ({ character, url, prepared }) => {
    const { html, target } = await fetchPage(url, 'spells');
    const spell = parseHtml(html, target);
    return mutate((chars) => {
      const c = findChar(chars, character);
      const dup = c.spells.find((s) => s.name.toLowerCase() === spell.name.toLowerCase() && s.edition === spell.edition);
      const e = { ...spell, id: uid(), prepared: !!prepared };
      c.spells.push(e);
      return `Добавлено «${e.name}» (${e.level ? `${e.level} уровень` : 'заговор'}, ${e.edition}) [${e.id}]${dup ? ' — внимание: такое заклинание уже было' : ''}`;
    });
  });

tool('add_spell_from_text', 'Разобрать скопированный текст заклинания (как вставка в приложении) и добавить персонажу.',
  { character: CHAR, text: z.string(), url: z.string().optional(), prepared: z.boolean().optional() }, async ({ character, text, url, prepared }) => mutate((chars) => {
    const c = findChar(chars, character);
    const spell = parseText(text, url || '');
    if (!spell.name) throw new Error('Не удалось найти название');
    const e = { ...spell, id: uid(), prepared: !!prepared };
    c.spells.push(e);
    return `Добавлено «${e.name}» (${e.level ? `${e.level} уровень` : 'заговор'}) [${e.id}]`;
  }));

tool('add_creature_from_dndsu', 'Загрузить существо из бестиария dnd.su или next.dnd.su (dnd.su/bestiary/84-imp/) и добавить персонажу (фамильяр, призванное существо…).',
  { character: CHAR, url: z.string(), role: z.string().optional() }, async ({ character, url, role }) => {
    const { html, target } = await fetchPage(url, 'bestiary');
    const cr = parseCreatureHtml(html, target);
    return mutate((chars) => {
      const c = findChar(chars, character);
      const e = { ...cr, id: uid(), role: role ?? 'Фамильяр' };
      c.creatures.push(e);
      return `Добавлено существо «${e.name}» (${e.role}), хиты ${e.hpMax}, КД ${e.ac} [${e.id}]`;
    });
  });

tool('add_creature_from_text', 'Разобрать скопированный блок статистики существа и добавить персонажу.',
  { character: CHAR, text: z.string(), role: z.string().optional() }, async ({ character, text, role }) => mutate((chars) => {
    const c = findChar(chars, character);
    const e = { ...parseCreatureText(text), id: uid(), role: role ?? 'Фамильяр' };
    c.creatures.push(e);
    return `Добавлено существо «${e.name}» [${e.id}]`;
  }));

tool('refresh_from_dndsu', 'Заново загрузить с dnd.su заклинание или существо, добавленное по ссылке (свои отметки, хиты, роль и заметки сохраняются).',
  { character: CHAR, list: z.enum(['spells', 'creatures']), entry: ENTRY }, async ({ character, list, entry }) => {
    const { characters } = await readAll();
    const old = findIn(findChar(characters, character)[list], entry, LIST_RU[list]);
    if (!old.url) throw new Error('У этого элемента нет ссылки на dnd.su');
    const { html, target } = await fetchPage(old.url, list === 'spells' ? 'spells' : 'bestiary');
    const fresh = list === 'spells' ? parseHtml(html, target) : parseCreatureHtml(html, target);
    return mutate((chars) => {
      const c = findChar(chars, character);
      const e = c[list].find((x) => x.id === old.id);
      if (!e) throw new Error('Элемент удалили, пока шла загрузка');
      const keep = list === 'spells'
        ? ['id', 'prepared', 'freeMax', 'freeUsed', 'freeReset', 'freeUnlimited']
        : ['id', 'role', 'notes', 'hpCur', 'hpTemp'];
      const next = { ...e, ...fresh };
      for (const k of keep) if (k in e) next[k] = e[k];
      if (list === 'creatures') { next.hpCur = Math.min(next.hpCur, next.hpMax); next.edited = false; }
      c[list][c[list].indexOf(e)] = next;
      return `Обновлено «${next.name}»`;
    });
  });

// --- игровые действия (та же логика, что в приложении: js/actions.js) ---
const hpLine = (c) => `Хиты ${c.hp.cur}/${c.hp.max}${c.hp.temp ? ` (+${c.hp.temp} врем.)` : ''}`;
const onChar = (fn) => async (a) => mutate((chars) => fn(findChar(chars, a.character), a, chars));

tool('damage', 'Урон персонажу (сначала снимаются временные хиты).', { character: CHAR, amount: z.number() },
  onChar((c, { amount }) => { act.damage(c, amount); return `${c.name}: −${amount}. ${hpLine(c)}`; }));
tool('heal', 'Лечение персонажа (с 0 хитов сбрасывает спасброски от смерти).', { character: CHAR, amount: z.number() },
  onChar((c, { amount }) => { act.heal(c, amount); return `${c.name}: +${amount}. ${hpLine(c)}`; }));
tool('set_hp', 'Задать текущие, максимальные и/или временные хиты.', { character: CHAR, cur: z.number().optional(), max: z.number().optional(), temp: z.number().optional() },
  onChar((c, { cur, max, temp }) => {
    act.setHp(c, { cur, max });
    if (temp !== undefined) act.setTempHp(c, temp);
    return `${c.name}: ${hpLine(c)}`;
  }));
tool('death_saves', 'Задать число успехов/провалов спасбросков от смерти (0–3).', { character: CHAR, successes: z.number().optional(), failures: z.number().optional() },
  onChar((c, { successes, failures }) => {
    if (successes !== undefined) act.setDeathSaves(c, 'ok', successes);
    if (failures !== undefined) act.setDeathSaves(c, 'fail', failures);
    return `${c.name}: успехи ${c.deathSaves.ok}, провалы ${c.deathSaves.fail}`;
  }));

tool('cast_spell', 'Сотворить заклинание. how: номер уровня ячейки ("3"), "pact" (ячейка колдуна), "free" (бесплатное использование), "free-reset" (восстановить бесплатные), "ritual", "nocost". Без how — только показать варианты, ничего не меняя.',
  { character: CHAR, spell: ENTRY, how: z.string().optional() }, async ({ character, spell, how }) => {
    if (!how) {
      const { characters } = await readAll();
      const c = findChar(characters, character);
      const s = findIn(c.spells, spell, 'заклинание');
      return `Варианты для «${s.name}»:\n` + act.castOptions(c, s).map((o) => `- how="${o.how}": ${o.label}${Number.isFinite(o.left) ? `, осталось ${o.left}` : ''}`).join('\n');
    }
    return mutate((chars) => {
      const c = findChar(chars, character);
      return act.castSpell(c, findIn(c.spells, spell, 'заклинание'), how).text;
    });
  });

tool('use_slot', 'Потратить (delta>0) или вернуть (delta<0) ячейки. level: 1–9 или "pact".', { character: CHAR, level: z.string(), delta: z.number().default(1) },
  onChar((c, { level, delta }) => {
    const r = level === 'pact' ? act.usePact(c, delta) : act.useSlot(c, level, delta);
    return `${c.name}: ячейки ${level === 'pact' ? 'колдуна' : `${r.level} ур.`} ${r.left}/${r.max}`;
  }));

tool('spend_hit_die', 'Потратить кость хитов: roll — сколько выпало на кости (бросает игрок), к хитам добавится мод. Телосложения. die — номер типа костей из сводки (по умолчанию 0) или размер («8» для к8).',
  { character: CHAR, roll: z.number(), die: z.string().optional() }, onChar((c, { roll, die }) => {
    let i = 0;
    if (die !== undefined) {
      i = c.hitDice.findIndex((h, idx) => String(idx) === die || `к${h.die}` === die || `d${h.die}` === die || String(h.die) === die);
      if (i < 0) throw new Error('Такого типа костей хитов нет');
    }
    return `${c.name}: ${act.spendHitDie(c, i, roll).text}. ${hpLine(c)}`;
  }));

tool('short_rest', 'Короткий отдых (ячейки колдуна, ресурсы и бесплатные заклинания «короткого отдыха»).', { character: CHAR },
  onChar((c) => `${c.name}: ${act.shortRest(c).text}`));
tool('long_rest', 'Длинный отдых (хиты, кости хитов по правилам редакции, ячейки, ресурсы, существа).', { character: CHAR },
  onChar((c) => `${c.name}: ${act.longRest(c).text}. ${hpLine(c)}`));

tool('resource_change', 'Изменить счётчик ресурса: delta (+/−) или value (точное значение).', { character: CHAR, resource: ENTRY, delta: z.number().optional(), value: z.number().optional() },
  onChar((c, { resource, delta, value }) => {
    const r = findIn(c.resources, resource, 'ресурс');
    const res = value !== undefined ? act.resourceSet(c, r, value) : act.resourceDelta(c, r, delta ?? -1);
    return `${c.name}: ${res.name} ${res.cur}/${res.max}`;
  }));

tool('creature_hp', 'Хиты существа: damage (урон, сначала временные), heal, cur (задать), temp (временные).',
  { character: CHAR, creature: ENTRY, damage: z.number().optional(), heal: z.number().optional(), cur: z.number().optional(), temp: z.number().optional() },
  onChar((c, { creature, damage, heal, cur, temp }) => {
    const cr = findIn(c.creatures, creature, 'существо');
    if (damage !== undefined) act.creatureDamage(cr, damage);
    if (heal !== undefined) act.creatureHeal(cr, heal);
    if (cur !== undefined || temp !== undefined) act.creatureSetHp(cr, { cur, temp });
    return `${cr.name}: хиты ${cr.hpCur}/${cr.hpMax}${cr.hpTemp ? ` (+${cr.hpTemp})` : ''}`;
  }));

// --- заметки ---
tool('get_notes', 'Заметки персонажа (текст и HTML с форматированием).', { character: CHAR }, async ({ character }) => {
  const { characters } = await readAll();
  const c = findChar(characters, character);
  return `Текст:\n${plain(c.notesHtml) || '(пусто)'}\n\nHTML:\n${c.notesHtml || ''}`;
});
tool('set_notes', 'Записать заметки. html — с форматированием (b, i, u, s, h3, ul/ol/li, blockquote, p/div) или text — обычный текст. mode: replace (по умолчанию) или append.',
  { character: CHAR, html: z.string().optional(), text: z.string().optional(), mode: z.enum(['replace', 'append']).optional() },
  onChar((c, { html, text, mode }) => {
    if (html === undefined && text === undefined) throw new Error('Нужно html или text');
    const add = sanitizeHtml(html !== undefined ? html : textToHtml(text));
    c.notesHtml = mode === 'append' ? (c.notesHtml || '') + add : add;
    c.notes = plain(c.notesHtml);
    return `${c.name}: заметки сохранены (${c.notes.length} симв.)`;
  }));

// --- экспорт ---
tool('export_lss', 'Сохранить персонажа в файл для Long Story Short (JSON). path — куда сохранить (по умолчанию в папку проекта).',
  { character: CHAR, path: z.string().optional() }, async ({ character, path: p }) => {
    const { characters } = await readAll();
    const c = findChar(characters, character);
    const file = path.resolve(p || path.join(HERE, '..', '..', `${c.name.replace(/[\\/:*?"<>|]+/g, '_')}-lss.json`));
    await fs.writeFile(file, JSON.stringify(toLss(c), null, 2), 'utf8');
    return `Сохранено: ${file}`;
  });

// --- история ---
tool('list_versions', 'История версий в облаке (последние 50): номер, время, кратко по персонажам.', {}, async () => {
  const r = await cloud({ history: true });
  return (r.versions || []).map((v, i) => `rev ${v.rev} — ${new Date(v.created).toLocaleString('ru-RU')}${i === 0 ? ' (текущая)' : ''}: ${v.chars.map((c) => `${c.name} (${c.items} вещ., ${c.spells} закл.)`).join('; ')}`).join('\n') || 'История пуста';
});
tool('get_version', 'Посмотреть версию из истории: сводка по персонажам (или full=true — JSON).', { rev: z.number(), full: z.boolean().optional() }, async ({ rev, full }) => {
  const v = await cloud({ historyRev: rev });
  const chars = (v.characters || []).map(normalizeCharacter);
  return full ? JSON.stringify(chars, null, 2) : `Версия ${rev} от ${new Date(v.created).toLocaleString('ru-RU')}\n\n${chars.map(summary).join('\n\n')}`;
});
tool('restore_version', 'Вернуть всех персонажей к версии из истории (станет новой текущей на всех устройствах). Нужно confirm=true. Текущее состояние останется в истории.',
  { rev: z.number(), confirm: z.literal(true) }, async ({ rev }) => {
    const v = await cloud({ historyRev: rev });
    const restored = (v.characters || []).map(normalizeCharacter);
    return mutate((chars) => {
      chars.splice(0, chars.length, ...restored);
      return `Восстановлена версия ${rev}: ${restored.map((c) => c.name).join(', ')}`;
    });
  });

await server.connect(new StdioServerTransport());
