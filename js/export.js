// Экспорт персонажа в файл для импорта в Long Story Short (longstoryshort.app). Лист для PDF — js/sheet.js.
// Формат LSS восстановлен по исходникам конвертера Foundry → LSS (elfrey-lss-converter) и импортёров LSS JSON.
import { ABILITIES, SKILLS, COINS, COIN_NAME, mod, profBonus, fmtNum } from './rules.js';
import { sanitizeHtml } from './richtext.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PROF_LABELS = [['armor', 'Доспехи'], ['weapons', 'Оружие'], ['tools', 'Инструменты'], ['languages', 'Языки']];
const SUB_INFO = [['age', 'возраст'], ['height', 'рост'], ['weight', 'вес'], ['eyes', 'глаза'], ['skin', 'кожа'], ['hair', 'волосы']];
const initiative = (c) => mod(c.abilities.dex) + (Number(c.initBonus) || 0);
const rnd = () => Math.random().toString(36).slice(2, 10);

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ================= Long Story Short ================= */

// наши ключи навыков → ключи LSS
const LSS_SKILL = { animal: 'animal handling', sleight: 'sleight of hand' };

const tText = (text, marks) => (text ? { type: 'text', text, ...(marks && marks.length ? { marks: marks.map((type) => ({ type })) } : {}) } : null);
const tPara = (...inline) => {
  const content = inline.flat().filter(Boolean);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};
const tDoc = (block, content) => ({ value: { id: `hover-toolbar-${block}-${rnd()}`, data: { type: 'doc', content } } });

// Очищенный HTML заметок (js/richtext.js) → документ tiptap, как в редакторе LSS
const MARK = { B: 'bold', I: 'italic', U: 'underline', S: 'strike' };
const BLOCK = new Set(['P', 'DIV', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'HR']);

function inlineNodes(node, marks = []) {
  const out = [];
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) {
      const t = ch.textContent.replace(/\s+/g, ' ');
      if (t) out.push(tText(t, marks));
    } else if (ch.nodeType === 1) {
      if (ch.tagName === 'BR') out.push({ type: 'hardBreak' });
      else out.push(...inlineNodes(ch, MARK[ch.tagName] ? [...marks, MARK[ch.tagName]] : marks));
    }
  }
  return out.filter(Boolean);
}

function blockNodes(node) {
  const out = [];
  let inline = [];
  const flush = () => {
    if (inline.length) out.push(tPara(inline));
    inline = [];
  };
  for (const ch of node.childNodes) {
    if (ch.nodeType === 1 && BLOCK.has(ch.tagName)) {
      flush();
      const tag = ch.tagName;
      if (tag === 'H3') out.push({ type: 'heading', attrs: { level: 3 }, content: inlineNodes(ch) });
      else if (tag === 'UL' || tag === 'OL') {
        const items = [...ch.children].filter((li) => li.tagName === 'LI')
          .map((li) => ({ type: 'listItem', content: blockNodes(li).length ? blockNodes(li) : [tPara()] }));
        if (items.length) out.push({ type: tag === 'UL' ? 'bulletList' : 'orderedList', content: items });
      } else if (tag === 'BLOCKQUOTE') {
        out.push({ type: 'blockquote', content: blockNodes(ch).length ? blockNodes(ch) : [tPara()] });
      } else if (tag === 'TABLE' || tag === 'THEAD' || tag === 'TBODY') {
        out.push(...blockNodes(ch));
      } else if (tag === 'TR') {
        out.push(tPara(tText([...ch.children].map((td) => td.textContent.trim()).join(' | '))));
      } else if (tag === 'HR') {
        out.push({ type: 'horizontalRule' });
      } else {
        // P, DIV, LI: внутри могут быть и вложенные блоки
        const hasBlocks = [...ch.children].some((x) => BLOCK.has(x.tagName));
        if (hasBlocks) out.push(...blockNodes(ch));
        else out.push(tPara(inlineNodes(ch)));
      }
    } else if (ch.nodeType === 1) {
      inline.push(...inlineNodes({ childNodes: [ch] }));
    } else if (ch.nodeType === 3 && ch.textContent.trim()) {
      inline.push(tText(ch.textContent.replace(/\s+/g, ' ')));
    }
  }
  flush();
  return out;
}

export function htmlToTiptap(html) {
  const box = document.createElement('div');
  box.innerHTML = sanitizeHtml(html);
  return blockNodes(box);
}

export function toLss(c) {
  const pb = profBonus(c.level);
  const stats = {};
  const saves = {};
  for (const [k, , label] of ABILITIES) {
    stats[k] = { name: k, label, score: Number(c.abilities[k]) || 10, modifier: mod(c.abilities[k]), check: 0 };
    saves[k] = { name: k, isProf: !!c.saves[k] };
  }
  const skills = {};
  for (const [k, label, a] of SKILLS) {
    const key = LSS_SKILL[k] || k;
    const lvl = c.skills[k] || 0;
    skills[key] = { baseStat: a, name: key, label, isProf: lvl === 2 ? 2 : lvl === 1 ? 1 : c.jack ? 0.5 : 0 };
  }

  const dice = {};
  for (const h of c.hitDice) {
    const d = dice['d' + h.die] || { current: 0, max: 0 };
    d.current += h.max - h.used;
    d.max += h.max;
    dice['d' + h.die] = d;
  }
  const dieKeys = Object.keys(dice);

  const slots = {};
  for (let l = 1; l <= 9; l++) {
    const s = c.slots[l];
    if (s && s.max) slots[`slots-${l}`] = { value: s.max, filled: s.used };
  }
  const spellsPact = c.pact.max ? { [`slots-${c.pact.level}`]: { value: c.pact.max, filled: c.pact.used } } : {};

  // заклинания: по абзацу на каждое, по уровням
  const text = {};
  for (let l = 0; l <= 9; l++) {
    const list = c.spells.filter((s) => s.level === l).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const tags = (s) => [s.prepared && l > 0 ? '★' : '', s.concentration ? 'К' : '', s.ritual ? 'Р' : ''].filter(Boolean).join(' ');
    text[`spells-level-${l}`] = tDoc(`spells-level-${l}`, list.map((s) => tPara(
      tText(s.name, ['bold']),
      tags(s) ? tText(` (${tags(s)})`) : null,
      tText([s.castTime, s.range, s.duration].filter(Boolean).length ? ' — ' + [s.castTime, s.range, s.duration].filter(Boolean).join(', ') : ''),
    )));
  }

  const items = c.items.map((it) => {
    const meta = [
      Number(it.weight) ? `${fmtNum(it.weight)} фнт.` : '',
      Number(it.cost) ? `${fmtNum(it.cost)} ${COIN_NAME[it.cur] || 'зм'}` : '',
      it.note || '',
    ].filter(Boolean).join('; ');
    return tPara(tText(it.name, ['bold']), tText(Number(it.qty) !== 1 ? ` ×${fmtNum(it.qty)}` : ''), tText(meta ? ` — ${meta}` : ''));
  });
  text.items = tDoc('items', items);
  text.equipment = tDoc('equipment', (c.inventory || '').split('\n').filter((l) => l.trim()).map((l) => tPara(tText(l))));

  const resources = {};
  const traits = [];
  for (const r of c.resources) {
    const id = `resource-${r.id}`;
    resources[id] = {
      id, name: r.name, current: r.cur, max: r.max, location: 'traits',
      isLongRest: r.reset === 'long' || r.reset === 'short', isShortRest: r.reset === 'short',
      icon: r.reset === 'short' ? 'short-rest' : r.reset === 'long' ? 'long-rest' : '',
    };
    traits.push({ type: 'resource', attrs: { id, textName: 'traits' } });
  }
  text.traits = tDoc('traits', traits);
  text['notes-1'] = tDoc('notes-1', htmlToTiptap(c.notesHtml || ''));

  // владения и языки — один блок «prof», как в LSS
  const bio = c.bio || {};
  const prof = c.prof || {};
  text.prof = tDoc('prof', PROF_LABELS.filter(([k]) => (prof[k] || '').trim())
    .map(([k, label]) => tPara(tText(label + ': ', ['bold']), tText(prof[k].trim()))));
  // в LSS нет отдельного поля для описания внешности — кладём его в начало предыстории
  const lines = (s) => String(s || '').split('\n').filter((l) => l.trim()).map((l) => tPara(tText(l)));
  text.background = tDoc('background', [
    ...((bio.appearance || '').trim() ? [tPara(tText('Внешность', ['bold'])), ...lines(bio.appearance), tPara()] : []),
    ...lines(bio.backstory),
  ]);
  for (const k of ['personality', 'ideals', 'bonds', 'flaws']) {
    text[k] = tDoc(k, lines(bio[k === 'personality' ? 'traits' : k]));
  }

  const info = (name, label, value) => ({ name, label, value });
  const data = {
    isDefault: true,
    jsonType: 'character',
    template: 'default',
    name: { value: c.name },
    info: {
      charClass: info('charClass', 'класс и уровень', c.cls || ''),
      level: info('level', 'уровень', Number(c.level) || 1),
      background: info('background', 'предыстория', bio.background || ''),
      playerName: info('playerName', 'имя игрока', ''),
      race: info('race', 'раса', bio.race || ''),
      alignment: info('alignment', 'мировоззрение', bio.alignment || ''),
      experience: info('experience', 'опыт', 0),
    },
    subInfo: Object.fromEntries(SUB_INFO.map(([k, label]) => [k, info(k, label, bio[k] || '')])),
    proficiency: pb,
    stats,
    saves,
    skills,
    vitality: {
      'hp-current': { value: c.hp.cur },
      'hp-max': { value: c.hp.max },
      'hp-temp': { value: c.hp.temp },
      ac: { value: c.ac },
      speed: { value: c.speed },
      initiative: { value: initiative(c) },
      'hit-die': { value: dieKeys.length === 1 ? dieKeys[0] : 'multiclass' },
      'hp-dice-current': { value: Object.values(dice).reduce((s, d) => s + d.current, 0) },
      'hp-dice-multi': dieKeys.length > 1 ? dice : {},
      isDying: c.hp.cur <= 0,
      deathFails: c.deathSaves.fail,
      deathSuccesses: c.deathSaves.ok,
    },
    inspiration: !!c.inspiration,
    coins: Object.fromEntries(COINS.map(([k]) => [k, { value: Number(c.coins[k]) || 0 }])),
    spells: slots,
    spellsPact,
    text,
    resources,
    weaponsList: [],
    isHidden: false,
  };

  return {
    tags: [],
    disabledBlocks: { 'info-left': [], 'info-right': [], 'notes-left': [], 'notes-right': [] },
    spells: { mode: 'text', prepared: [], book: [] },
    data: JSON.stringify(data),
    jsonType: 'character',
    version: '2',
  };
}

export function downloadLss(c) {
  const name = (c.name || 'character').replace(/[\\/:*?"<>|]+/g, '_');
  download(`${name}-lss.json`, JSON.stringify(toLss(c), null, 2));
}
