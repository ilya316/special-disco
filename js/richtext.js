// Форматированный текст заметок: очистка HTML (вставка из других сайтов, данные с других устройств).
// Оставляем только простое форматирование, всё остальное (скрипты, стили, шрифты, цвета) выбрасываем.

const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'H1', 'H2', 'H3', 'H4', 'P', 'DIV', 'BR',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR']);
const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'svg', 'SVG', 'IMG', 'VIDEO', 'AUDIO',
  'CANVAS', 'NOSCRIPT', 'META', 'LINK', 'TITLE', 'HEAD', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM']);
const RENAME = { STRONG: 'B', EM: 'I', STRIKE: 'S', DEL: 'S', H1: 'H3', H2: 'H3', H4: 'H3' };

// Стили вида font-weight:700 (Google Docs, Word) превращаем в обычные теги
function styleWrappers(el) {
  const st = el.getAttribute && el.getAttribute('style');
  if (!st) return [];
  const s = st.toLowerCase();
  const out = [];
  const fw = s.match(/font-weight\s*:\s*(\w+)/);
  if (fw && (fw[1] === 'bold' || fw[1] === 'bolder' || Number(fw[1]) >= 600)) out.push('B');
  if (/font-style\s*:\s*italic/.test(s)) out.push('I');
  if (/text-decoration[^;]*underline/.test(s)) out.push('U');
  if (/text-decoration[^;]*line-through/.test(s)) out.push('S');
  return out;
}

function clean(src, doc) {
  const frag = doc.createDocumentFragment();
  for (const node of src.childNodes) {
    if (node.nodeType === 3) {
      frag.appendChild(doc.createTextNode(node.textContent));
      continue;
    }
    if (node.nodeType !== 1 || DROP.has(node.tagName)) continue;
    const tag = node.tagName;
    const inner = clean(node, doc);
    let out;
    if (KEEP.has(tag)) {
      // Google Docs оборачивает весь текст в <b style="font-weight:normal">
      if (tag === 'B' && /font-weight\s*:\s*(normal|400)/i.test(node.getAttribute('style') || '')) {
        out = inner;
      } else {
        const el = doc.createElement(RENAME[tag] || tag);
        if (tag === 'A') {
          const href = node.getAttribute('href') || '';
          if (/^https?:\/\//i.test(href)) {
            el.setAttribute('href', href);
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener');
          }
        }
        el.appendChild(inner);
        out = el;
      }
    } else {
      out = inner; // span, font, section и т.п. — оставляем только содержимое
    }
    for (const w of styleWrappers(node).reverse()) {
      const el = doc.createElement(w);
      el.appendChild(out);
      out = el;
    }
    frag.appendChild(out);
  }
  return frag;
}

export function sanitizeHtml(html) {
  const src = new DOMParser().parseFromString(String(html || ''), 'text/html').body;
  const box = document.createElement('div');
  box.appendChild(clean(src, document));
  return box.innerHTML.replace(/(<br>\s*){3,}/g, '<br><br>');
}

const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Старые заметки были обычным текстом — переводим в HTML с сохранением строк
export function textToHtml(text) {
  if (!text) return '';
  return text.split('\n').map((l) => `<div>${l ? escape(l) : '<br>'}</div>`).join('');
}
