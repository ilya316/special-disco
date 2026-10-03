import { load, save, uid, newCharacter, exportJson, importJson, requestPersistence } from './store.js';
import { parseText, emptySpell, findSpellUrl, editionFromUrl } from './parser.js';
import { fetchSpell } from './import.js';

const APP_VERSION = 'v9'; // меняйте вместе с VERSION в sw.js

let state = load();
const ui = { tab: 'spells', search: '', filter: 'all', open: new Set(), editSlots: false, editRes: false };

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sheetEl = $('#sheet');
const sheet = $('.sheet', sheetEl);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const char = () => state.characters.find((c) => c.id === state.activeId);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const RESET_NAME = { long: 'длинный отдых', short: 'короткий отдых', none: 'вручную' };
const levelName = (l) => (l === 0 ? 'Заговоры' : `${l} уровень`);

function commit() {
  save(state);
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
  else if (ui.tab === 'inventory') renderInventory();
  else renderCharacter();
}

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
  for (const s of items) {
    if (s.level !== cur) {
      cur = s.level;
      html += `<div class="level-head">${levelName(cur)}<span class="slots-mini">${slotsInfo(c, cur)}</span></div>`;
    }
    html += spellCard(s);
  }
  list.innerHTML = html;
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
    </div>`).join('') : `<div class="muted small">Здесь можно отслеживать кости хитов, ярость, канал божественности, вдохновение и т.д.</div>`;

  view.innerHTML = `
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

function renderInventory() {
  view.innerHTML = `
    <div class="card inv">
      <h3>Инвентарь <span class="spacer"></span><span class="small muted" id="invSaved"></span></h3>
      <textarea id="invText" placeholder="Длинный меч&#10;Кожаный доспех&#10;Зелье лечения ×2&#10;Верёвка 50 фт&#10;Золото: 35 зм">${esc(char().inventory)}</textarea>
      <div class="hint">Пишите как удобно — сохраняется автоматически.</div>
    </div>`;
  autoGrow($('#invText'));
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(t.scrollHeight + 2, 300) + 'px';
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
      <h3>Данные</h3>
      <div class="hint">Всё хранится только в этом браузере на телефоне. Время от времени сохраняйте резервную копию.</div>
      <div class="row wrap">
        <button class="btn" data-action="export">⬇ Экспорт</button>
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

function askNumber(title, value, onOk) {
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
    inp.value = Math.max(0, (parseInt(inp.value, 10) || 0) + Number(b.dataset.step));
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
  'add-spell': () => openAddSpell(),
  'toggle-spell': (d) => { ui.open.has(d.id) ? ui.open.delete(d.id) : ui.open.add(d.id); renderSpellList(); },
  prep: (d) => { const s = char().spells.find((x) => x.id === d.id); s.prepared = !s.prepared; save(state); renderSpellList(); },
  'edit-spell': (d) => openSpellForm(char().spells.find((x) => x.id === d.id), false),
  'del-spell': (d) => {
    const c = char();
    const s = c.spells.find((x) => x.id === d.id);
    if (!confirm(`Удалить «${s.name}»?`)) return;
    c.spells = c.spells.filter((x) => x.id !== d.id);
    commit();
  },
  cast: (d) => openCast(char().spells.find((x) => x.id === d.id)),

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
      if (!confirm('Длинный отдых: восстановить хиты, все ячейки и ресурсы?')) return;
      c.hp.cur = c.hp.max;
      c.hp.temp = 0;
      c.deathSaves = { ok: 0, fail: 0 };
      for (const l in c.slots) c.slots[l].used = 0;
      c.pact.used = 0;
      c.resources.forEach((r) => { if (r.reset !== 'none') r.cur = r.max; });
      c.spells.forEach((s) => { if (s.freeReset !== 'none') s.freeUsed = 0; });
      toast('Длинный отдых завершён');
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

let invTimer;
document.addEventListener('input', (e) => {
  if (e.target.id === 'spellSearch') {
    ui.search = e.target.value;
    renderSpellList();
  } else if (e.target.id === 'invText') {
    char().inventory = e.target.value;
    autoGrow(e.target);
    clearTimeout(invTimer);
    invTimer = setTimeout(() => {
      save(state);
      const m = $('#invSaved');
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
  } else if (t.dataset.setting) {
    state.settings[t.dataset.setting] = t.value.trim();
    save(state);
    applyTheme();
  } else if (t.id === 'importFile' && t.files[0]) {
    try {
      const data = await importJson(t.files[0]);
      if (!confirm('Заменить все текущие данные данными из файла?')) return;
      state = data;
      save(state);
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

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
