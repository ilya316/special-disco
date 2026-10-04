import { load, save, uid, newCharacter, normalizeCharacter, exportJson, importJson, requestPersistence } from './store.js';
import { parseText, emptySpell, findSpellUrl, editionFromUrl } from './parser.js';
import { fetchSpell } from './import.js';
import { sanitizeHtml } from './richtext.js';
import { printSheet, downloadLss } from './export.js';
import {
  ABILITIES, ABIL_SHORT, SKILLS, SIZES, COINS, COIN_NAME, mod, fmtMod, profBonus, skillBonus, saveBonus,
  capacity, jumps, carried, coinsTotal, itemsValue, fmtNum, restoreHitDice,
} from './rules.js';
import {
  initSync, schedule, syncNow, syncInfo, createSync, connect, disconnect, normalizeCode,
  listVersions, getVersion, restoreCharacters, listBackups, backupLocal,
} from './sync.js';

const APP_VERSION = 'v17'; // меняйте вместе с VERSION в sw.js

let state = load();
const ui = { tab: 'spells', search: '', filter: 'all', open: new Set(), editSlots: false, editRes: false, editHD: false };

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sheetEl = $('#sheet');
const sheet = $('.sheet', sheetEl);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const char = () => state.characters.find((c) => c.id === state.activeId);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const RESET_NAME = { long: 'длинный отдых', short: 'короткий отдых', none: 'вручную' };
const levelName = (l) => (l === 0 ? 'Заговоры' : `${l} уровень`);

function persist() {
  save(state);
  schedule();
}

function commit() {
  persist();
  render();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function applyTheme() {
  const th = state.settings.theme;
  if (th === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = th;
}

/* ---------------- рендер ---------------- */

function render() {
  const c = char();
  $('#charName').innerHTML = `${esc(c.name)} <small>${esc([c.cls, c.level ? c.level + ' ур.' : ''].filter(Boolean).join(', '))} ▾</small>`;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  if (ui.tab === 'spells') renderSpells();
  else if (ui.tab === 'tracker') renderTracker();
  else if (ui.tab === 'sheet') renderSheet();
  else if (ui.tab === 'inventory') renderInventory();
  else if (ui.tab === 'notes') renderNotes();
  else renderCharacter();
}

// Инициатива = модификатор Ловкости + дополнительный бонус (черты, предметы, особенности класса)
const initiative = (c) => mod(c.abilities.dex) + (Number(c.initBonus) || 0);

function slotsInfo(c, level) {
  if (level === 0) return '';
  const s = c.slots[level];
  if (!s || !s.max) return '';
  return `ячейки ${s.max - s.used}/${s.max}`;
}

function renderSpells() {
  const c = char();
  const levels = [...new Set(c.spells.map((s) => s.level))].sort((a, b) => a - b);
  const chips = [
    ['all', 'Все'],
    ['prep', '★ Подготовленные'],
    ...levels.map((l) => [String(l), l === 0 ? 'Заговоры' : `${l} ур.`]),
  ];
  view.innerHTML = `
    <div class="search-row">
      <input type="search" id="spellSearch" placeholder="Поиск по названию…" value="${esc(ui.search)}">
      <button class="btn primary" data-action="add-spell">＋</button>
    </div>
    <div class="chips">
      ${chips.map(([k, t]) => `<button class="chip ${ui.filter === k ? 'active' : ''}" data-action="filter" data-f="${k}">${t}</button>`).join('')}
    </div>
    <div id="spellList"></div>`;
  renderSpellList();
}

function renderSpellList() {
  const c = char();
  const list = $('#spellList');
  if (!list) return;
  if (!c.spells.length) {
    list.innerHTML = `<div class="empty"><span class="big">📜</span>Заклинаний пока нет.<br>Нажмите <b>＋</b>, чтобы добавить заклинание по ссылке с dnd.su или вставив его текст.</div>`;
    return;
  }
  const q = ui.search.trim().toLowerCase();
  const items = c.spells
    .filter((s) => !q || (s.name + ' ' + s.nameEn).toLowerCase().includes(q))
    .filter((s) => ui.filter === 'all' || (ui.filter === 'prep' ? s.prepared || s.level === 0 : String(s.level) === ui.filter))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'ru'));
  if (!items.length) {
    list.innerHTML = `<div class="empty">Ничего не найдено</div>`;
    return;
  }
  let html = '';
  let cur = -1;
  const counts = {};
  for (const s of items) counts[s.level] = (counts[s.level] || 0) + 1;
  const folded = collapsedLevels();
  for (const s of items) {
    // при поиске секции не сворачиваем, чтобы найденное было видно
    const closed = !q && folded.includes(s.level);
    if (s.level !== cur) {
      cur = s.level;
      html += `<button class="level-head ${closed ? 'closed' : ''}" data-action="toggle-level" data-l="${cur}" aria-expanded="${!closed}">
        <span class="chev">▾</span>${levelName(cur)} <span class="level-count">${counts[cur]}</span>
        <span class="slots-mini">${slotsInfo(c, cur)}</span></button>`;
    }
    if (!closed) html += spellCard(s);
  }
  list.innerHTML = html;
}

// Свёрнутые секции — настройка этого устройства, отдельно для каждого персонажа
function collapsedLevels() {
  return (state.settings.collapsed || {})[state.activeId] || [];
}

function spellCard(s) {
  const open = ui.open.has(s.id);
  const tags = [
    s.concentration ? '<span class="tag" title="Концентрация">К</span>' : '',
    s.ritual ? '<span class="tag" title="Ритуал">Р</span>' : '',
    s.edition === '2024' ? '<span class="tag ed">24</span>' : '',
    s.freeUnlimited ? '<span class="tag free" title="Без ячейки неограниченно">◇∞</span>'
      : s.freeMax ? `<span class="tag free" title="Без ячейки">◇${s.freeMax - (s.freeUsed || 0)}/${s.freeMax}</span>` : '',
  ].join('');
  const sub = [s.castTime, s.range, s.components && s.components.replace(/\s*\(.*\)/, '')].filter(Boolean).join(' · ');
  let body = '';
  if (open) {
    const props = [
      ['Школа', s.school], ['Время', s.castTime], ['Дистанция', s.range], ['Компоненты', s.components],
      ['Длительность', s.duration], ['Классы', s.classes], ['Подклассы', s.subclasses], ['Источник', s.source],
      ['Без ячейки', s.freeUnlimited ? 'неограниченно'
        : s.freeMax ? `${s.freeMax - (s.freeUsed || 0)} из ${s.freeMax} (${RESET_NAME[s.freeReset] || ''})` : ''],
    ].filter(([, v]) => v);
    const paras = (t) => t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    body = `<div class="spell-body">
      <dl class="props">${props.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <div class="desc">${paras(s.text || '')}${s.higher ? `<div class="higher">${paras(s.higher)}</div>` : ''}</div>
      <div class="spell-actions">
        ${s.level > 0 ? `<button class="btn primary small" data-action="cast" data-id="${s.id}">✦ Сотворить</button>` : ''}
        <button class="btn small" data-action="edit-spell" data-id="${s.id}">✎ Изменить</button>
        ${s.url ? `<a class="btn small" href="${esc(s.url)}" target="_blank" rel="noopener">dnd.su ↗</a>` : ''}
        ${s.url ? `<button class="btn small" data-action="refresh-spell" data-id="${s.id}">↻ Обновить</button>` : ''}
        <button class="btn small danger" data-action="del-spell" data-id="${s.id}">Удалить</button>
      </div>
    </div>`;
  }
  const prep = s.level === 0 ? '' :
    `<button class="prep ${s.prepared ? 'on' : ''}" data-action="prep" data-id="${s.id}" title="Подготовлено">★</button>`;
  return `<div class="spell">
    <div class="spell-head" data-action="toggle-spell" data-id="${s.id}">
      ${prep}
      <div class="title"><div class="name">${esc(s.name)}</div><div class="sub">${esc(sub)}</div></div>
      <div class="tags">${tags}</div>
    </div>${body}</div>`;
}

function dots(max, used, action, extra = '', cls = '') {
  let h = '';
  for (let i = 0; i < max; i++) {
    const full = i < max - used;
    h += `<button class="dot ${cls} ${full ? 'full' : ''}" data-action="${action}" data-full="${full ? 1 : 0}" ${extra}></button>`;
  }
  return h;
}

function renderTracker() {
  const c = char();
  const hp = c.hp;
  const total = Math.max(hp.max, hp.cur + hp.temp) || 1;
  const pct = (hp.cur / total) * 100;
  const tpct = (hp.temp / total) * 100;
  const low = hp.cur <= hp.max / 4;

  const death = hp.cur <= 0 ? `
    <div class="death">
      <div class="grp"><div class="small muted">Успехи</div><div class="dots">${[0, 1, 2].map((i) => `<button class="dot ok ${i < c.deathSaves.ok ? 'full' : ''}" data-action="death" data-k="ok" data-i="${i}"></button>`).join('')}</div></div>
      <div class="grp"><div class="small muted">Провалы</div><div class="dots">${[0, 1, 2].map((i) => `<button class="dot fail ${i < c.deathSaves.fail ? 'full' : ''}" data-action="death" data-k="fail" data-i="${i}"></button>`).join('')}</div></div>
    </div>` : '';

  const slotLevels = Object.keys(c.slots).map(Number).filter((l) => c.slots[l].max > 0);
  let slotsHtml;
  if (ui.editSlots) {
    slotsHtml = `
      <div class="hint">Автозаполнение для ${c.level} ур. персонажа:</div>
      <div class="row wrap" style="margin-bottom:8px">
        <button class="btn small" data-action="auto-slots" data-kind="full">Полный заклинатель</button>
        <button class="btn small" data-action="auto-slots" data-kind="half">Полузаклинатель</button>
        <button class="btn small" data-action="auto-slots" data-kind="pact">Колдун</button>
      </div>
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => `
        <div class="slot-row"><span class="lvl">${l} ур.</span><span class="grow"></span>
          <div class="stepper">
            <button class="btn small icon" data-action="slot-max" data-l="${l}" data-d="-1">−</button>
            <span class="val">${c.slots[l].max}</span>
            <button class="btn small icon" data-action="slot-max" data-l="${l}" data-d="1">＋</button>
          </div></div>`).join('')}
      <div class="slot-row"><span class="lvl">Колдун</span><span class="grow small muted">кол-во</span>
        <div class="stepper">
          <button class="btn small icon" data-action="pact-max" data-d="-1">−</button>
          <span class="val">${c.pact.max}</span>
          <button class="btn small icon" data-action="pact-max" data-d="1">＋</button>
        </div></div>
      <div class="slot-row"><span class="lvl"></span><span class="grow small muted">уровень ячеек колдуна</span>
        <div class="stepper">
          <button class="btn small icon" data-action="pact-level" data-d="-1">−</button>
          <span class="val">${c.pact.level}</span>
          <button class="btn small icon" data-action="pact-level" data-d="1">＋</button>
        </div></div>`;
  } else if (!slotLevels.length && !c.pact.max) {
    slotsHtml = `<div class="muted small">Ячейки не заданы. Нажмите ✎, чтобы настроить.</div>`;
  } else {
    slotsHtml = slotLevels.map((l) => {
      const s = c.slots[l];
      return `<div class="slot-row"><span class="lvl">${l} ур.</span><div class="dots">${dots(s.max, s.used, 'slot', `data-l="${l}"`)}</div><span class="count">${s.max - s.used}/${s.max}</span></div>`;
    }).join('') + (c.pact.max ? `<div class="slot-row"><span class="lvl">Колдун<br><span class="small muted">${c.pact.level} ур.</span></span><div class="dots">${dots(c.pact.max, c.pact.used, 'pact')}</div><span class="count">${c.pact.max - c.pact.used}/${c.pact.max}</span></div>` : '');
  }

  const conMod = mod(c.abilities.con);
  let hdHtml;
  if (ui.editHD) {
    hdHtml = c.hitDice.map((h, i) => `
      <div class="slot-row">
        <select class="hd-die" data-hd-die="${i}">${[6, 8, 10, 12].map((d) => `<option value="${d}" ${h.die === d ? 'selected' : ''}>к${d}</option>`).join('')}</select>
        <span class="grow small muted">количество</span>
        <div class="stepper">
          <button class="btn small icon" data-action="hd-max" data-i="${i}" data-d="-1">−</button>
          <span class="val">${h.max}</span>
          <button class="btn small icon" data-action="hd-max" data-i="${i}" data-d="1">＋</button>
        </div>
        ${c.hitDice.length > 1 ? `<button class="btn small icon danger" data-action="hd-del" data-i="${i}">×</button>` : ''}
      </div>`).join('') + `
      <div class="row wrap" style="margin-top:8px">
        <button class="btn small" data-action="hd-add">＋ Другой тип костей</button>
        <button class="btn small" data-action="hd-level">По уровню (${c.level})</button>
      </div>
      <div class="hint">Несколько типов костей — для мультикласса.</div>`;
  } else {
    hdHtml = c.hitDice.map((h, i) => `
      <div class="slot-row">
        <span class="lvl">к${h.die}</span>
        <div class="dots">${dots(h.max, h.used, 'hd', `data-i="${i}"`)}</div>
        <span class="count">${h.max - h.used}/${h.max}</span>
        <button class="btn small" data-action="hd-spend" data-i="${i}" ${h.used >= h.max ? 'disabled' : ''}>Потратить</button>
      </div>`).join('') + `<div class="hint">«Потратить» — ввести выпавшее на кости, к хитам добавится ${fmtMod(conMod)} (ТЕЛ).
        Кружок — просто отметить кость. Длинный отдых возвращает ${c.edition === '2024' ? 'все кости' : 'половину костей'}.</div>`;
  }

  const resetName = { short: 'кор. отдых', long: 'дл. отдых', none: 'вручную' };
  const resHtml = c.resources.length ? c.resources.map((r) => `
    <div class="res">
      <div class="info" ${ui.editRes ? `data-action="edit-res" data-id="${r.id}"` : ''}>
        <div class="name">${esc(r.name)} ${ui.editRes ? '✎' : ''}</div>
        <span class="badge">${resetName[r.reset] || ''}</span>
        ${r.max <= 12 ? `<div class="res-dots">${dots(r.max, r.max - r.cur, 'res-dot', `data-id="${r.id}"`)}</div>` : ''}
      </div>
      <button class="btn icon" data-action="res" data-id="${r.id}" data-d="-1">−</button>
      <div class="val" data-action="res-set" data-id="${r.id}">${r.cur}<small>/${r.max}</small></div>
      <button class="btn icon" data-action="res" data-id="${r.id}" data-d="1">＋</button>
    </div>`).join('') : `<div class="muted small">Здесь можно отслеживать ярость, канал божественности, вдохновение, заряды предметов и т.д.</div>`;

  const init = initiative(c);
  view.innerHTML = `
    <div class="combat">
      <button class="combat-tile" data-action="ac"><span class="v">${c.ac}</span><span class="l">КД</span></button>
      <button class="combat-tile" data-action="init"><span class="v">${fmtMod(init)}</span><span class="l">Инициатива</span></button>
      <button class="combat-tile" data-action="speed"><span class="v">${c.speed}<small> фт.</small></span><span class="l">Скорость</span></button>
      <button class="combat-tile insp ${c.inspiration ? 'on' : ''}" data-action="inspiration" aria-pressed="${c.inspiration}">
        <span class="v">${c.inspiration ? '★' : '☆'}</span><span class="l">Вдохновение</span></button>
    </div>

    <div class="rest-row">
      <button class="btn" data-action="rest" data-kind="short">☕ Короткий отдых</button>
      <button class="btn" data-action="rest" data-kind="long">🌙 Длинный отдых</button>
    </div>

    <div class="card">
      <h3>Хиты <span class="spacer"></span><button class="btn link small" data-action="hp-max">макс: ${hp.max} ✎</button></h3>
      <div class="hp-main">
        <span class="hp-cur" data-action="hp-set">${hp.cur}</span><span class="hp-max">/ ${hp.max}</span>
        ${hp.temp ? `<span class="hp-temp">+${hp.temp}</span>` : ''}
      </div>
      <div class="hp-bar"><div class="fill ${low ? 'low' : ''}" style="width:${pct}%"></div><div class="tmp" style="width:${tpct}%"></div></div>
      <div class="hp-input">
        <button class="btn solid-danger" data-action="dmg">− Урон</button>
        <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="hpVal" placeholder="0" min="0">
        <button class="btn ok" data-action="heal">＋ Лечение</button>
      </div>
      <div class="hp-extra">
        <button class="btn link small" data-action="temp">Временные хиты</button>
        ${hp.temp ? `<button class="btn link small" data-action="temp-clear">Сбросить временные</button>` : ''}
      </div>
      ${death}
    </div>

    <div class="card">
      <h3>Кости хитов <span class="spacer"></span>
        <button class="btn link small" data-action="toggle-edit-hd">${ui.editHD ? 'Готово' : '✎'}</button></h3>
      ${hdHtml}
    </div>

    <div class="card">
      <h3>Ячейки заклинаний <span class="spacer"></span>
        <button class="btn link small" data-action="toggle-edit-slots">${ui.editSlots ? 'Готово' : '✎'}</button></h3>
      ${slotsHtml}
    </div>

    <div class="card">
      <h3>Ресурсы <span class="spacer"></span>
        ${c.resources.length ? `<button class="btn link small" data-action="toggle-edit-res">${ui.editRes ? 'Готово' : '✎'}</button>` : ''}
        <button class="btn link small" data-action="add-res">＋</button></h3>
      ${resHtml}
    </div>`;
}

function loadCard(c) {
  const cap = capacity(c);
  const w = carried(c);
  const pct = cap.carry ? Math.min(100, (w.total / cap.carry) * 100) : 0;
  let status = '';
  if (w.total > cap.carry) status = `<div class="err">Перегруз: превышена грузоподъёмность на ${fmtNum(w.total - cap.carry)} фнт.</div>`;
  else if (w.total > cap.heavy) status = '<div class="hint">По варианту правил «Нагрузка»: сильная нагрузка (скорость −20 фт., помеха).</div>';
  else if (w.total > cap.encumbered) status = '<div class="hint">По варианту правил «Нагрузка»: нагружен (скорость −10 фт.).</div>';
  return `
    <div class="card">
      <h3>Груз</h3>
      <div class="load-main"><b>${fmtNum(w.total)}</b> из ${fmtNum(cap.carry)} фнт.</div>
      <div class="hp-bar"><div class="fill ${w.total > cap.carry ? 'low' : ''}" style="width:${pct}%"></div></div>
      <div class="small muted">Предметы ${fmtNum(w.items)} фнт.${c.coinsWeight ? ` · монеты ${fmtNum(w.coins)} фнт.` : ''}
        · толкать/тянуть/поднимать до ${fmtNum(cap.push)} фнт.</div>
      ${status}
    </div>`;
}

function renderInventory() {
  const c = char();
  const total = coinsTotal(c.coins);
  const value = itemsValue(c);
  const items = c.items.map((it) => {
    const meta = [
      Number(it.weight) ? `${fmtNum(it.weight)} фнт.` : '',
      Number(it.cost) ? `${fmtNum(it.cost)} ${COIN_NAME[it.cur] || 'зм'}` : '',
    ].filter(Boolean).join(' · ');
    return `
    <div class="item">
      <div class="info" data-action="edit-item" data-id="${it.id}">
        <div class="name">${esc(it.name)}</div>
        ${meta || it.note ? `<div class="small muted">${esc(meta)}${meta && it.note ? ' · ' : ''}${esc(it.note || '')}</div>` : ''}
      </div>
      <button class="btn small icon" data-action="item-qty" data-id="${it.id}" data-d="-1">−</button>
      <span class="qty">${fmtNum(it.qty)}</span>
      <button class="btn small icon" data-action="item-qty" data-id="${it.id}" data-d="1">＋</button>
    </div>`;
  }).join('');

  view.innerHTML = `
    ${loadCard(c)}

    <div class="card">
      <h3>Монеты <span class="spacer"></span><span class="small muted">≈ ${fmtNum(total)} зм</span></h3>
      <div class="coins">
        ${COINS.map(([k, n]) => `<label><span>${n}</span><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-coin="${k}" value="${c.coins[k] || 0}"></label>`).join('')}
      </div>
      <label class="check" style="margin:10px 0 0"><input type="checkbox" data-sheet="coinsWeight" ${c.coinsWeight ? 'checked' : ''}> Учитывать вес монет (50 шт. = 1 фнт.)</label>
    </div>

    <div class="card">
      <h3>Предметы <span class="spacer"></span><button class="btn link small" data-action="add-item">＋ Добавить</button></h3>
      ${items || '<div class="muted small">Пока пусто. Нажмите «＋ Добавить».</div>'}
      ${c.items.length ? `<div class="item-total">Итого: ${fmtNum(carried(c).items)} фнт. · ${fmtNum(value)} зм</div>` : ''}
      ${c.items.length ? '<div class="hint">Нажмите на предмет, чтобы изменить вес, цену или удалить.</div>' : ''}
    </div>

    <div class="card">
      <h3>Прочее <span class="spacer"></span><span class="small muted" id="inventorySaved"></span></h3>
      <textarea data-text="inventory" class="autogrow" data-min="120" placeholder="Что угодно текстом">${esc(c.inventory)}</textarea>
    </div>`;
  view.querySelectorAll('textarea.autogrow').forEach(autoGrow);
}

const RTE_TOOLS = [
  ['bold', '<b>Ж</b>', 'Жирный'],
  ['italic', '<i>К</i>', 'Курсив'],
  ['underline', '<u>Ч</u>', 'Подчёркнутый'],
  ['strikeThrough', '<s>З</s>', 'Зачёркнутый'],
  ['h3', 'H', 'Заголовок'],
  ['insertUnorderedList', '•', 'Список'],
  ['insertOrderedList', '1.', 'Нумерованный список'],
  ['blockquote', '❝', 'Цитата'],
  ['removeFormat', '⌫', 'Убрать форматирование'],
];

function renderNotes() {
  view.innerHTML = `
    <div class="rte-bar" id="rteBar">
      ${RTE_TOOLS.map(([cmd, label, title]) => `<button type="button" data-cmd="${cmd}" title="${title}" aria-label="${title}">${label}</button>`).join('')}
    </div>
    <div class="card inv">
      <h3>Заметки <span class="spacer"></span><span class="small muted" id="notesSaved"></span></h3>
      <div class="rte" id="notesEditor" contenteditable="true" spellcheck="true"
        data-placeholder="Сюжет, имена NPC, квесты, долги таверне…">${sanitizeHtml(char().notesHtml)}</div>
      <div class="hint">Сохраняется автоматически. Текст, вставленный с сайтов и из документов, сохраняет жирный, курсив, списки и заголовки.</div>
    </div>`;
  const bar = $('#rteBar');
  bar.style.top = $('.topbar').offsetHeight + 'px';
  const ed = $('#notesEditor');
  ed.classList.toggle('empty', !ed.textContent.trim());

  // pointerdown + preventDefault: кнопка не забирает фокус и выделение у редактора
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-cmd]')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    if (document.activeElement !== ed) ed.focus();
    const cmd = b.dataset.cmd;
    if (cmd === 'h3' || cmd === 'blockquote') {
      const cur = String(document.queryCommandValue('formatBlock')).toLowerCase().replace(/[<>]/g, '');
      document.execCommand('formatBlock', false, cur === cmd ? 'div' : cmd);
    } else {
      document.execCommand(cmd);
    }
    saveNotes(ed);
    updateRteBar();
  });

  ed.addEventListener('paste', (e) => {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (html) document.execCommand('insertHTML', false, sanitizeHtml(html));
    else document.execCommand('insertText', false, text);
  });
  ed.addEventListener('input', () => saveNotes(ed));
  ed.addEventListener('keyup', updateRteBar);
  ed.addEventListener('mouseup', updateRteBar);
  ed.addEventListener('blur', () => bar.querySelectorAll('.on').forEach((b) => b.classList.remove('on')));
}

// Подсветка кнопок, которые уже применены к тексту под курсором
function updateRteBar() {
  const bar = $('#rteBar');
  if (!bar) return;
  const block = String(document.queryCommandValue('formatBlock')).toLowerCase().replace(/[<>]/g, '');
  bar.querySelectorAll('[data-cmd]').forEach((b) => {
    const cmd = b.dataset.cmd;
    let on = false;
    try {
      on = cmd === 'h3' || cmd === 'blockquote' ? block === cmd : cmd !== 'removeFormat' && document.queryCommandState(cmd);
    } catch {}
    b.classList.toggle('on', on);
  });
}
document.addEventListener('selectionchange', () => {
  if (document.activeElement?.id === 'notesEditor') updateRteBar();
});

let notesTimer;
function saveNotes(ed) {
  ed.classList.toggle('empty', !ed.textContent.trim());
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    const c = char();
    c.notesHtml = sanitizeHtml(ed.innerHTML);
    c.notes = ed.innerText; // простой текст — для старых версий приложения
    persist();
    const m = $('#notesSaved');
    if (m) m.textContent = 'сохранено';
  }, 400);
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(t.scrollHeight + 2, Number(t.dataset.min) || 300) + 'px';
}

function renderSheet() {
  const c = char();
  const pb = profBonus(c.level);
  const cap = capacity(c);
  const w = carried(c);
  const j = jumps(c);
  const marker = (lvl) => `<span class="prof p${lvl}"></span>`;
  view.innerHTML = `
    <div class="card">
      <h3>Характеристики</h3>
      <div class="abil-grid">
        ${ABILITIES.map(([k, short]) => `
          <button class="abil" data-action="abil" data-a="${k}">
            <span class="abil-name">${short}</span>
            <span class="abil-mod">${fmtMod(mod(c.abilities[k]))}</span>
            <span class="abil-score">${c.abilities[k]}</span>
          </button>`).join('')}
      </div>
      <div class="stat-grid">
        <div><span>${fmtMod(pb)}</span>Бонус мастерства</div>
        <div><span>${fmtMod(initiative(c))}</span>Инициатива</div>
        <div><span>${10 + skillBonus(c, 'perception', 'wis')}</span>Пасс. внимат.</div>
      </div>
      <div class="hint">Нажмите на характеристику, чтобы изменить значение. Бонус мастерства — по уровню персонажа (${c.level}).</div>
    </div>

    <div class="card">
      <h3>Спасброски</h3>
      ${ABILITIES.map(([k, , name]) => `
        <div class="skill" data-action="save-toggle" data-a="${k}">
          ${marker(c.saves[k] ? 1 : 0)}<span class="grow">${name}</span><b>${fmtMod(saveBonus(c, k))}</b>
        </div>`).join('')}
    </div>

    <div class="card">
      <h3>Навыки</h3>
      ${SKILLS.map(([k, name, a]) => `
        <div class="skill" data-action="skill" data-k="${k}">
          ${marker(c.skills[k] || 0)}<span class="grow">${name} <span class="muted small">${ABIL_SHORT[a]}</span></span><b>${fmtMod(skillBonus(c, k, a))}</b>
        </div>`).join('')}
      <label class="check" style="margin:10px 0 0"><input type="checkbox" data-sheet="jack" ${c.jack ? 'checked' : ''}> Мастер на все руки (+½ бонуса мастерства к навыкам без владения)</label>
      <div class="hint">Нажатие по навыку: нет → владение ● → компетентность ◉.</div>
    </div>

    <div class="card">
      <h3>Грузоподъёмность и прыжки</h3>
      <div class="grid2">
        <label class="field"><span>Размер</span><select data-sheet="size">
          ${SIZES.map(([k, n]) => `<option value="${k}" ${c.size === k ? 'selected' : ''}>${n}</option>`).join('')}
        </select></label>
        <label class="check" style="align-self:end;margin-bottom:18px"><input type="checkbox" data-sheet="powerfulBuild" ${c.powerfulBuild ? 'checked' : ''}> Мощное телосложение</label>
      </div>
      <dl class="props">
        <dt>Грузоподъёмность</dt><dd><b>${fmtNum(cap.carry)} фнт.</b> (Сила × 15)</dd>
        <dt>Несёте сейчас</dt><dd><a href="#" data-action="tab" data-tab="inventory">${fmtNum(w.total)} фнт.</a>${w.total > cap.carry ? ' — <span class="err">перегруз</span>' : ''}</dd>
        <dt>Толкать, тянуть</dt><dd>до ${fmtNum(cap.push)} фнт.</dd>
        <dt>Прыжок в длину</dt><dd>${j.longRun} фт. с разбега · ${j.longStand} фт. с места</dd>
        <dt>Прыжок в высоту</dt><dd>${j.highRun} фт. с разбега · ${j.highStand} фт. с места</dd>
      </dl>
      <div class="hint">Разбег — не менее 10 фт. перед прыжком. Всё считается от Силы.</div>
    </div>`;
}

function openItemForm(item) {
  const isNew = !item;
  item = item || { name: '', qty: 1, weight: '', cost: '', cur: 'gp', note: '' };
  openSheet(`
    <h2>${isNew ? 'Новый предмет' : 'Предмет'}<button class="btn icon x" data-action="close">×</button></h2>
    <form id="itemForm">
      <label class="field"><span>Название</span><input type="text" name="name" value="${esc(item.name)}" placeholder="Длинный меч" required></label>
      <div class="grid2">
        <label class="field"><span>Количество</span><input type="text" inputmode="decimal" autocomplete="off" name="qty" value="${item.qty}"></label>
        <label class="field"><span>Вес за 1 шт., фнт.</span><input type="text" inputmode="decimal" autocomplete="off" name="weight" value="${item.weight}" placeholder="0"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Цена за 1 шт.</span><input type="text" inputmode="decimal" autocomplete="off" name="cost" value="${item.cost}" placeholder="0"></label>
        <label class="field"><span>Монета</span><select name="cur">
          ${COINS.map(([k, n]) => `<option value="${k}" ${item.cur === k ? 'selected' : ''}>${n}</option>`).join('')}
        </select></label>
      </div>
      <label class="field"><span>Заметка</span><input type="text" name="note" value="${esc(item.note || '')}" placeholder="1к8 рубящий, универсальное"></label>
      <button class="btn primary block" type="submit">Сохранить</button>
      ${isNew ? '' : '<button class="btn danger block" type="button" id="itemDel" style="margin-top:8px">Удалить предмет</button>'}
    </form>`);
  const num = (v) => {
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  $('#itemForm').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const c = char();
    const data = {
      ...item,
      name: String(fd.get('name')).trim(),
      qty: num(fd.get('qty')),
      weight: num(fd.get('weight')),
      cost: num(fd.get('cost')),
      cur: fd.get('cur'),
      note: String(fd.get('note') || '').trim(),
    };
    if (!data.name) return;
    if (isNew) {
      data.id = uid();
      c.items.push(data);
    } else {
      c.items[c.items.findIndex((x) => x.id === item.id)] = data;
    }
    closeSheet();
    commit();
  };
  if (!isNew) {
    $('#itemDel').onclick = () => {
      if (!confirm(`Удалить «${item.name}»?`)) return;
      const c = char();
      c.items = c.items.filter((x) => x.id !== item.id);
      closeSheet();
      commit();
    };
  }
}

function renderCharacter() {
  const c = char();
  view.innerHTML = `
    <div class="card">
      <h3>Персонаж</h3>
      <label class="field"><span>Имя</span><input type="text" data-bind="name" value="${esc(c.name)}"></label>
      <div class="grid2">
        <label class="field"><span>Класс</span><input type="text" data-bind="cls" value="${esc(c.cls)}" placeholder="Волшебник"></label>
        <label class="field"><span>Уровень</span><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" min="1" max="20" data-bind="level" value="${c.level}"></label>
      </div>
      <label class="field"><span>Редакция правил по умолчанию</span>
        <select data-bind="edition">
          <option value="2014" ${c.edition === '2014' ? 'selected' : ''}>D&D 5e 2014 (dnd.su)</option>
          <option value="2024" ${c.edition === '2024' ? 'selected' : ''}>D&D 5e 2024 (next.dnd.su)</option>
        </select></label>
    </div>

    <div class="card">
      <h3>Все персонажи <span class="spacer"></span><button class="btn link small" data-action="add-char">＋ Новый</button></h3>
      ${state.characters.map((x) => `
        <div class="char-item ${x.id === c.id ? 'active' : ''}">
          <div class="grow" data-action="select-char" data-id="${x.id}">
            <div class="cname">${esc(x.name)}</div>
            <div class="small muted">${esc([x.cls, x.level + ' ур.', x.spells.length + ' закл.'].filter(Boolean).join(' · '))}</div>
          </div>
          ${x.id === c.id ? '<span class="small muted">выбран</span>' : `<button class="btn small" data-action="select-char" data-id="${x.id}">Выбрать</button>`}
          <button class="btn small icon danger" data-action="del-char" data-id="${x.id}">×</button>
        </div>`).join('')}
    </div>

    <div class="card">
      <h3>Экспорт персонажа</h3>
      <div class="hint">«${esc(c.name)}»: лист персонажа для печати или PDF и файл для Long Story Short
        (там: «Мои персонажи» → «Загрузить .json»).</div>
      <div class="row wrap">
        <button class="btn" data-action="print-sheet">🖨 Лист / PDF</button>
        <button class="btn" data-action="lss-export">⬇ Для Long Story Short</button>
      </div>
    </div>

    ${syncCard()}

    <div class="card">
      <h3>Данные</h3>
      <div class="hint">Резервная копия всех персонажей в файл — на всякий случай. Копии на устройстве делаются сами
        перед каждым получением изменений с других устройств.</div>
      <div class="row wrap">
        <button class="btn" data-action="export">⬇ Экспорт</button>
        <button class="btn" data-action="history">Копии и версии</button>
        <label class="btn">⬆ Импорт<input type="file" accept="application/json,.json" id="importFile" hidden></label>
      </div>
    </div>

    <div class="card">
      <h3>Настройки</h3>
      <label class="field"><span>Тема</span>
        <select data-setting="theme">
          ${[['auto', 'Как в системе'], ['dark', 'Тёмная'], ['light', 'Светлая']].map(([v, t]) => `<option value="${v}" ${state.settings.theme === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></label>
      <label class="field"><span>Свой прокси для загрузки по ссылке (необязательно)</span>
        <input type="url" data-setting="customProxy" value="${esc(state.settings.customProxy)}" placeholder="https://my-proxy.workers.dev/?url={url}"></label>
      <div class="hint">Если загрузка по ссылке не работает — см. README про бесплатный прокси на Cloudflare Workers. Вставка текста работает всегда.</div>
    </div>`;
}

const SYNC_STATUS = {
  off: 'выключена',
  pending: 'есть несохранённые изменения…',
  syncing: 'синхронизация…',
  ok: 'всё сохранено в облаке',
  error: 'ошибка',
};

function syncCard() {
  const s = syncInfo();
  if (!s.code) {
    return `
    <div class="card">
      <h3>Синхронизация</h3>
      <div class="hint">Персонажи сохраняются в облаке и доступны на других устройствах по коду синхронизации.</div>
      <div class="row wrap">
        <button class="btn primary" data-action="sync-create">Включить</button>
        <button class="btn" data-action="sync-connect">У меня уже есть код</button>
      </div>
    </div>`;
  }
  const time = s.last ? new Date(s.last).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '—';
  return `
    <div class="card">
      <h3>Синхронизация</h3>
      <div class="hint">Код этого набора персонажей. Введите его на другом устройстве («У меня уже есть код»).</div>
      <div class="sync-code" data-action="sync-copy">${esc(s.code)}</div>
      <div class="small ${s.status === 'error' ? 'err' : 'muted'}">Состояние: ${SYNC_STATUS[s.status]}${s.error ? ` (${esc(s.error)})` : ''} · последняя: ${time}</div>
      <div class="row wrap" style="margin-top:10px">
        <button class="btn" data-action="sync-now">Синхронизировать</button>
        <button class="btn" data-action="sync-copy">Скопировать код</button>
        <button class="btn" data-action="history">История версий</button>
        <button class="btn danger" data-action="sync-off">Отключить</button>
      </div>
      <div class="hint">Код — это ключ к персонажам: давайте его только тем, кому доверяете.</div>
    </div>`;
}

function openConnect() {
  const c = state.characters;
  const hasData = c.length > 1 || c.some((x) => x.spells.length || x.items.length || x.notes || x.name !== 'Мой персонаж');
  openSheet(`
    <h2>Подключить по коду<button class="btn icon x" data-action="close">×</button></h2>
    <input type="text" id="syncCode" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx" autocomplete="off" autocapitalize="off" spellcheck="false">
    ${hasData ? `
      <div class="hint">На этом устройстве уже есть персонажи. Что с ними сделать?</div>
      <label class="check"><input type="radio" name="syncMode" value="replace" checked> Заменить данными из облака</label>
      <label class="check"><input type="radio" name="syncMode" value="merge"> Объединить: добавить местных персонажей в облако</label>` : ''}
    <div id="syncErr"></div>
    <button class="btn primary block" id="syncGo" style="margin-top:8px">Подключить</button>`, 'top');
  $('#syncCode').focus();
  $('#syncGo').onclick = async () => {
    const code = normalizeCode($('#syncCode').value);
    if (code.length < 19) return ($('#syncErr').innerHTML = '<div class="err">Введите код целиком</div>');
    const mode = sheet.querySelector('[name=syncMode]:checked')?.value || 'replace';
    const btn = $('#syncGo');
    btn.disabled = true;
    btn.textContent = 'Подключение…';
    try {
      await connect(code, mode);
      closeSheet();
      toast('Синхронизация подключена');
      ui.tab = 'character';
      render();
    } catch (e) {
      $('#syncErr').innerHTML = `<div class="err">${esc(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Подключить';
    }
  };
}

function summarize(chars) {
  return chars.map((c) => `${c.name || '—'}: ${(c.items || []).length} вещ., ${(c.spells || []).length} закл.`).join('; ');
}

function fmtTime(t) {
  return new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function openHistory() {
  const backups = listBackups();
  openSheet(`
    <h2>Копии и версии<button class="btn icon x" data-action="close">×</button></h2>
    <div class="hint">«Восстановить» возвращает всех персонажей к выбранному состоянию${syncInfo().code ? ' на всех устройствах' : ''}.
      Текущее состояние перед этим тоже сохранится в копиях.</div>
    ${syncInfo().code ? '<h3 class="hist-h">В облаке</h3><div id="cloudVersions" class="muted small">Загрузка…</div>' : ''}
    <h3 class="hist-h">На этом устройстве</h3>
    ${backups.length ? backups.map((b, i) => `
      <div class="hist">
        <div class="grow"><b>${fmtTime(b.time)}</b> <span class="muted small">${esc(b.reason || '')}</span>
          <div class="small muted">${esc(summarize(b.characters))}</div></div>
        <button class="btn small" data-restore-local="${i}">Восстановить</button>
      </div>`).join('') : '<div class="muted small">Пока нет.</div>'}`);

  sheet.querySelectorAll('[data-restore-local]').forEach((b) => (b.onclick = () => doRestore(backups[b.dataset.restoreLocal].characters)));

  if (!syncInfo().code) return;
  try {
    const versions = await listVersions();
    const box = $('#cloudVersions');
    if (!box) return;
    box.classList.remove('muted', 'small');
    box.innerHTML = versions.length ? versions.map((v, i) => `
      <div class="hist">
        <div class="grow"><b>${fmtTime(v.created)}</b> ${i === 0 ? '<span class="muted small">текущая</span>' : ''}
          <div class="small muted">${esc(v.chars.map((c) => `${c.name}: ${c.items} вещ., ${c.spells} закл.`).join('; '))}</div></div>
        ${i === 0 ? '' : `<button class="btn small" data-restore-rev="${v.rev}">Восстановить</button>`}
      </div>`).join('') : '<div class="muted small">История начнёт вестись со следующего изменения.</div>';
    box.querySelectorAll('[data-restore-rev]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const v = await getVersion(Number(b.dataset.restoreRev));
        await doRestore(v.characters);
      } catch (e) {
        toast(e.message);
        b.disabled = false;
      }
    }));
  } catch (e) {
    const box = $('#cloudVersions');
    if (box) box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

async function doRestore(characters) {
  if (!confirm(`Восстановить это состояние?\n${summarize(characters)}`)) return;
  closeSheet();
  await restoreCharacters(characters);
  toast('Восстановлено');
  render();
}

function openPrintOptions() {
  const o = { spellText: true, inventory: true, notes: true, ...state.settings.print };
  const chk = (k, label) => `<label class="check"><input type="checkbox" name="${k}" ${o[k] ? 'checked' : ''}> ${label}</label>`;
  openSheet(`
    <h2>Лист персонажа<button class="btn icon x" data-action="close">×</button></h2>
    <form id="printForm">
      ${chk('spellText', 'Полные описания заклинаний')}
      ${chk('inventory', 'Снаряжение и монеты')}
      ${chk('notes', 'Заметки')}
      <div class="hint">Откроется окно печати. Чтобы получить файл, выберите принтер «Сохранить как PDF».</div>
      <button class="btn primary block" type="submit">🖨 Печать / PDF</button>
    </form>`);
  $('#printForm').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const opts = { spellText: fd.has('spellText'), inventory: fd.has('inventory'), notes: fd.has('notes') };
    state.settings.print = opts; // запомнить выбор на этом устройстве
    save(state);
    closeSheet();
    printSheet(char(), opts);
  };
}

function syncIndicator(s) {
  const el = $('#syncDot');
  if (!el) return;
  el.className = 'sync-dot ' + s;
  el.title = 'Синхронизация: ' + SYNC_STATUS[s];
}

/* ---------------- нижний лист ---------------- */

function openSheet(html, pos = 'bottom') {
  sheet.innerHTML = html;
  sheetEl.classList.toggle('top', pos === 'top');
  sheetEl.hidden = false;
}
function closeSheet() {
  sheetEl.hidden = true;
  sheet.innerHTML = '';
}
sheetEl.addEventListener('click', (e) => {
  if (e.target === sheetEl) closeSheet();
});

function askNumber(title, value, onOk, min = 0) {
  openSheet(`
    <h2>${esc(title)}<button class="btn icon x" data-action="close">×</button></h2>
    <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" id="numVal" class="num-big" value="${value}">
    <div class="num-steps">
      ${[-5, -1, 1, 5].map((d) => `<button class="btn" data-step="${d}">${d > 0 ? '+' + d : '−' + -d}</button>`).join('')}
    </div>
    <button class="btn primary block" id="numOk">Сохранить</button>`, 'top');
  const inp = $('#numVal');
  inp.focus();
  inp.select();
  const ok = () => {
    const v = parseInt(inp.value.replace(/[^\d-]/g, ''), 10);
    if (Number.isNaN(v)) return toast('Введите число');
    closeSheet();
    onOk(v);
  };
  sheet.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => {
    inp.value = Math.max(min, (parseInt(inp.value, 10) || 0) + Number(b.dataset.step));
  }));
  $('#numOk').onclick = ok;
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') ok();
  };
}

/* --- добавление заклинания --- */

function openAddSpell({ mode = 'link', url = '', text = '', autoFetch = false } = {}) {
  openSheet(`
    <h2>Добавить заклинание<button class="btn icon x" data-action="close">×</button></h2>
    <div class="seg">
      <button data-mode="link" class="${mode === 'link' ? 'active' : ''}">По ссылке</button>
      <button data-mode="text" class="${mode === 'text' ? 'active' : ''}">Текст</button>
      <button data-mode="manual">Вручную</button>
    </div>
    <div id="addBody"></div>`);
  sheet.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => {
    if (b.dataset.mode === 'manual') return openSpellForm({ ...emptySpell(), edition: char().edition });
    sheet.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('active', x === b));
    renderAddBody(b.dataset.mode);
  }));

  function renderAddBody(m) {
    const body = $('#addBody');
    if (m === 'link') {
      body.innerHTML = `
        <input type="url" id="spellUrl" placeholder="https://dnd.su/spells/205-fireball/" value="${esc(url)}">
        <div class="hint">Ссылка со страницы заклинания на dnd.su или next.dnd.su.</div>
        <div id="addErr"></div>
        <button class="btn primary block" id="fetchBtn">Загрузить</button>`;
      const go = async () => {
        const btn = $('#fetchBtn');
        const err = $('#addErr');
        err.innerHTML = '';
        btn.disabled = true;
        btn.textContent = 'Загрузка…';
        try {
          const spell = await fetchSpell($('#spellUrl').value, state.settings.customProxy);
          openSpellForm(spell, true);
        } catch (e) {
          err.innerHTML = `<div class="err">${esc(e.message)}</div>
            ${e.details ? `<div class="hint">${esc(e.details)}</div>` : ''}
            <div class="hint">Можно скопировать текст со страницы и вставить его вручную.</div>
            <button class="btn block" id="toTextBtn" style="margin-bottom:8px">Вставить текст вместо ссылки</button>`;
          $('#toTextBtn').onclick = () => openAddSpell({ mode: 'text', url: $('#spellUrl').value.trim() });
          btn.disabled = false;
          btn.textContent = 'Загрузить';
        }
      };
      $('#fetchBtn').onclick = go;
      if (autoFetch && url) go();
    } else {
      body.innerHTML = `
        <div class="hint">Откройте заклинание на dnd.su, выделите текст от названия до конца описания, скопируйте и вставьте сюда.</div>
        <textarea id="spellText" placeholder="Огненный шар [Fireball]&#10;3 уровень, воплощение&#10;Время накладывания: 1 действие&#10;…">${esc(text)}</textarea>
        <input type="url" id="spellUrl2" placeholder="Ссылка на страницу (необязательно)" value="${esc(url)}" style="margin-top:8px">
        <div id="addErr"></div>
        <button class="btn primary block" id="parseBtn" style="margin-top:10px">Разобрать</button>`;
      $('#parseBtn').onclick = () => {
        const raw = $('#spellText').value;
        const u = $('#spellUrl2').value.trim() || findSpellUrl(raw);
        if (!raw.trim()) return;
        const spell = parseText(raw, u);
        if (!editionFromUrl(u) && !/время\s+(накладывания|сотворения)/i.test(raw)) spell.edition = char().edition;
        openSpellForm(spell, true);
      };
    }
  }
  renderAddBody(mode);
}

function openSpellForm(spell, isNew = !spell.id) {
  const f = (k, label, ph = '') => `<label class="field"><span>${label}</span><input type="text" name="${k}" value="${esc(spell[k])}" placeholder="${ph}"></label>`;
  const freeMode = spell.freeUnlimited ? 'unlimited' : spell.freeMax ? 'limited' : 'none';
  openSheet(`
    <h2>${isNew ? 'Проверьте и сохраните' : 'Изменить заклинание'}<button class="btn icon x" data-action="close">×</button></h2>
    <form id="spellForm">
      ${f('name', 'Название')}
      ${f('nameEn', 'Английское название')}
      <div class="grid2">
        <label class="field"><span>Уровень</span><select name="level">
          ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => `<option value="${l}" ${spell.level === l ? 'selected' : ''}>${l === 0 ? 'Заговор' : l}</option>`).join('')}
        </select></label>
        ${f('school', 'Школа')}
      </div>
      <div class="grid2">${f('castTime', 'Время')}${f('range', 'Дистанция')}</div>
      ${f('components', 'Компоненты')}
      ${f('duration', 'Длительность')}
      <div class="row">
        <label class="check"><input type="checkbox" name="concentration" ${spell.concentration ? 'checked' : ''}> Концентрация</label>
        <span style="width:16px"></span>
        <label class="check"><input type="checkbox" name="ritual" ${spell.ritual ? 'checked' : ''}> Ритуал</label>
      </div>
      ${f('classes', 'Классы')}
      ${f('source', 'Источник')}
      <label class="field"><span>Сотворение без ячейки</span><select name="freeMode" id="freeMode">
        <option value="none" ${freeMode === 'none' ? 'selected' : ''}>Нет</option>
        <option value="limited" ${freeMode === 'limited' ? 'selected' : ''}>Ограниченное число раз</option>
        <option value="unlimited" ${freeMode === 'unlimited' ? 'selected' : ''}>Неограниченно (по желанию)</option>
      </select></label>
      <div class="grid2" id="freeLimited" ${freeMode === 'limited' ? '' : 'hidden'}>
        <label class="field"><span>Сколько раз</span>
          <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" name="freeMax" min="1" max="20" value="${spell.freeMax || 1}"></label>
        <label class="field"><span>Восстанавливается</span><select name="freeReset">
          ${['long', 'short', 'none'].map((r) => `<option value="${r}" ${(spell.freeReset || 'long') === r ? 'selected' : ''}>${RESET_NAME[r]}</option>`).join('')}
        </select></label>
      </div>
      <label class="field"><span>Описание</span><textarea name="text">${esc(spell.text)}</textarea></label>
      <label class="field"><span>На больших уровнях</span><textarea name="higher" style="min-height:80px">${esc(spell.higher)}</textarea></label>
      <div class="grid2">
        <label class="field"><span>Редакция</span><select name="edition">
          <option value="2014" ${spell.edition !== '2024' ? 'selected' : ''}>2014</option>
          <option value="2024" ${spell.edition === '2024' ? 'selected' : ''}>2024</option>
        </select></label>
        ${f('url', 'Ссылка')}
      </div>
      <button class="btn primary block" type="submit">Сохранить</button>
    </form>`);
  sheet.scrollTop = 0;
  $('#freeMode').onchange = (e) => ($('#freeLimited').hidden = e.target.value !== 'limited');
  $('#spellForm').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = { ...spell };
    for (const k of ['name', 'nameEn', 'school', 'castTime', 'range', 'components', 'duration', 'classes', 'source', 'text', 'higher', 'edition', 'url']) {
      data[k] = String(fd.get(k) || '').trim();
    }
    data.level = Number(fd.get('level'));
    data.concentration = fd.get('concentration') === 'on';
    data.ritual = fd.get('ritual') === 'on';
    const mode = fd.get('freeMode');
    data.freeUnlimited = mode === 'unlimited';
    data.freeMax = mode === 'limited' ? clamp(parseInt(fd.get('freeMax'), 10) || 1, 1, 20) : 0;
    data.freeReset = fd.get('freeReset') || 'long';
    data.freeUsed = Math.min(spell.freeUsed || 0, data.freeMax);
    if (!data.name) return toast('Укажите название');
    const c = char();
    if (isNew) {
      const dup = c.spells.find((s) => s.name.toLowerCase() === data.name.toLowerCase() && s.edition === data.edition);
      if (dup && !confirm(`«${data.name}» уже есть у персонажа. Добавить ещё раз?`)) return;
      data.id = uid();
      data.prepared = false;
      c.spells.push(data);
      ui.open.add(data.id);
      toast(`«${data.name}» добавлено`);
    } else {
      const i = c.spells.findIndex((s) => s.id === spell.id);
      c.spells[i] = data;
    }
    closeSheet();
    ui.tab = 'spells';
    commit();
  };
}

/* --- сотворение: трата ячейки --- */

function openCast(spell) {
  const c = char();
  const opts = [];
  for (let l = spell.level; l <= 9; l++) {
    const s = c.slots[l];
    if (s.max) opts.push({ kind: 'slot', l, left: s.max - s.used });
  }
  if (c.pact.max && c.pact.level >= spell.level) opts.push({ kind: 'pact', l: c.pact.level, left: c.pact.max - c.pact.used });
  openSheet(`
    <h2>${esc(spell.name)}<button class="btn icon x" data-action="close">×</button></h2>
    <div class="hint">Потратить ячейку:</div>
    ${opts.length ? opts.map((o, i) => `
      <button class="btn block" style="margin-bottom:8px" data-cast="${i}" ${o.left <= 0 ? 'disabled' : ''}>
        ${o.kind === 'pact' ? 'Ячейка колдуна' : 'Ячейка'} ${o.l} ур. <span class="muted">(осталось ${o.left})</span>
      </button>`).join('') : `<div class="muted">Подходящих ячеек нет — их можно настроить во вкладке «Трекер».</div>`}
    <div class="hint" style="margin-top:14px">Без траты ячейки:</div>
    ${spell.freeUnlimited ? `<button class="btn block primary" style="margin-bottom:8px" data-cast="nocost">◇ Бесплатно <span class="muted">(неограниченно)</span></button>` : ''}
    ${spell.freeMax ? `<button class="btn block" style="margin-bottom:8px" data-cast="free" ${spell.freeMax - (spell.freeUsed || 0) <= 0 ? 'disabled' : ''}>
        ◇ Бесплатно <span class="muted">(осталось ${spell.freeMax - (spell.freeUsed || 0)} из ${spell.freeMax}, ${RESET_NAME[spell.freeReset] || ''})</span></button>` : ''}
    ${spell.ritual ? `<button class="btn block" style="margin-bottom:8px" data-cast="ritual">Как ритуал (+10 минут)</button>` : ''}
    ${spell.freeUnlimited ? '' : '<button class="btn block" data-cast="nocost">Просто сотворить, ничего не тратя</button>'}
    ${spell.freeUsed ? `<button class="btn link small block" style="margin-top:8px" data-cast="free-reset">Восстановить бесплатные использования</button>` : ''}`);
  sheet.querySelectorAll('[data-cast]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.cast;
    closeSheet();
    if (k === 'ritual') return toast(`${spell.name}: ритуал (+10 минут)`);
    if (k === 'nocost') return toast(`${spell.name}: сотворено без ячейки`);
    if (k === 'free-reset') {
      spell.freeUsed = 0;
      toast(`${spell.name}: бесплатные использования восстановлены`);
      return commit();
    }
    if (k === 'free') {
      spell.freeUsed = (spell.freeUsed || 0) + 1;
      toast(`${spell.name}: бесплатно, осталось ${spell.freeMax - spell.freeUsed}`);
      return commit();
    }
    const o = opts[Number(k)];
    if (o.kind === 'pact') c.pact.used++;
    else c.slots[o.l].used++;
    toast(`${spell.name}: потрачена ячейка ${o.l} ур.`);
    commit();
  }));
}

/* --- ресурсы --- */

function openResForm(res) {
  const isNew = !res;
  res = res || { name: '', max: 1, cur: 1, reset: 'long' };
  openSheet(`
    <h2>${isNew ? 'Новый ресурс' : 'Ресурс'}<button class="btn icon x" data-action="close">×</button></h2>
    <form id="resForm">
      <label class="field"><span>Название</span><input type="text" name="name" value="${esc(res.name)}" placeholder="Кости хитов, Ярость, Канал божественности…" required></label>
      <label class="field"><span>Максимум</span><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" name="max" min="1" value="${res.max}"></label>
      <label class="field"><span>Восстанавливается</span><select name="reset">
        <option value="short" ${res.reset === 'short' ? 'selected' : ''}>Короткий отдых (и длинный)</option>
        <option value="long" ${res.reset === 'long' ? 'selected' : ''}>Длинный отдых</option>
        <option value="none" ${res.reset === 'none' ? 'selected' : ''}>Вручную</option>
      </select></label>
      <button class="btn primary block" type="submit">Сохранить</button>
      ${isNew ? '' : `<button class="btn danger block" type="button" id="resDel" style="margin-top:8px">Удалить ресурс</button>`}
    </form>`);
  $('#resForm').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const c = char();
    const max = Math.max(1, parseInt(fd.get('max'), 10) || 1);
    const data = { ...res, name: String(fd.get('name')).trim(), max, reset: fd.get('reset') };
    if (isNew) {
      data.id = uid();
      data.cur = max;
      c.resources.push(data);
    } else {
      data.cur = Math.min(data.cur, max);
      c.resources[c.resources.findIndex((r) => r.id === res.id)] = data;
    }
    closeSheet();
    commit();
  };
  if (!isNew) {
    $('#resDel').onclick = () => {
      if (!confirm(`Удалить «${res.name}»?`)) return;
      const c = char();
      c.resources = c.resources.filter((r) => r.id !== res.id);
      closeSheet();
      commit();
    };
  }
}

/* --- таблицы ячеек --- */

const FULL = [
  [], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

function autoSlots(kind) {
  const c = char();
  const L = clamp(Number(c.level) || 1, 1, 20);
  if (kind === 'pact') {
    c.pact.max = L === 1 ? 1 : L <= 10 ? 2 : L <= 16 ? 3 : 4;
    c.pact.level = Math.min(5, Math.ceil(L / 2));
    c.pact.used = 0;
    return;
  }
  let row;
  if (kind === 'full') row = FULL[L];
  else row = L === 1 && c.edition !== '2024' ? [] : FULL[Math.ceil(L / 2)];
  for (let l = 1; l <= 9; l++) c.slots[l] = { max: row[l - 1] || 0, used: 0 };
}

/* ---------------- обработка событий ---------------- */

function hpInput() {
  const v = parseInt($('#hpVal')?.value, 10);
  return Number.isNaN(v) || v < 0 ? null : v;
}

const actions = {
  tab: (d) => { ui.tab = d.tab; render(); window.scrollTo(0, 0); },
  close: () => closeSheet(),

  filter: (d) => { ui.filter = d.f; renderSpells(); },
  'toggle-level': (d) => {
    const l = Number(d.l);
    const all = (state.settings.collapsed ||= {});
    const cur = collapsedLevels();
    all[state.activeId] = cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l];
    save(state); // только настройка устройства — синхронизировать нечего
    renderSpellList();
  },
  'add-spell': () => openAddSpell(),
  'toggle-spell': (d) => { ui.open.has(d.id) ? ui.open.delete(d.id) : ui.open.add(d.id); renderSpellList(); },
  prep: (d) => { const s = char().spells.find((x) => x.id === d.id); s.prepared = !s.prepared; persist(); renderSpellList(); },
  'edit-spell': (d) => openSpellForm(char().spells.find((x) => x.id === d.id), false),
  'del-spell': (d) => {
    const c = char();
    const s = c.spells.find((x) => x.id === d.id);
    if (!confirm(`Удалить «${s.name}»?`)) return;
    c.spells = c.spells.filter((x) => x.id !== d.id);
    commit();
  },
  cast: (d) => openCast(char().spells.find((x) => x.id === d.id)),
  'refresh-spell': async (d) => {
    const c = char();
    const old = c.spells.find((x) => x.id === d.id);
    toast('Загрузка с dnd.su…');
    try {
      const fresh = await fetchSpell(old.url, state.settings.customProxy);
      // текст и параметры — с сайта; отметки и настройки бесплатных сотворений — свои
      const keep = ['id', 'prepared', 'freeMax', 'freeUsed', 'freeReset', 'freeUnlimited'];
      const merged = { ...old, ...fresh };
      for (const k of keep) if (k in old) merged[k] = old[k];
      c.spells[c.spells.findIndex((x) => x.id === d.id)] = merged;
      toast(`«${merged.name}» обновлено`);
      commit();
    } catch (e) {
      toast(e.message);
    }
  },

  dmg: () => {
    const v = hpInput();
    if (v === null) return toast('Введите число');
    const hp = char().hp;
    const fromTemp = Math.min(hp.temp, v);
    hp.temp -= fromTemp;
    hp.cur = Math.max(0, hp.cur - (v - fromTemp));
    commit();
  },
  heal: () => {
    const v = hpInput();
    if (v === null) return toast('Введите число');
    const c = char();
    if (c.hp.cur === 0 && v > 0) c.deathSaves = { ok: 0, fail: 0 };
    c.hp.cur = Math.min(c.hp.max, c.hp.cur + v);
    commit();
  },
  temp: () => {
    const v = hpInput();
    if (v === null) return askNumber('Временные хиты', char().hp.temp, (n) => { char().hp.temp = Math.max(0, n); commit(); });
    char().hp.temp = v;
    commit();
  },
  'temp-clear': () => { char().hp.temp = 0; commit(); },
  'hp-max': () => askNumber('Максимум хитов', char().hp.max, (n) => {
    const hp = char().hp;
    hp.max = Math.max(1, n);
    hp.cur = Math.min(hp.cur, hp.max);
    commit();
  }),
  'hp-set': () => askNumber('Текущие хиты', char().hp.cur, (n) => { const hp = char().hp; hp.cur = clamp(n, 0, hp.max); commit(); }),
  death: (d) => {
    const ds = char().deathSaves;
    const i = Number(d.i);
    ds[d.k] = ds[d.k] > i ? i : i + 1;
    commit();
  },

  slot: (d) => { const s = char().slots[d.l]; s.used = clamp(s.used + (d.full === '1' ? 1 : -1), 0, s.max); commit(); },
  pact: (d) => { const p = char().pact; p.used = clamp(p.used + (d.full === '1' ? 1 : -1), 0, p.max); commit(); },
  'toggle-edit-slots': () => { ui.editSlots = !ui.editSlots; render(); },
  'slot-max': (d) => { const s = char().slots[d.l]; s.max = clamp(s.max + Number(d.d), 0, 9); s.used = Math.min(s.used, s.max); commit(); },
  'pact-max': (d) => { const p = char().pact; p.max = clamp(p.max + Number(d.d), 0, 9); p.used = Math.min(p.used, p.max); commit(); },
  'pact-level': (d) => { const p = char().pact; p.level = clamp(p.level + Number(d.d), 1, 9); commit(); },
  'auto-slots': (d) => { autoSlots(d.kind); commit(); },

 ac: () => askNumber('Класс доспеха', char().ac, (n) => { char().ac = clamp(n, 0, 40); commit(); }),
  init: () => {
    const c = char();
    const dex = mod(c.abilities.dex);
    askNumber(`Инициатива (ЛОВ ${fmtMod(dex)} + доп. бонус)`, initiative(c), (n) => { c.initBonus = clamp(n, -10, 30) - dex; commit(); }, -10);
  },
  speed: () => askNumber('Скорость, фт.', char().speed, (n) => { char().speed = clamp(n, 0, 300); commit(); }),
  inspiration: () => { const c = char(); c.inspiration = !c.inspiration; commit(); },
  'toggle-edit-hd': () => { ui.editHD = !ui.editHD; render(); },
  hd: (d) => { const h = char().hitDice[d.i]; h.used = clamp(h.used + (d.full === '1' ? 1 : -1), 0, h.max); commit(); },
  'hd-spend': (d) => {
    const c = char();
    const h = c.hitDice[d.i];
    if (h.used >= h.max) return;
    const m = mod(c.abilities.con);
    askNumber(`Сколько выпало на к${h.die}?`, '', (roll) => {
      const healed = Math.max(0, roll + m);
      h.used++;
      c.hp.cur = Math.min(c.hp.max, c.hp.cur + healed);
      toast(`к${h.die}: ${roll} ${m >= 0 ? '+' : '−'} ${Math.abs(m)} = ${healed} хитов`);
      commit();
    });
  },
  'hd-max': (d) => { const h = char().hitDice[d.i]; h.max = clamp(h.max + Number(d.d), 0, 20); h.used = Math.min(h.used, h.max); commit(); },
  'hd-add': () => { char().hitDice.push({ die: 8, max: 1, used: 0 }); commit(); },
  'hd-del': (d) => { char().hitDice.splice(Number(d.i), 1); commit(); },
  'hd-level': () => {
    const c = char();
    c.hitDice = [{ die: c.hitDice[0]?.die || 8, max: clamp(Number(c.level) || 1, 1, 20), used: 0 }];
    commit();
  },

  abil: (d) => {
    const c = char();
    const name = ABILITIES.find(([k]) => k === d.a)[2];
    askNumber(name, c.abilities[d.a], (n) => { c.abilities[d.a] = clamp(n, 1, 30); commit(); });
  },
  'save-toggle': (d) => { const c = char(); c.saves[d.a] = !c.saves[d.a]; commit(); },
  skill: (d) => { const c = char(); c.skills[d.k] = ((c.skills[d.k] || 0) + 1) % 3; commit(); },

  'add-item': () => openItemForm(),
  'edit-item': (d) => openItemForm(char().items.find((x) => x.id === d.id)),
  'item-qty': (d) => {
    const it = char().items.find((x) => x.id === d.id);
    it.qty = Math.max(0, (Number(it.qty) || 0) + Number(d.d));
    commit();
  },

  'add-res': () => openResForm(),
  'edit-res': (d) => openResForm(char().resources.find((r) => r.id === d.id)),
  'toggle-edit-res': () => { ui.editRes = !ui.editRes; render(); },
  res: (d) => { const r = char().resources.find((x) => x.id === d.id); r.cur = clamp(r.cur + Number(d.d), 0, r.max); commit(); },
  'res-dot': (d) => { const r = char().resources.find((x) => x.id === d.id); r.cur = clamp(r.cur + (d.full === '1' ? -1 : 1), 0, r.max); commit(); },
  'res-set': (d) => {
    const r = char().resources.find((x) => x.id === d.id);
    askNumber(r.name, r.cur, (n) => { r.cur = clamp(n, 0, r.max); commit(); });
  },

  rest: (d) => {
    const c = char();
    if (d.kind === 'long') {
      if (!confirm('Длинный отдых: восстановить хиты, кости хитов, ячейки и ресурсы?')) return;
      c.hp.cur = c.hp.max;
      c.hp.temp = 0;
      c.deathSaves = { ok: 0, fail: 0 };
      for (const l in c.slots) c.slots[l].used = 0;
      c.pact.used = 0;
      c.resources.forEach((r) => { if (r.reset !== 'none') r.cur = r.max; });
      c.spells.forEach((s) => { if (s.freeReset !== 'none') s.freeUsed = 0; });
      const hd = restoreHitDice(c);
      toast(`Длинный отдых завершён${hd ? `, костей хитов восстановлено: ${hd}` : ''}`);
    } else {
      c.pact.used = 0;
      c.resources.forEach((r) => { if (r.reset === 'short') r.cur = r.max; });
      c.spells.forEach((s) => { if (s.freeReset === 'short') s.freeUsed = 0; });
      toast('Короткий отдых: восстановлены ячейки колдуна и ресурсы короткого отдыха');
    }
    commit();
  },

  'add-char': () => {
    const c = newCharacter();
    state.characters.push(c);
    state.activeId = c.id;
    commit();
    toast('Создан новый персонаж');
  },
  'select-char': (d) => { state.activeId = d.id; ui.open.clear(); ui.filter = 'all'; commit(); },
  'del-char': (d) => {
    const x = state.characters.find((c) => c.id === d.id);
    if (state.characters.length === 1) return toast('Нельзя удалить единственного персонажа');
    if (!confirm(`Удалить персонажа «${x.name}» со всеми заклинаниями?`)) return;
    state.characters = state.characters.filter((c) => c.id !== d.id);
    if (state.activeId === d.id) state.activeId = state.characters[0].id;
    commit();
  },
  export: () => exportJson(state),
  'lss-export': () => {
    downloadLss(char());
    toast('Файл для Long Story Short сохранён');
  },
  'print-sheet': () => openPrintOptions(),
  'sync-create': async () => {
    try {
      await createSync();
      toast('Синхронизация включена');
    } catch (e) {
      toast('Не удалось включить синхронизацию: ' + e.message);
    }
    render();
  },
  'sync-connect': () => openConnect(),
  history: () => openHistory(),
  'sync-now': async () => { await syncNow(); render(); },
  'sync-copy': async () => {
    try {
      await navigator.clipboard.writeText(syncInfo().code);
      toast('Код скопирован');
    } catch {
      toast('Выделите код и скопируйте вручную');
    }
  },
  'sync-off': () => {
    if (!confirm('Отключить синхронизацию на этом устройстве? Персонажи останутся здесь и в облаке.')) return;
    disconnect();
    render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.dataset.action === 'toggle-spell' && e.target.closest('.prep')) return;
  e.preventDefault();
  fn(el.dataset);
});

const textTimers = {};
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'spellSearch') {
    ui.search = t.value;
    renderSpellList();
  } else if (t.dataset.text) {
    const key = t.dataset.text;
    char()[key] = t.value;
    autoGrow(t);
    clearTimeout(textTimers[key]);
    textTimers[key] = setTimeout(() => {
      persist();
      const m = $(`#${key}Saved`);
      if (m) m.textContent = 'сохранено';
    }, 400);
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.bind) {
    const c = char();
    c[t.dataset.bind] = t.dataset.bind === 'level' ? clamp(parseInt(t.value, 10) || 1, 1, 20) : t.value;
    commit();
  } else if (t.dataset.sheet) {
    char()[t.dataset.sheet] = t.type === 'checkbox' ? t.checked : t.value;
    commit();
  } else if (t.dataset.coin) {
    char().coins[t.dataset.coin] = Math.max(0, parseInt(t.value, 10) || 0);
    commit();
  } else if (t.dataset.hdDie) {
    char().hitDice[t.dataset.hdDie].die = Number(t.value);
    commit();
  } else if (t.dataset.setting) {
    state.settings[t.dataset.setting] = t.value.trim();
    persist();
    applyTheme();
  } else if (t.id === 'importFile' && t.files[0]) {
    try {
      const data = await importJson(t.files[0]);
      if (!confirm('Заменить все текущие данные данными из файла?')) return;
      state = data;
      persist();
      applyTheme();
      render();
      toast('Данные импортированы');
    } catch (err) {
      alert('Ошибка импорта: ' + err.message);
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheetEl.hidden) closeSheet();
});

/* ---------------- старт ---------------- */

function handleShare() {
  const p = new URLSearchParams(location.search);
  if (!p.has('share')) return;
  history.replaceState(null, '', location.pathname);
  const all = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join('\n');
  const url = findSpellUrl(all);
  const text = [p.get('title'), p.get('text')].filter(Boolean).join('\n');
  // Если поделились только ссылкой — грузим по ссылке, если текстом — разбираем текст.
  const onlyLink = text.replace(url, '').trim().length < 40;
  if (url && onlyLink) openAddSpell({ mode: 'link', url, autoFetch: true });
  else openAddSpell({ mode: 'text', text, url });
}

$('#appVer').textContent = APP_VERSION;
applyTheme();
render();
requestPersistence();
handleShare();
if (!listBackups()[0] || Date.now() - listBackups()[0].time > 12 * 3600e3) backupLocal(state.characters, 'автоматически');
initSync({
  getState: () => state,
  apply: (characters, changed) => {
    state.characters = characters.length ? characters.map(normalizeCharacter) : [newCharacter('Мой персонаж')];
    if (!state.characters.some((c) => c.id === state.activeId)) state.activeId = state.characters[0].id;
    save(state);
    // не перерисовываем, пока человек что-то печатает
    const a = document.activeElement;
    if (changed && !(a && view.contains(a) && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable))) render();
  },
  onStatus: (s) => {
    syncIndicator(s);
    if (ui.tab === 'character' && sheetEl.hidden) {
      const a = document.activeElement;
      if (!(a && view.contains(a) && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable))) renderCharacter();
    }
  },
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
