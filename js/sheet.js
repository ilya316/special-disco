// Лист персонажа в стиле классического листа D&D 5e (2014), как его делает Long Story Short:
// страницы A4 (794×1123 px при 96 dpi), предпросмотр, скачивание PDF (html2canvas + jsPDF) и печать.
// Страницы собираются в видимом контейнере, чтобы можно было измерять текст: подгонять шрифт под рамку,
// переносить заметки на следующие страницы и делить длинные заклинания на несколько карточек.
import {
  ABILITIES, ABIL_SHORT, SKILLS, COINS, mod, fmtMod, profBonus, skillBonus, saveBonus, carried, fmtNum,
} from './rules.js';
import { sanitizeHtml } from './richtext.js';

const PAGE_W = 794;
const PAGE_H = 1123;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const initiative = (c) => mod(c.abilities.dex) + (Number(c.initBonus) || 0);

// Заклинательная характеристика: выбранная вручную или угаданная по классу
const CLASS_ABIL = [
  [/волшеб|изобрет|wizard|artificer/i, 'int'],
  [/жрец|друид|следопыт|cleric|druid|ranger/i, 'wis'],
  [/бард|колдун|чародей|паладин|bard|warlock|sorcerer|paladin/i, 'cha'],
];
export function spellAbility(c) {
  if (c.spellAbility) return c.spellAbility;
  const hit = CLASS_ABIL.find(([re]) => re.test(c.cls || ''));
  return hit ? hit[1] : '';
}
export function spellStats(c) {
  const a = spellAbility(c);
  if (!a) return null;
  const pb = profBonus(c.level);
  const m = mod(c.abilities[a]);
  return { ability: a, name: ABILITIES.find(([k]) => k === a)[2], dc: 8 + pb + m, attack: pb + m };
}

/* ---------- мелкие детали вёрстки ---------- */

const box = (title, inner, cls = '') => `<div class="sp-box ${cls}"><div class="sp-box-in">${inner}</div><div class="sp-cap">${title}</div></div>`;
const dots = (n, filled = 0) => '<span class="sp-dots">' + Array.from({ length: n }, (_, i) => `<i class="${i < filled ? 'f' : ''}"></i>`).join('') + '</span>';
const bubble = (on) => `<i class="sp-bub ${on === 2 ? 'x' : on ? 'f' : ''}"></i>`;

function header(c, right) {
  return `
    <div class="sp-head">
      <div class="sp-name"><div class="sp-name-v">${esc(c.name)}</div><div class="sp-lbl">имя персонажа</div></div>
      <div class="sp-headbox">${right}</div>
    </div>`;
}
const hf = (label, value) => `<div class="sp-hf"><div class="sp-hf-v">${esc(value)}</div><div class="sp-lbl">${label}</div></div>`;

/* ---------- страница 1: основной лист ---------- */

function page1(c) {
  const b = c.bio || {};
  const p = c.prof || {};
  const pb = profBonus(c.level);
  const hd = c.hitDice.map((h) => `к${h.die}`).join(' + ');
  const hdTotal = c.hitDice.reduce((s, h) => s + h.max, 0);
  const hdLeft = c.hitDice.reduce((s, h) => s + h.max - h.used, 0);
  const ss = spellStats(c);
  const w = carried(c);

  const abilities = ABILITIES.map(([k, , name]) => `
    <div class="sp-ab">
      <div class="sp-ab-n">${name}</div>
      <div class="sp-ab-m">${fmtMod(mod(c.abilities[k]))}</div>
      <div class="sp-ab-s">${c.abilities[k]}</div>
    </div>`).join('');

  const saves = ABILITIES.map(([k, , name]) =>
    `<div class="sp-li">${bubble(c.saves[k] ? 1 : 0)}<u>${fmtMod(saveBonus(c, k))}</u> ${name}</div>`).join('');
  const skills = SKILLS.map(([k, name, a]) =>
    `<div class="sp-li sm">${bubble(c.skills[k] || 0)}<u>${fmtMod(skillBonus(c, k, a))}</u> ${name} <span>(${ABIL_SHORT[a][0] + ABIL_SHORT[a].slice(1).toLowerCase()})</span></div>`).join('');

  const profText = [['armor', 'Доспехи'], ['weapons', 'Оружие'], ['tools', 'Инструменты'], ['languages', 'Языки']]
    .filter(([k]) => (p[k] || '').trim()).map(([k, l]) => `<p><b>${l}:</b> ${nl(p[k].trim())}</p>`).join('');

  // «Атаки и заклинания»: ячейки и параметры заклинаний
  const slotLines = [];
  for (let l = 1; l <= 9; l++) {
    const s = c.slots[l];
    if (s && s.max) slotLines.push(`<p><b>Ячейки ${l} уровня:</b> ${dots(s.max, s.max - s.used)}</p>`);
  }
  if (c.pact.max) slotLines.push(`<p><b>Ячейки колдуна (${c.pact.level} ур.):</b> ${dots(c.pact.max, c.pact.max - c.pact.used)}</p>`);
  const attacks = [
    ...slotLines,
    ss ? `<p style="margin-top:6px"><b>Спасбросок заклинания:</b> ${ss.dc} <span class="sp-muted">(8 + бонус мастерства + ${ss.name})</span></p>
      <p><b>Попадание заклинанием:</b> ${fmtMod(ss.attack)} <span class="sp-muted">(бонус мастерства + ${ss.name})</span></p>` : '',
  ].join('');

  const items = c.items.map((it) =>
    `<p><b>${esc(it.name)}</b>${Number(it.qty) !== 1 ? ` ×${fmtNum(it.qty)}` : ''}${Number(it.weight) ? ` <span class="sp-muted">${fmtNum(it.weight)} фнт.</span>` : ''}${it.note ? ` — ${esc(it.note)}` : ''}</p>`).join('')
    + (c.items.length ? `<p class="sp-muted">Вес: ${fmtNum(w.total)} фнт.</p>` : '');

  const resources = c.resources.map((r) =>
    `<p><b>${esc(r.name)}</b> ${dots(Math.min(r.max, 12), Math.min(r.cur, 12))}${r.max > 12 ? ` ${r.cur}/${r.max}` : ''}
      <span class="sp-muted">${r.reset === 'short' ? '· короткий отдых' : r.reset === 'long' ? '· длинный отдых' : ''}</span></p>`).join('');

  return `
  <div class="sp-page">
    ${header(c, `
      <div class="sp-hgrid">
        ${hf('класс', c.cls || '')}${hf('предыстория', b.background || '')}${hf('имя игрока', '')}
        ${hf('раса', b.race || '')}${hf('мировоззрение', b.alignment || '')}${hf('уровень', c.level)}
      </div>`)}
    <div class="sp-p1">
      <div class="sp-col1">
        <div class="sp-abil-row">
          <div class="sp-abils">${abilities}</div>
          <div class="sp-abil-side">
            <div class="sp-pill"><span class="sp-pill-v">${c.inspiration ? '★' : ''}</span><span>Вдохновение</span></div>
            <div class="sp-pill"><span class="sp-pill-v round">${fmtMod(pb)}</span><span>Бонус мастерства</span></div>
            ${box('Спасброски', saves, 'sp-saves')}
            ${box('Навыки', skills, 'sp-skills')}
          </div>
        </div>
        <div class="sp-pill wide"><span class="sp-pill-v round">${10 + skillBonus(c, 'perception', 'wis')}</span><span>Пассивная мудрость (внимательность)</span></div>
        ${box('Прочие владения и языки', `<div class="sp-fit">${profText}</div>`, 'sp-grow')}
      </div>

      <div class="sp-col2">
        <div class="sp-panel">
          <div class="sp-trio">
            <div class="sp-shield"><b>${c.ac}</b><span>КД</span></div>
            <div class="sp-stat"><b>${fmtMod(initiative(c))}</b><span>Инициатива</span></div>
            <div class="sp-stat"><b>${c.speed}</b><span>Скорость</span></div>
          </div>
          <div class="sp-hp">
            <div class="sp-hp-max"><span class="sp-lbl">максимум хитов</span> <u>${c.hp.max}</u></div>
            <div class="sp-hp-cur">${c.hp.cur}</div>
            <div class="sp-cap">Текущие хиты</div>
          </div>
          <div class="sp-hp small"><div class="sp-hp-cur">${c.hp.temp || ''}</div><div class="sp-cap">Временные хиты</div></div>
          <div class="sp-duo">
            <div class="sp-hp small"><div class="sp-hp-max"><span class="sp-lbl">всего</span> <u>${hdTotal}</u></div>
              <div class="sp-hp-cur sm">${hdLeft} × ${hd}</div><div class="sp-cap">Кости хитов</div></div>
            <div class="sp-hp small"><div class="sp-death">
                <div><span class="sp-lbl">успехи</span> ${dots(3, c.deathSaves.ok)}</div>
                <div><span class="sp-lbl">провалы</span> ${dots(3, c.deathSaves.fail)}</div></div>
              <div class="sp-cap">Спасброски от смерти</div></div>
          </div>
        </div>
        ${box('Атаки и заклинания', `<div class="sp-fit">${attacks}</div>`, 'sp-attacks')}
        ${box('Снаряжение', `
          <div class="sp-equip">
            <div class="sp-coins">${COINS.map(([k, n]) => `<div class="sp-coin"><span>${n}</span><b>${Number(c.coins[k]) || 0}</b></div>`).join('')}</div>
            <div class="sp-fit">${items}</div>
          </div>`, 'sp-grow')}
      </div>

      <div class="sp-col3">
        ${box('Умения и способности', `<div class="sp-fit">${resources}</div>`, 'sp-grow')}
      </div>
    </div>
    <div class="sp-foot">Книга заклинаний · D&D 5e ${esc(c.edition)}</div>
  </div>`;
}

/* ---------- страница 2: внешность и предыстория ---------- */

function page2(c) {
  const b = c.bio || {};
  const prof = [['age', 'возраст'], ['height', 'рост'], ['weight', 'вес'], ['eyes', 'глаза'], ['skin', 'кожа'], ['hair', 'волосы']];
  return `
  <div class="sp-page">
    ${header(c, `<div class="sp-hgrid">${prof.map(([k, l]) => hf(l, b[k] || '')).join('')}</div>`)}
    <div class="sp-p2">
      <div class="sp-p2-left">
        ${box('Внешность персонажа', `<div class="sp-fit big">${nl(b.appearance)}</div>`, 'sp-grow')}
        ${box('Прочее снаряжение и сокровища', `<div class="sp-fit">${nl(c.inventory)}</div>`, 'sp-grow')}
      </div>
      <div class="sp-p2-right">
        <div class="sp-panel sp-persona">
          ${box('Черты характера', `<div class="sp-fit">${nl(b.traits)}</div>`)}
          ${box('Идеалы', `<div class="sp-fit">${nl(b.ideals)}</div>`)}
          ${box('Привязанности', `<div class="sp-fit">${nl(b.bonds)}</div>`)}
          ${box('Слабости', `<div class="sp-fit">${nl(b.flaws)}</div>`)}
        </div>
        ${box('Предыстория персонажа', `<div class="sp-fit big">${nl(b.backstory)}</div>`, 'sp-grow')}
      </div>
    </div>
    <div class="sp-foot">Книга заклинаний · D&D 5e ${esc(c.edition)}</div>
  </div>`;
}

/* ---------- страницы заметок (переносятся, если не помещаются) ---------- */

function notesPage(c, cont) {
  return `
  <div class="sp-page">
    ${header(c, `<div class="sp-headtitle">Заметки${cont ? ' (продолжение)' : ''}</div>`)}
    ${box('Заметки', '<div class="sp-notes"></div>', 'sp-notes-box')}
    <div class="sp-foot">Книга заклинаний · D&D 5e ${esc(c.edition)}</div>
  </div>`;
}

function flowNotes(stage, c) {
  const src = document.createElement('div');
  src.innerHTML = sanitizeHtml(c.notesHtml || '');
  const blocks = [...src.childNodes].filter((n) => n.nodeType === 1 || n.textContent.trim());
  if (!blocks.length) return;
  let page = appendHtml(stage, notesPage(c, false));
  let area = page.querySelector('.sp-notes');
  for (const b of blocks) {
    area.appendChild(b);
    if (area.scrollHeight > area.clientHeight + 1 && area.childNodes.length > 1) {
      area.removeChild(b);
      page = appendHtml(stage, notesPage(c, true));
      area = page.querySelector('.sp-notes');
      area.appendChild(b);
    }
  }
}

/* ---------- страница заклинаний ---------- */

const LEVEL_COLS = [[0, 1, 2], [3, 4, 5], [6, 7, 8, 9]];
const LEVEL_H = { 0: 300, 1: 330, 2: 300, 3: 330, 4: 300, 5: 300, 6: 220, 7: 220, 8: 220, 9: 220 };

function spellPage(c) {
  const ss = spellStats(c);
  const block = (l) => {
    const list = c.spells.filter((s) => s.level === l).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const slot = c.slots[l];
    const pact = c.pact.max && c.pact.level === l ? c.pact : null;
    const total = (slot?.max || 0) + (pact?.max || 0);
    const used = (slot?.used || 0) + (pact?.used || 0);
    const lines = list.map((s) => `<div class="sp-sl">${l ? bubble(s.prepared ? 1 : 0) : ''}<span>${esc(s.name)}${s.nameEn ? ` <em>[${esc(s.nameEn)}]</em>` : ''}${s.concentration ? ' <small>К</small>' : ''}${s.ritual ? ' <small>Р</small>' : ''}</span></div>`).join('');
    return `
      <div class="sp-lvl" style="height:${LEVEL_H[l]}px">
        <div class="sp-lvl-h"><span class="sp-lvl-n">${l}</span>${l === 0 ? '<span class="sp-lvl-t">Заговоры</span>' : `<span class="sp-lvl-tot">${total || ''}</span>${dots(total, total - used)}`}</div>
        <div class="sp-lvl-b sp-fit">${lines}</div>
      </div>`;
  };
  return `
  <div class="sp-page">
    <div class="sp-head">
      <div class="sp-name"><div class="sp-name-v">${esc(c.cls || '')}</div><div class="sp-lbl">класс заклинателя</div></div>
      <div class="sp-spellstats">
        <div><b>${ss ? ss.name : '—'}</b><span class="sp-lbl">базовая характеристика</span></div>
        <div><b>${ss ? ss.dc : '—'}</b><span class="sp-lbl">сложность спасброска</span></div>
        <div><b>${ss ? fmtMod(ss.attack) : '—'}</b><span class="sp-lbl">бонус атаки</span></div>
      </div>
    </div>
    <div class="sp-p4">${LEVEL_COLS.map((col) => `<div class="sp-p4-col">${col.map(block).join('')}</div>`).join('')}</div>
    <div class="sp-foot">● подготовлено · К концентрация · Р ритуал</div>
  </div>`;
}

/* ---------- карточки заклинаний (3×3 на странице) ---------- */

const ICON = {
  time: '<svg viewBox="0 0 16 16"><path d="M4 1h8v3l-3 4 3 4v3H4v-3l3-4-3-4z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  range: '<svg viewBox="0 0 16 16"><path d="M1 5h14v6H1z M4 5v3 M7 5v4 M10 5v3 M13 5v3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  dur: '<svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 5v4l3 2 M6 1h4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  comp: '<svg viewBox="0 0 16 16"><path d="M8 15V7 M8 7C8 3 4 2 2 2c0 4 2 5 6 5 M8 9c0-3 3-4 6-4 0 3-2 4-6 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};

function cardShell(s, first) {
  const chips = first ? `
    <div class="sc-chips">
      ${s.castTime ? `<span>${ICON.time}${esc(s.castTime)}</span>` : ''}
      ${s.range ? `<span>${ICON.range}${esc(s.range)}</span>` : ''}
      ${s.duration ? `<span>${ICON.dur}${esc(s.duration)}</span>` : ''}
    </div>` : '';
  const tags = [s.concentration ? 'концентрация' : '', s.ritual ? 'ритуал' : ''].filter(Boolean).join(', ');
  return `
    <div class="sc">
      <div class="sc-h">${first ? `<span class="sc-l">${s.level}</span>` : ''}<span class="sc-n">${esc(s.name)}</span></div>
      ${chips}
      <div class="sc-b"></div>
      ${s.components ? `<div class="sc-comp">${ICON.comp}${esc(s.components)}${tags ? ` · ${tags}` : ''}</div>` : ''}
      <div class="sc-f"><span>${esc([s.school, s.nameEn].filter(Boolean).join(' | '))}</span><b class="sc-pg"></b></div>
    </div>`;
}

// Абзацы описания: обычный текст и выделенный блок «на больших уровнях»
function cardParas(s) {
  const out = [];
  for (const p of String(s.text || '').split(/\n{2,}/)) if (p.trim()) out.push({ text: p.trim() });
  for (const p of String(s.higher || '').split(/\n{2,}/)) if (p.trim()) out.push({ text: p.trim(), higher: true });
  return out;
}
function paraEl(p, text) {
  const el = document.createElement('p');
  if (p.higher) el.className = 'hi';
  el.innerHTML = nl(text);
  return el;
}

function makeCards(stage, spells) {
  const cards = [];
  let grid = null;
  const newCard = (s, first) => {
    if (!grid || grid.children.length === 9) {
      const page = appendHtml(stage, '<div class="sp-page sp-cards"><div class="sc-grid"></div></div>');
      grid = page.querySelector('.sc-grid');
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = cardShell(s, first);
    const card = wrap.firstElementChild;
    grid.appendChild(card);
    return card;
  };

  for (const s of spells) {
    const own = [];
    let card = newCard(s, true);
    own.push(card);
    let body = card.querySelector('.sc-b');
    const fits = () => body.scrollHeight <= body.clientHeight + 1;
    for (const p of cardParas(s)) {
      let el = paraEl(p, p.text);
      body.appendChild(el);
      if (fits()) continue;
      // абзац не влез целиком — делим по словам, остаток переносим на следующую карточку
      body.removeChild(el);
      let words = p.text.split(/(\s+)/);
      while (words.length) {
        let lo = 0;
        let hi = words.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          el = paraEl(p, words.slice(0, mid).join(''));
          body.appendChild(el);
          const ok = fits();
          body.removeChild(el);
          if (ok) lo = mid;
          else hi = mid - 1;
        }
        if (lo > 0) body.appendChild(paraEl(p, words.slice(0, lo).join('')));
        words = words.slice(lo);
        while (words.length && !words[0].trim()) words.shift();
        if (words.length) {
          card = newCard(s, false);
          own.push(card);
          body = card.querySelector('.sc-b');
          el = paraEl(p, words.join(''));
          body.appendChild(el);
          if (fits()) break;
          body.removeChild(el);
        }
      }
    }
    if (own.length > 1) own.forEach((cd, i) => (cd.querySelector('.sc-pg').textContent = `${i + 1}/${own.length}`));
    cards.push(...own);
  }
  return cards;
}

/* ---------- сборка ---------- */

function appendHtml(stage, html) {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  const el = t.firstElementChild;
  stage.appendChild(el);
  return el;
}

// Уменьшаем шрифт в рамках, где текст не помещается
function fitText(stage) {
  stage.querySelectorAll('.sp-fit').forEach((el) => {
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollHeight > el.clientHeight + 1 && size > 6.5) {
      size -= 0.5;
      el.style.fontSize = size + 'px';
    }
  });
}

export function buildPages(stage, c, opts) {
  stage.innerHTML = '';
  appendHtml(stage, page1(c));
  appendHtml(stage, page2(c));
  if (opts.notes) flowNotes(stage, c);
  const hasSpells = c.spells.length || Object.values(c.slots).some((s) => s.max) || c.pact.max;
  if (hasSpells) appendHtml(stage, spellPage(c));
  fitText(stage);
  if (opts.cards && c.spells.length) {
    const spells = [...c.spells].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'ru'));
    makeCards(stage, spells);
  }
  return [...stage.querySelectorAll('.sp-page')];
}

/* ---------- PDF ---------- */

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Не удалось загрузить ' + src));
    document.head.appendChild(s);
  });
}

export async function savePdf(pages, fileName, onProgress) {
  if (!window.html2canvas) await loadScript('js/vendor/html2canvas.min.js');
  if (!window.jspdf) await loadScript('js/vendor/jspdf.umd.min.js');
  const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i + 1, pages.length);
    const canvas = await window.html2canvas(pages[i], {
      scale: 2, backgroundColor: '#ffffff', width: PAGE_W, height: PAGE_H, windowWidth: PAGE_W, logging: false,
    });
    if (i) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
  }
  pdf.save(fileName);
}

export { PAGE_W, PAGE_H };
