// Проверка MCP-сервера целиком: запускает server.mjs как Claude Code (stdio) и вызывает инструменты
// на ОТДЕЛЬНОМ тестовом коде синхронизации — данные пользователя не трогаются.
// Запуск: node tools/mcp/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC = 'https://special-disco.ilyabondar2o0o0o3.workers.dev/sync';
const A = 'abcdefghjkmnpqrstuvwxyz23456789';
const code = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => A[b % A.length]).join('').match(/.{4}/g).join('-');

const post = async (body) => (await fetch(SYNC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, code }) })).json();
// тестовое облако с одним персонажем
await post({ put: true, baseRev: 0, characters: [{ id: 'seed1', name: 'Затравка' }] });

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(HERE, 'server.mjs')], env: { ...process.env, SPELLBOOK_SYNC_CODE: code } }));

let fails = 0;
async function call(name, args = {}, expect) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join('\n');
  const good = !r.isError && (!expect || expect.test(text));
  if (!good) fails++;
  console.log(`${good ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(args).slice(0, 90)}\n     ${text.split('\n').slice(0, 3).join(' | ').slice(0, 220)}`);
  return text;
}

const { tools } = await client.listTools();
console.log(`Инструментов: ${tools.length}`);

await call('sync_status', {}, /персонажей 1/);
await call('create_character', { name: 'Элара', fields: { cls: 'Волшебник', level: 5, abilities: { int: 18, dex: 14, con: 14 }, hp: { cur: 27, max: 27 }, slots: { 1: { max: 4, used: 0 }, 3: { max: 2, used: 0 } } } }, /Создан «Элара»/);
await call('update_character', { character: 'Элара', patch: { skills: { arcana: 2, history: 1 }, bio: { race: 'Высший эльф' }, coins: { gp: 87 }, hitDice: [{ die: 6, max: 5, used: 2 }] } }, /Магия \+10/);
await call('add_spell_from_dndsu', { character: 'Элара', url: 'dnd.su/spells/205-fireball/', prepared: true }, /Огненный шар/);
await call('add_spell_from_text', { character: 'Элара', text: 'Щит [Shield]\n1 уровень, ограждение\nВремя накладывания: 1 реакция\nДистанция: На себя\nКомпоненты: В, С\nДлительность: 1 раунд\nНевидимый барьер.' }, /Щит/);
await call('add_creature_from_dndsu', { character: 'Элара', url: 'https://dnd.su/bestiary/84-imp/' }, /Бес/);
await call('add_entry', { character: 'Элара', list: 'items', entry: { name: 'Зелье лечения', qty: 2, weight: 0.5, cost: 50 } }, /Зелье лечения/);
await call('add_entry', { character: 'Элара', list: 'resources', entry: { name: 'Магическое восстановление', max: 1, reset: 'long' } }, /Магическое восстановление/);
await call('update_entry', { character: 'Элара', list: 'items', entry: 'зелье', patch: { qty: 3 } }, /qty/);
await call('cast_spell', { character: 'Элара', spell: 'огненный' }, /how="3"/);
await call('cast_spell', { character: 'Элара', spell: 'огненный', how: '3' }, /ячейка 3 ур/);
await call('set_hp', { character: 'Элара', temp: 5 }, /\+5 врем/);
await call('damage', { character: 'Элара', amount: 12 }, /Хиты 20\/27/);
await call('spend_hit_die', { character: 'Элара', roll: 4 }, /4 \+ 2 = 6/);
await call('resource_change', { character: 'Элара', resource: 'магическое', delta: -1 }, /0\/1/);
await call('creature_hp', { character: 'Элара', creature: 'бес', damage: 4 }, /6\/10/);
await call('set_notes', { character: 'Элара', html: '<h3>Квест</h3><div>Найти <b>гримуар</b></div><script>x</script>' }, /сохранены/);
await call('get_notes', { character: 'Элара' }, /<b>гримуар<\/b>/);
await call('long_rest', { character: 'Элара' }, /Хиты 27\/27/);
await call('get_character', { character: 'элара' }, /Огненный шар.*подготовлено/s);
const lssPath = path.join(os.tmpdir(), 'smoke-lss.json');
await call('export_lss', { character: 'Элара', path: lssPath }, /Сохранено/);
const lss = JSON.parse(await fs.readFile(lssPath, 'utf8'));
console.log(`     LSS: jsonType=${lss.jsonType}, Магия isProf=${JSON.parse(lss.data).skills.arcana.isProf}`);

// конфликт: кто-то записал между чтением и записью — сервер должен перечитать и сохранить обе правки
const before = await post({ peek: true });
const chars = before.characters.map((c) => (c.name === 'Затравка' ? { ...c, name: 'Затравка (правка с телефона)' } : c));
await post({ put: true, baseRev: before.rev, characters: chars });
await call('update_character', { character: 'Элара', patch: { level: 6 } }, /6 ур/);
const after = await post({ peek: true });
const both = after.characters.some((c) => c.name === 'Затравка (правка с телефона)') && after.characters.find((c) => c.name === 'Элара').level === 6;
console.log(`${both ? 'OK  ' : 'FAIL'} обе правки сохранились (телефон + Claude)`);
if (!both) fails++;

const hist = await call('list_versions', {}, /rev \d+/);
const firstRev = Number(hist.match(/rev (\d+)/g).pop().slice(4));
await call('get_version', { rev: firstRev }, /Затравка/);
await call('restore_version', { rev: firstRev, confirm: true }, /Восстановлена/);
await call('list_characters', {}, /Затравка/);
await call('create_character', { name: 'Временный' }, /Создан/);
await call('delete_character', { character: 'Временный', confirm: true }, /Удалён/);
await call('get_character', { character: 'нет-такого' }).catch(() => {});

await client.close();
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВсё прошло.');
process.exit(fails ? 1 : 0);
