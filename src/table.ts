import type { Column } from './readers';

const MS_PER_UNIT: Record<string, number> = { D: 864e5, h: 36e5, m: 6e4, s: 1e3, ms: 1, us: 1e-3, ns: 1e-6 };

const isoDate = (d: Date) => isNaN(+d) ? 'NaT' : d.toISOString().replace('T', ' ').replace(/(\.000)?Z$/, '');

const shortestFloat32 = (v: number) => {
  for (let digits = 1; digits < 9; digits++) if (Math.fround(+v.toPrecision(digits)) === v) return +v.toPrecision(digits);
  return +v.toPrecision(9);
};

export function cell(v: any, dtype = ''): any {
  if (typeof v === 'number') return !isFinite(v) ? String(v) : dtype.startsWith('float32') ? shortestFloat32(v) : v;
  if (typeof v === 'bigint') return dtype.startsWith('datetime64') ? isoDate(new Date(Number(v) * MS_PER_UNIT[dtype.slice(11, -1)])) : Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (v instanceof Date) return isoDate(v);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const items = Array.from(v as ArrayLike<any>);
    return items.slice(0, 20).map(x => cell(x, dtype)).concat(items.length > 20 ? ['…'] : []);
  }
  return v !== null && typeof v === 'object' ? JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x) : v ?? null;
}

export const isFloat = (dtype: string) => /float|double/.test(dtype);

export function sortOrder(values: ArrayLike<any>, desc: boolean) {
  const missing = (v: any) => +(v == null || v !== v), dir = desc ? -1 : 1;
  return Uint32Array.from({ length: values.length }, (_, i) => i).sort((a, b) => {
    const [x, y] = [values[a], values[b]];
    return missing(x) - missing(y) || dir * (x < y ? -1 : x > y ? 1 : 0);
  });
}

function* flatten(values: ArrayLike<any>): Generator<any> {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))) yield* flatten(v as ArrayLike<any>);
    else yield v;
  }
}

const numeric = (v: any, dtype: string) => (typeof v === 'number' || typeof v === 'bigint') && !dtype.startsWith('datetime64');

export function stats(columns: Column[], bins = 40) {
  let count = 0, missing = 0, nan = 0, inf = 0, finite = 0, sum = 0, min = Infinity, max = -Infinity;
  const categories = new Map<any, number>();
  for (const { values, dtype } of columns) for (const v of flatten(values)) {
    const x = Number(v), key = numeric(v, dtype) ? null : cell(v, dtype);
    count++;
    if (v == null) missing++;
    else if (key !== null) categories.set(key, (categories.get(key) ?? 0) + 1);
    else if (x !== x) nan++;
    else if (!isFinite(x)) inf++;
    else { finite++; sum += x; min = Math.min(min, x); max = Math.max(max, x); }
  }
  if (!finite) return { count, missing, NaN: nan, inf, unique:categories.size, top: [...categories].sort((a, b) => b[1] - a[1]).slice(0, 10) };
  const mean = sum / finite, width = (max - min) / bins || 1, histogram = new Array(bins).fill(0);
  let deviation = 0;
  for (const { values, dtype } of columns) for (const v of flatten(values)) {
    const x = Number(v);
    if (numeric(v, dtype) && isFinite(x)) { deviation += (x - mean) ** 2; histogram[Math.min(bins - 1, Math.floor((x - min) / width))]++; }
  }
  return { count, missing, NaN: nan, inf, finite, min, max, mean, std: Math.sqrt(deviation / finite), histogram };
}
