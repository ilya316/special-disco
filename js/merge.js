// Трёхстороннее слияние данных персонажей.
// base   — версия, которую это устройство видело при прошлой синхронизации (общий предок)
// local  — что сейчас на устройстве
// remote — что сейчас в облаке
// Правило: берём изменения с обеих сторон; удаляем что-то, только если его явно удалили на одной стороне,
// а на другой оно не менялось. При настоящем конфликте (одно и то же поле изменено по-разному) побеждает
// это устройство. Без base (первое подключение) — объединение: ничего не удаляется, в спорных полях — облако.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIdArray = (a) => Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string');

// JSON с сортировкой ключей — порядок полей не должен влиять на сравнение
export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (isObj(v)) {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}
export const eq = (a, b) => stable(a) === stable(b);

const NONE = Symbol('none'); // «нет общего предка» — отличается от «в предке поля не было»

export function merge3(base, local, remote) {
  if (eq(local, remote)) return local;
  if (base !== NONE) {
    if (eq(local, base)) return remote;
    if (eq(remote, base)) return local;
  }
  // изменено (или удалено/добавлено) с обеих сторон
  if (local === undefined) return remote; // удалили здесь, но там поменяли — сохраняем, чтобы не потерять
  if (remote === undefined) return local;
  if (isObj(local) && isObj(remote)) {
    const b = base !== NONE && isObj(base) ? base : null;
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const v = merge3(b ? b[k] : base === NONE ? NONE : undefined, local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isIdArray(local) && isIdArray(remote)) {
    return mergeById(base !== NONE && isIdArray(base) ? base : base === NONE ? NONE : [], local, remote);
  }
  // Настоящий конфликт. С общим предком побеждает это устройство (его правка свежее для пользователя);
  // без предка (первая синхронизация после обновления) — облако: устройство могло долго лежать со старыми данными.
  return base === NONE ? remote : local;
}

function mergeById(base, local, remote) {
  const bm = base === NONE ? null : new Map(base.map((x) => [x.id, x]));
  const lm = new Map(local.map((x) => [x.id, x]));
  const rm = new Map(remote.map((x) => [x.id, x]));
  const ids = [...local.map((x) => x.id), ...remote.map((x) => x.id).filter((id) => !lm.has(id))];
  const out = [];
  for (const id of ids) {
    const v = merge3(bm ? bm.get(id) : NONE, lm.get(id), rm.get(id));
    if (v !== undefined) out.push(v);
  }
  return out;
}

// Слияние списков персонажей. base = null — общего предка нет (первое подключение).
export function mergeCharacters(base, local, remote) {
  return mergeById(base ?? NONE, local, remote);
}
