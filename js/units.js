// Футы ↔ метры. В русских правилах D&D принято: 1 клетка = 5 футов = 1,5 м (множитель 0,3).
import { fmtNum } from './rules.js';

export const FT_TO_M = 0.3;
export const ftToM = (ft) => fmtNum(ft * FT_TO_M);
export const mToFt = (m) => fmtNum(m / FT_TO_M);

const NUM = '(\\d+(?:[.,]\\d+)?)';
// «60 футов», «1 фут», «30 фт.», «20-футовый», «2 мили»
const UNIT_RE = new RegExp(
  `${NUM}(?:\\s|\\u00a0)*(-фут[а-яё]*|фут(?:ов|а)?(?![а-яё])|фт\\.?(?![а-яё])|мил(?:я|и|ь|ю|е|ях|ями)(?![а-яё]))`,
  'gi',
);
const ALREADY = /^\s*\(\s*≈?\s*[\d.,]+\s*к?м\s*\)/;

// Дописывает метры (и километры для миль) к футам в обычном тексте; повторно не дописывает
export function withMeters(text) {
  return String(text ?? '').replace(UNIT_RE, (m, num, unit, offset, str) => {
    if (ALREADY.test(str.slice(offset + m.length))) return m;
    const n = parseFloat(num.replace(',', '.'));
    if (/^мил/i.test(unit)) return `${m} (${fmtNum(n * 1.6)} км)`;
    return `${m} (${ftToM(n)} м)`;
  });
}

// То же для HTML: меняем только текст, теги не трогаем
export function metersHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const walker = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) n.textContent = withMeters(n.textContent);
  return t.innerHTML;
}

const TABLE = [[1, 5], [2, 10], [3, 15], [4, 20], [6, 30], [8, 40], [10, 50], [12, 60], [24, 120], [30, 150], [60, 300]];

export function memoHtml(metersOn) {
  return `
    <div class="memo-conv">
      <label class="field"><span>Футы</span><input type="text" inputmode="decimal" autocomplete="off" id="ucFt" placeholder="30"></label>
      <span class="memo-eq">=</span>
      <label class="field"><span>Метры</span><input type="text" inputmode="decimal" autocomplete="off" id="ucM" placeholder="9"></label>
    </div>
    <table class="memo-t">
      <tr><th>Клеток</th><th>Футов</th><th>Метров</th></tr>
      ${TABLE.map(([cells, ft]) => `<tr><td>${cells}</td><td>${ft}</td><td>${ftToM(ft)}</td></tr>`).join('')}
    </table>
    <ul class="memo-l">
      <li><b>1 клетка = 5 футов = 1,5 м</b> — так принято в русских правилах (точно 1 фут = 30,48 см).</li>
      <li>Скорость 30 футов за раунд (6 секунд) ≈ 9 м.</li>
      <li>1 дюйм ≈ 2,5 см · 1 миля = 5280 футов ≈ 1,6 км.</li>
      <li>1 фунт ≈ 0,45 кг · 1 галлон ≈ 3,8 л.</li>
      <li>Темп путешествия: быстрый — 4 мили/ч, 30 миль/день (≈ 48 км); обычный — 3 мили/ч, 24 мили/день (≈ 38 км);
        медленный — 2 мили/ч, 18 миль/день (≈ 29 км).</li>
    </ul>
    <label class="check"><input type="checkbox" id="ucToggle" ${metersOn ? 'checked' : ''}> Показывать метры рядом с футами в заклинаниях, существах и на листе</label>`;
}
