// Разбор заклинаний со страниц dnd.su (2014) и next.dnd.su (2024):
// из HTML страницы (импорт по ссылке) или из скопированного текста.

const FIELDS = [
  ['castTime', /^время\s+(накладывания|сотворения)$/i],
  ['range', /^дистанция$/i],
  ['components', /^компоненты$/i],
  ['duration', /^длительность$/i],
  ['classes', /^классы$/i],
  ['subclasses', /^подклассы$/i],
  ['source', /^источник$/i],
];

const HIGHER_RE = /^(на\s+(больших|более\s+высоких)\s+уровнях|(использование|используя)\s+ячейк[уи]\s+(заклинания\s+)?большего\s+уровня|улучшение\s+заговора)\.?/i;

export function emptySpell() {
  return {
    name: '', nameEn: '', level: 0, school: '', castTime: '', range: '', components: '',
    duration: '', classes: '', subclasses: '', source: '', text: '', higher: '', url: '',
    edition: '2014', concentration: false, ritual: false,
  };
}

export function editionFromUrl(url) {
  if (/next\.dnd\.su/i.test(url)) return '2024';
  if (/dnd\.su/i.test(url)) return '2014';
  return null;
}

function fieldKey(label) {
  const l = label.replace(/[:\s]+$/, '').trim();
  for (const [key, re] of FIELDS) if (re.test(l)) return key;
  return null;
}

function parseLevelLine(line, spell) {
  const s = line.trim();
  const m = s.match(/^(\d)\s*(-?й\s*)?уров(ень|ня)\s*,?\s*(.*)$/i);
  const c = s.match(/^заговор\s*,?\s*(.*)$/i);
  if (!m && !c) return false;
  spell.level = m ? Number(m[1]) : 0;
  let school = (m ? m[4] : c[1]).trim();
  if (/ритуал/i.test(school)) {
    spell.ritual = true;
    school = school.replace(/\(?\s*ритуал\s*\)?/i, '').trim();
  }
  spell.school = school.replace(/[,.\s]+$/, '');
  spell.school = spell.school.charAt(0).toUpperCase() + spell.school.slice(1);
  return true;
}

function splitName(title, spell) {
  const t = title.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*\[([^\]]+)\]/);
  if (m) {
    spell.name = m[1].trim();
    spell.nameEn = m[2].trim();
  } else {
    spell.name = t;
  }
}

function finish(spell) {
  if (/концентрац/i.test(spell.duration)) spell.concentration = true;
  if (/ритуал/i.test(spell.castTime)) spell.ritual = true;
  // 2024: «Время сотворения: Действие или Ритуал»
  spell.text = spell.text.replace(/\n{3,}/g, '\n\n').trim();
  spell.higher = spell.higher.trim();
  return spell;
}

// Текст одного элемента с сохранением абзацев/строк таблиц.
function blockText(el) {
  const out = [];
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        out.push(ch.textContent.replace(/\s+/g, ' '));
      } else if (ch.nodeType === 1) {
        const tag = ch.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        if (tag === 'BR') { out.push('\n'); continue; }
        if (tag === 'TR') {
          out.push('\n' + [...ch.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
          continue;
        }
        const block = /^(P|DIV|LI|TABLE|UL|OL|H\d)$/.test(tag);
        if (block) out.push('\n');
        if (tag === 'LI') out.push('• ');
        walk(ch);
        if (block) out.push('\n');
      }
    }
  };
  walk(el);
  return out.join('').split('\n').map((l) => l.trim()).filter(Boolean).join('\n\n');
}

export function parseHtml(html, url = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const spell = emptySpell();
  spell.url = url;
  spell.edition = editionFromUrl(url) || '2014';

  const title = doc.querySelector('h2.card-title [data-copy]') || doc.querySelector('h2.card-title');
  if (title) splitName(title.getAttribute('data-copy') || title.textContent, spell);

  // Источник — плашки в заголовке, кроме ссылок на другую редакцию
  const plaques = [...doc.querySelectorAll('h2.card-title .source-plaque')]
    .filter((p) => p.tagName !== 'A')
    .map((p) => p.getAttribute('title'))
    .filter((t) => t && !/^Также/i.test(t));
  if (plaques.length) spell.source = plaques.join(', ');

  const params = doc.querySelector('ul.params');
  if (!params) throw new Error('На странице не найдено описание заклинания');

  for (const li of params.children) {
    if (li.classList.contains('desc') || li.querySelector('[itemprop="description"]')) {
      const desc = li.querySelector('[itemprop="description"]') || li;
      const paras = [];
      for (const block of desc.children.length ? desc.children : [desc]) {
        const txt = blockText(block);
        if (!txt) continue;
        if (HIGHER_RE.test(txt)) spell.higher += (spell.higher ? '\n\n' : '') + txt;
        else paras.push(txt);
      }
      spell.text = paras.join('\n\n');
      // next.dnd.su (2024): «Используя ячейку заклинания большего уровня» / «Улучшение заговора» — отдельный блок
      const hl = li.querySelector('[itemprop="spell__higher-levels"]');
      if (hl) {
        const head = hl.querySelector('.spell__higher-levels__head');
        const headText = head ? head.textContent.replace(/\s+/g, ' ').trim() : '';
        if (head) head.remove();
        spell.higher = [headText, blockText(hl)].filter(Boolean).join(' ');
      }
      continue;
    }
    const strong = li.querySelector('strong');
    if (strong) {
      const key = fieldKey(strong.textContent);
      const value = li.textContent.slice(li.textContent.indexOf(strong.textContent) + strong.textContent.length)
        .replace(/\?$/, '').replace(/\s+/g, ' ').replace(/^[:\s]+/, '').trim();
      if (key) spell[key] = value;
      continue;
    }
    parseLevelLine(li.textContent.replace(/\s+/g, ' '), spell);
  }
  return finish(spell);
}

const STOP_RE = /^(комментари|галерея|распечатать|оставить комментарий|войдите|homebrew|©)/i;

export function parseText(raw, url = '') {
  const spell = emptySpell();
  spell.url = url;
  const lines = raw.replace(/\r/g, '').split('\n')
    .map((l) => l.replace(/^[\s*•·\-–]+/, '').replace(/\*\*/g, '').trim());

  let nameFound = false;
  let lastFieldIdx = -1;
  let levelIdx = -1;

  lines.forEach((line, i) => {
    if (!line) return;
    if (!nameFound && /\[[^\]]+\]/.test(line) && !line.includes(':')) {
      splitName(line.replace(/^#+\s*/, '').replace(/\s+(PH|XGE|TCE|SRD)\S*$/i, ''), spell);
      nameFound = true;
      return;
    }
    if (levelIdx < 0 && parseLevelLine(line, spell)) {
      levelIdx = i;
      return;
    }
    const m = line.match(/^([А-Яа-яЁё ]{4,30}):\s*(.*)$/);
    if (m) {
      const key = fieldKey(m[1]);
      if (key) {
        spell[key] = m[2].trim();
        lastFieldIdx = i;
      }
    }
  });

  if (!nameFound) {
    const first = lines.find((l) => l && !/:/.test(l));
    if (first) splitName(first, spell);
  }

  const start = Math.max(lastFieldIdx, levelIdx) + 1;
  const desc = [];
  const higher = [];
  let inHigher = false;
  for (const line of lines.slice(start)) {
    if (STOP_RE.test(line)) break;
    if (!line) continue;
    if (HIGHER_RE.test(line)) inHigher = true;
    (inHigher ? higher : desc).push(line);
  }
  spell.text = desc.join('\n\n');
  spell.higher = higher.join('\n\n');

  spell.edition = editionFromUrl(url) ||
    (/время\s+сотворения/i.test(raw) ? '2024' : '2014');
  return finish(spell);
}

// Ссылка на заклинание в произвольном тексте (например, из «Поделиться»)
export function findSpellUrl(text) {
  const m = (text || '').match(/https?:\/\/(?:[\w-]+\.)?dnd\.su\/spells\/[^\s"'<>]+/i);
  return m ? m[0] : '';
}
