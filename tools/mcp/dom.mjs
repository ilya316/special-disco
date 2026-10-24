// DOM для общих модулей приложения (js/*.js) в Node: разбор страниц dnd.su, очистка HTML, экспорт LSS.
// linkedom — лёгкая замена браузерного DOM. Отличие, которое правим: браузерный DOMParser
// оборачивает кусок HTML в <html><body>, а linkedom — нет, и тогда .body оказывается пустым.
import { DOMParser as LinkedomParser, parseHTML } from 'linkedom';

class DOMParser {
  parseFromString(html, type) {
    const s = String(html ?? '');
    const full = /<html[\s>]|<body[\s>]/i.test(s) ? s : `<!doctype html><html><head></head><body>${s}</body></html>`;
    return new LinkedomParser().parseFromString(full, type);
  }
}

const { document, NodeFilter } = parseHTML('<!doctype html><html><head></head><body></body></html>');
// браузер приводит имена HTML-тегов к строчным (createElement('P') → <p>), linkedom — нет
const createElement = document.createElement.bind(document);
document.createElement = (name, opts) => createElement(String(name).toLowerCase(), opts);
Object.assign(globalThis, { DOMParser, document, NodeFilter });
