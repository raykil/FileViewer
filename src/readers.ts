import { readFile } from 'fs/promises';
import { basename, extname } from 'path';
import { unzipSync } from 'fflate';
import { asyncBufferFromFile, parquetMetadataAsync, parquetSchema } from 'hyparquet';
import { parquetReadColumn } from 'hyparquet/src/read.js';
import { compressors } from 'hyparquet-compressors';
import Papa from 'papaparse';
import { addUserStreamer, openFile } from 'jsroot/io';
import { TSelector, treeProcess } from 'jsroot/tree';
import { readHeaderFooter, rntupleProcess } from 'jsroot/rntuple';

addUserStreamer('ROOT::RNTuple', (buf: any, anchor: any) => {
  for (const key of ['fVersionEpoch', 'fVersionMajor', 'fVersionMinor', 'fVersionPatch']) anchor[key] = buf.ntou2();
  for (const key of ['fSeekHeader', 'fNBytesHeader', 'fLenHeader', 'fSeekFooter', 'fNBytesFooter', 'fLenFooter', 'fMaxKeySize']) anchor[key] = buf.ntou8();
  Object.assign(anchor, { $kind: 'ROOT::RNTuple', $file: buf.fFile });
});

export interface Field { name: string; dtype: string }
export interface Column extends Field { values: ArrayLike<any> }
export interface Table { name: string; dtype: string; shape: number[]; fields: Field[]; load: () => Promise<Column[]> }

const NUMPY: Record<string, any> = {
  f2: (globalThis as any).Float16Array, f4: Float32Array, f8: Float64Array,
  i1: Int8Array, i2: Int16Array, i4: Int32Array, i8: BigInt64Array,
  u1: Uint8Array, u2: Uint16Array, u4: Uint32Array, u8: BigUint64Array,
  M8: BigInt64Array, m8: BigInt64Array,
};

function numpyType(descr: string) {
  const [kind, bits] = [descr[1], 8 * parseInt(descr.slice(2))];
  const units = descr.slice(3);
  return ({ f: `float${bits}`, i: `int${bits}`, u: `uint${bits}`, b: 'bool', M: `datetime64${units}`, m: `timedelta64${units}` } as any)[kind] ?? descr;
}

function decode(descr: string, buffer: ArrayBuffer): ArrayLike<any> {
  const [kind, width] = [descr[1], parseInt(descr.slice(2))];
  if (descr[0] === '>') throw new Error(`big-endian dtype ${descr} is not supported`);
  if (kind === 'b') return Array.from(new Uint8Array(buffer), Boolean);
  if (kind === 'U' || kind === 'S') {
    const units = kind === 'U' ? new Uint32Array(buffer) : new Uint8Array(buffer);
    return Array.from({ length: units.length / width }, (_, i) => String.fromCodePoint(...units.subarray(i * width, (i + 1) * width)).replace(/\0+$/, ''));
  }
  if (!NUMPY[descr.slice(1, 3)]) throw new Error(`dtype ${descr} is not supported`);
  return new NUMPY[descr.slice(1, 3)](buffer);
}

function npy(name: string, bytes: Uint8Array): Table {
  const v1 = bytes[6] === 1, start = v1 ? 10 : 12;
  const end = start + new DataView(bytes.buffer, bytes.byteOffset)[v1 ? 'getUint16' : 'getUint32'](8, true);
  const header = new TextDecoder().decode(bytes.subarray(start, end));
  const descr = header.match(/'descr':\s*'([^']+)'/)?.[1] ?? header;
  const shape = [...header.match(/'shape':\s*\(([^)]*)\)/)![1].matchAll(/\d+/g)].map(Number);
  const [rows = 1, ...rest] = shape, width = rest.reduce((a, b) => a * b, 1), dtype = numpyType(descr);
  const load = async () => {
    const data: any = decode(descr, bytes.slice(end).buffer);
    const column = (j: number) => header.includes("'fortran_order': True")
      ? data.slice(j * rows, (j + 1) * rows)
      : data.constructor.from({ length: rows }, (_: any, i: number) => data[i * width + j]);
    return Array.from({ length: width }, (_, j) => ({ name: String(j), dtype, values: width === 1 ? data : column(j) }));
  };
  return { name, dtype, shape, fields: [], load };
}

const npz = async (path: string) =>
  Object.entries(unzipSync(await readFile(path))).map(([name, bytes]) => npy(name.replace(/\.npy$/, ''), bytes));

const PARQUET: Record<string, string> = { FLOAT: 'float32', DOUBLE: 'float64', INT32: 'int32', INT64: 'int64', BOOLEAN: 'bool', BYTE_ARRAY: 'bytes' };

async function parquet(path: string): Promise<Table[]> {
  const file = await asyncBufferFromFile(path), metadata = await parquetMetadataAsync(file);
  const fields = parquetSchema(metadata).children.map(({ element: e, children }) => {
    const type = e.logical_type?.type ?? e.converted_type ?? (children.length ? 'struct' : e.type!);
    return { name: e.name, dtype: PARQUET[type] ?? type.toLowerCase() };
  });
  const load = () => Promise.all(fields.map(async f => ({ ...f, values: await parquetReadColumn({ file, metadata, compressors, columns: [f.name] }) })));
  return [{ name: basename(path), dtype: 'parquet', shape: [Number(metadata.num_rows), fields.length], fields, load }];
}

async function csv(path: string): Promise<Table[]> {
  const [header = [], ...rows] = Papa.parse<any[]>(await readFile(path, 'utf8'), { dynamicTyping: true, skipEmptyLines: true }).data;
  const columns = header.map((name, j) => {
    const values = rows.map(r => r[j] ?? null);
    if (!values.every(v => v === null || typeof v === 'number')) return { name: String(name), dtype: 'string', values };
    return { name: String(name), dtype: values.every(v => v === null || Number.isInteger(v)) ? 'int' : 'float64', values: Float64Array.from(values, v => v ?? NaN) };
  });
  return [{ name: basename(path), dtype: 'csv', shape: [rows.length, columns.length], fields: columns.map(({ values, ...f }) => f), load: async () => columns }];
}

const LEAF: Record<string, string> = { F: 'float32', D: 'float64', f: 'float16', d: 'double32', I: 'int32', i: 'uint32', L: 'int64', l: 'uint64', S: 'int16', s: 'uint16', B: 'int8', b: 'uint8', O: 'bool', C: 'string' };
const branchType = (b: any) => {
  const [, dims = '', code] = b.fTitle.match(/(\[.*\])?\/(\w)$/) ?? [];
  return code ? LEAF[code] + dims : b.fClassName || b.fLeaves.arr[0]?._typename;
};

async function select(fields: Field[], branches: any[], process: (selector: any) => Promise<any>): Promise<Column[]> {
  const selector = new TSelector(), values = branches.map(() => [] as any[]);
  branches.forEach((b, i) => selector.addBranch(b, `b${i}`));
  selector.Process = function (this: any) { values.forEach((v, i) => v.push(this.tgtobj[`b${i}`])); };
  await process(selector);
  return fields.map((f, i) => ({ ...f, values: values[i] }));
}

function tree(name: string, t: any): Table {
  const leaves = (b: any): any[] => b.fBranches.arr.length ? b.fBranches.arr.flatMap(leaves) : [b];
  const branches = t.fBranches.arr.flatMap(leaves);
  const fields: Field[] = branches.map((b: any) => ({ name: b.fName, dtype: branchType(b) }));
  return { name, dtype: t._typename, shape: [t.fEntries, fields.length], fields, load: () => select(fields, branches, s => treeProcess(t, s)) };
}

async function rntuple(name: string, t: any): Promise<Table> {
  const { fieldDescriptors, clusterSummaries } = await readHeaderFooter(t);
  const fields: Field[] = fieldDescriptors.filter((f: any, i: number) => f.parentFieldId === i).map((f: any) => ({ name: f.fieldName, dtype: f.typeName }));
  const rows = clusterSummaries.reduce((sum: number, c: any) => sum + Number(c.numEntries), 0);
  return { name, dtype: 'RNTuple', shape: [rows, fields.length], fields, load: () => select(fields, fields.map(f => f.name), s => rntupleProcess(t, s)) };
}

function hist(name: string, h: any): Table {
  const { fNbins: n, fXmin: lo, fXmax: hi, fXbins: edges } = h.fXaxis;
  const bins = Array.from({ length: n }, (_, i) => i), edge = (i: number) => edges.length ? edges[i] : lo + i * (hi - lo) / n;
  const columns = Object.entries({
    low: bins.map(edge), high: bins.map(i => edge(i + 1)), content: bins.map(i => h.fArray[i + 1]),
    error: bins.map(i => Math.sqrt(h.fSumw2?.length ? h.fSumw2[i + 1] : Math.abs(h.fArray[i + 1]))),
  }).map(([name, values]) => ({ name, dtype: 'float64', values }));
  return { name, dtype: h._typename, shape: [n, columns.length], fields: columns.map(({ values, ...f }) => f), load: async () => columns };
}

async function root(path: string): Promise<Table[]> {
  const file = await openFile(path), tables: Table[] = [];
  const walk = async (dir: any, prefix: string) => {
    for (const { fName, fClassName } of new Map<string, any>(dir.fKeys.map((k: any) => [k.fName, k])).values()) {
      const name = prefix + fName;
      if (fClassName.startsWith('TDirectory')) await walk(await file.readDirectory(name), `${name}/`);
      else if (/^(TTree|TNtuple)/.test(fClassName)) tables.push(tree(name, await file.readObject(name)));
      else if (fClassName === 'ROOT::RNTuple') tables.push(await rntuple(name, await file.readObject(name)));
      else if (fClassName.startsWith('TH1')) tables.push(hist(name, await file.readObject(name)));
    }
  };
  await walk(file, '');
  return tables;
}

const READERS: Record<string, (path: string) => Promise<Table[]>> = {
  npz, parquet, parq: parquet, pq: parquet, root, csv, tsv: csv,
  npy: async path => [npy(basename(path), new Uint8Array(await readFile(path)))],
};

export const open = (path: string) => READERS[extname(path).slice(1).toLowerCase()]?.(path) ?? Promise.reject(new Error(`Unsupported file type: ${basename(path)}`));
