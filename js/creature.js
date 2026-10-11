// Существа (фамильяры, призванные, спутники): разбор блока статистики с dnd.su / next.dnd.su
// (страница бестиария) или из скопированного текста.
import { sanitizeHtml } from './richtext.js';
import { editionFromUrl } from './parser.js';

export const ABIL_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABIL_RU = { сил: 'str', лов: 'dex', тел: 'con', инт: 'int', мдр: 'wis', муд: 'wis', хар: 'cha' };

export function emptyCreature() {
  return {
    name: '', nameEn: '', role: 'Фамильяр', url: '', edition: '2014', meta: '',
    ac: 10, acText: '', hpMax: 1, hpCur: 1, hpTemp: 0, hpFormula: '', speed: '',
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    props: [], sections: [], notes: '',
  };
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').trim();
const abilKey = (t) => ABIL_RU[clean(t).toLowerCase().slice(0, 3)] || null;

function splitName(title, c) {
  const m = clean(title).match(/^(.*?)\s*\[([^\]]+)\]/);
  if (m) {
    c.name = m[1].trim();
    c.nameEn = m[2].trim();
  } else c.name = clean(title);
}

// Текст пункта без подписи и всплывающих «?»
function valueText(li, labelEl) {
  const copy = li.cloneNode(true);
  copy.querySelectorAll('sup, .icon-dice, .rolled-hits, .monster__treasure-roll-result, svg').forEach((x) => x.remove());
  if (labelEl) {
    const lbl = [...copy.querySelectorAll('strong')].find((s) => s.textContent.trim() === labelEl.textContent.trim());
    if (lbl) lbl.remove();
  }
  return clean(copy.textContent);
}

export function parseCreatureHtml(html, url = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const c = emptyCreature();
  c.url = url;
  c.edition = editionFromUrl(url) || '2014';

  const title = doc.querySelector('h2.card-title [data-copy]') || doc.querySelector('h2.card-title');
  if (title) splitName(title.getAttribute('data-copy') || title.textContent, c);

  const params = doc.querySelector('ul.params');
  if (!params) throw new Error('На странице не найден блок статистики существа');

  for (const li of params.children) {
    const cls = li.className || '';
    if (/size-type-alignment/.test(cls)) {
      c.meta = valueText(li);
      continue;
    }
    if (/abilities/.test(cls)) {
      // 2014: div.stat[title] > div «Сил», div «6 (−2)»; 2024: .stat-pair-row > .title «СИЛ», .value «6»
      li.querySelectorAll('.stat').forEach((st) => {
        const k = abilKey(st.children[0]?.textContent || st.getAttribute('title'));
        const v = parseInt(st.children[1]?.textContent, 10);
        if (k && !Number.isNaN(v)) c.abilities[k] = v;
      });
      li.querySelectorAll('.stat-pair-row').forEach((row) => {
        const k = abilKey(row.querySelector('.title')?.textContent);
        const v = parseInt(row.querySelector('.value')?.textContent, 10);
        if (k && !Number.isNaN(v)) c.abilities[k] = v;
      });
      continue;
    }
    if (/armor-class-and-initiative/.test(cls)) {
      const ac = li.querySelector('.subsection-ac');
      const ini = li.querySelector('.subsection-initiative');
      if (ac) setAc(c, valueText(ac, ac.querySelector('strong')));
      if (ini) c.props.push({ label: 'Инициатива', value: valueText(ini, ini.querySelector('strong')) });
      continue;
    }
    const isSection = /subsection|monster__section/.test(cls);
    if (isSection) {
      const h = li.querySelector('h3');
      let titleText = h ? clean(h.textContent) : 'Особенности';
      const body = li.cloneNode(true);
      body.querySelectorAll('h3, sup, svg, script').forEach((x) => x.remove());
      // у вариантов («Вариант: Фамильяр бес») заголовок внутри блока
      if (!h && li.querySelector('.additionalInfo h3, .smallSectionTitle')) titleText = 'Дополнительно';
      const htmlBody = sanitizeHtml(body.innerHTML).trim();
      if (htmlBody) c.sections.push({ title: titleText, html: htmlBody });
      continue;
    }
    const label = li.querySelector('strong');
    if (!label) continue;
    const name = clean(label.textContent);
    const value = valueText(li, label);
    if (/^класс (доспеха|защиты)/i.test(name)) setAc(c, value);
    else if (/^хиты/i.test(name)) {
      const mid = li.querySelector('[data-type=middle]');
      c.hpMax = parseInt(mid ? mid.textContent : value, 10) || 1;
      c.hpCur = c.hpMax;
      c.hpFormula = (value.match(/\(([^)]+)\)/) || [])[1] || '';
    } else if (/^скорость/i.test(name)) c.speed = value;
    else if (/^бонус мастерства/i.test(name)) c.props.push({ label: 'Бонус мастерства', value: clean(name.replace(/^бонус мастерства/i, '')) || value });
    else c.props.push({ label: name, value });
  }
  return c;
}

function setAc(c, text) {
  c.ac = parseInt(text, 10) || c.ac;
  c.acText = (text.match(/\(([^)]+)\)/) || [])[1] || '';
}

// Скопированный со страницы текст: основные поля по подписям, остальное — одним разделом
const LABELS = [
  ['ac', /^класс (доспеха|защиты)\s*:?\s*(.*)$/i],
  ['hp', /^хиты\s*:?\s*(.*)$/i],
  ['speed', /^скорость\s*:?\s*(.*)$/i],
];
const PROP_RE = /^(спасброски|навыки|уязвимость к урону|сопротивление урону|иммунитет к урону|иммунитет к состоянию|иммунитеты|чувства|языки|опасность|бонус мастерства|инициатива|среда обитания)\s*:?\s*(.*)$/i;

export function parseCreatureText(raw, url = '') {
  const c = emptyCreature();
  c.url = url;
  c.edition = editionFromUrl(url) || '2014';
  const lines = raw.replace(/\r/g, '').split('\n').map((l) => l.replace(/^[\s*•·#-]+/, '').replace(/\*\*/g, '').trim());
  const rest = [];
  let named = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (!named) {
      splitName(l, c);
      named = true;
      continue;
    }
    if (!c.meta && /^(крошечн|маленьк|средн|больш|огромн|громадн)/i.test(l)) {
      c.meta = l;
      continue;
    }
    // характеристики: «СИЛ 6 (−2)» или строка «СИЛ ЛОВ ТЕЛ…» и под ней значения
    const ab = [...l.matchAll(/(сил|лов|тел|инт|мдр|хар)[а-я]*\.?\s*:?\s*(\d{1,2})/gi)];
    if (ab.length >= 2) {
      ab.forEach((m) => (c.abilities[abilKey(m[1])] = Number(m[2])));
      continue;
    }
    const hit = LABELS.find(([, re]) => re.test(l));
    if (hit) {
      const v = l.match(hit[1]).pop().trim();
      if (hit[0] === 'ac') setAc(c, v);
      else if (hit[0] === 'hp') {
        c.hpMax = parseInt(v, 10) || 1;
        c.hpCur = c.hpMax;
        c.hpFormula = (v.match(/\(([^)]+)\)/) || [])[1] || '';
      } else c.speed = v;
      continue;
    }
    const pm = l.match(PROP_RE);
    if (pm) {
      c.props.push({ label: pm[1][0].toUpperCase() + pm[1].slice(1), value: pm[2].trim() });
      continue;
    }
    if (/^(комментари|галерея|распечатать)/i.test(l)) break;
    rest.push(l);
  }
  if (rest.length) c.sections.push({ title: 'Особенности и действия', html: rest.map((l) => `<p>${l.replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]))}</p>`).join('') });
  return c;
}
