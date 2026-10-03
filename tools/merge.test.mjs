import { mergeCharacters, eq } from '../js/merge.js';
let fail = 0;
const t = (name, got, want) => { const ok = eq(got, want); if (!ok) fail++; console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (ok ? '' : '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want))); };
const ch = (o) => ({ id: 'a', name: 'Арагорн', hp: { cur: 10, max: 10 }, items: [], notes: '', ...o });
const sword = { id: 'i1', name: 'Меч', qty: 1 }, rope = { id: 'i2', name: 'Верёвка', qty: 1 };

// 1. Случай пользователя: на A добавили вещи; B со старой копией (base = старая) открыл новую версию, которая добавила поле
{ const base = [ch()]; const remote = [ch({ items: [sword, rope] })]; const local = [ch({ notesHtml: '' })];
  t('старое устройство не стирает вещи', mergeCharacters(base, local, remote), [ch({ items: [sword, rope], notesHtml: '' })]); }
// 2. Разные вещи добавлены на двух устройствах
{ const base = [ch()]; t('вещи с обоих устройств', mergeCharacters(base, [ch({ items: [sword] })], [ch({ items: [rope] })]), [ch({ items: [sword, rope] })]); }
// 3. Удаление вещи на одном устройстве, другое её не трогало
{ const base = [ch({ items: [sword, rope] })]; t('удаление применяется', mergeCharacters(base, [ch({ items: [rope] })], base), [ch({ items: [rope] })]); }
// 4. Удалили на одном, изменили на другом — вещь остаётся (с изменением)
{ const base = [ch({ items: [sword] })]; const s2 = { ...sword, qty: 3 };
  t('удаление vs изменение: не теряем', mergeCharacters(base, [ch({ items: [] })], [ch({ items: [s2] })]), [ch({ items: [s2] })]); }
// 5. Разные поля одного персонажа
{ const base = [ch()]; t('разные поля сливаются', mergeCharacters(base, [ch({ hp: { cur: 4, max: 10 } })], [ch({ notes: 'квест' })]), [ch({ hp: { cur: 4, max: 10 }, notes: 'квест' })]); }
// 6. Одно поле по-разному — побеждает это устройство
{ const base = [ch()]; t('конфликт: локальное', mergeCharacters(base, [ch({ notes: 'A' })], [ch({ notes: 'B' })]), [ch({ notes: 'A' })]); }
// 7. Первое подключение без предка — объединение, ничего не удаляется
{ t('без предка: объединение', mergeCharacters(null, [ch({ items: [sword] })], [ch({ items: [rope] }), { id: 'b', name: 'Гимли' }]), [ch({ items: [sword, rope] }), { id: 'b', name: 'Гимли' }]); }
// 8. Удаление персонажа на одном устройстве
{ const g = { id: 'b', name: 'Гимли' }; const base = [ch(), g]; t('удаление персонажа', mergeCharacters(base, [ch()], base), [ch()]); }
// 9. Порядок ключей не важен
{ const base = [{ id: 'a', x: 1, y: 2 }]; t('порядок ключей', mergeCharacters(base, [{ y: 2, x: 1, id: 'a' }], [{ id: 'a', x: 1, y: 5 }]), [{ id: 'a', x: 1, y: 5 }]); }
{ t("без предка: спорное поле из облака", mergeCharacters(null, [ch({ notes: "старое", items: [sword] })], [ch({ notes: "новое" })]), [ch({ notes: "новое", items: [sword] })]); }
process.exit(fail ? 1 : 0);
