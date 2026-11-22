const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const compact = new Intl.NumberFormat('en', { notation: 'compact' });
const drop = Object.assign(document.createElement('div'), { id: 'drop' });

let tables = [], prefs = { decimals: '', font: 'mono', size: 200, left: 220, right: 280 }, active = null, dragged = null, nextId = 0;
const panes = new Map();

const fixed = v => prefs.decimals === '' ? +v.toPrecision(6) : v.toFixed(+prefs.decimals);
const format = (v, float) => Array.isArray(v) ? `[${v.map(x => format(x, float)).join(', ')}]`
  : typeof v === 'number' && float && prefs.decimals !== '' ? v.toFixed(+prefs.decimals) : String(v);
const paneOf = el => panes.get(+el.closest('.pane')?.dataset.id);
const status = (pane, text) => pane.el.querySelector('.status').textContent = text;
const request = (pane = active) => { status(pane, 'Loading…'); vscode.postMessage({ type: 'view', id: pane.id, ...pane.state, size: prefs.size }); };

function addPane() {
  const id = nextId++, el = $('pane-template').content.firstElementChild.cloneNode(true);
  el.dataset.id = id;
  panes.set(id, { id, el, state: { table: null, col: null, sort: null, desc: false, offset: 0 }, view: null });
  return panes.get(id);
}

function activate(pane) {
  active = pane;
  panes.forEach(p => p.el.classList.toggle('active', p === pane));
  renderActive();
}

function split(target, side) {
  const pane = addPane(), dir = side === 'left' || side === 'right' ? 'row' : 'column';
  if (target.parentElement.children.length > 1 && target.parentElement.style.flexDirection !== dir) {
    const wrap = Object.assign(document.createElement('div'), { className: 'split' });
    target.replaceWith(wrap);
    wrap.append(target);
  }
  target.parentElement.style.flexDirection = dir;
  target[side === 'left' || side === 'top' ? 'before' : 'after'](pane.el);
  return pane;
}

function close(pane) {
  const parent = pane.el.parentElement;
  pane.el.remove();
  panes.delete(pane.id);
  if (parent.children.length === 1 && parent.id !== 'panes') parent.replaceWith(parent.firstElementChild);
  if (pane === active) activate(panes.values().next().value);
}

function select(table, col) {
  const { state, el } = active;
  if (table !== state.table) Object.assign(state, { table, sort: null, offset: 0 });
  state.col = col ?? (tables[table].fields.length ? 0 : null);
  el.querySelector('.tab span').textContent = tables[table].name;
  request();
}

function selectKey(key) {
  const [table, col] = key.split(':');
  select(+table, col === undefined ? null : +col);
}

function go(offset) {
  active.state.offset = Math.max(0, Math.min(offset, (active.view?.total ?? 0) - prefs.size));
  request();
}

function setPrefs(changes) {
  Object.assign(prefs, changes);
  vscode.postMessage({ type: 'prefs', prefs });
  document.body.className = prefs.font;
  for (const key of ['decimals', 'font', 'size']) $(key).value = prefs[key];
  for (const pane of ['left', 'right']) document.body.style.setProperty(`--${pane}`, `${prefs[pane]}px`);
}

function renderTree() {
  const item = (name, key, cls) => `<div class="${cls}" data-key="${key}" title="${esc(name)}" draggable="true">${esc(name)}</div>`;
  const grouped = tables.some(t => t.file !== tables[0].file);
  $('tree').innerHTML = tables.map((t, i) => (grouped && t.file !== tables[i - 1]?.file ? `<h5>${esc(t.file)}</h5>` : '') + item(t.name, `${i}`, 'table') + t.fields.map((f, j) => item(f.name, `${i}:${j}`, 'field')).join('')).join('');
}

function renderGrid({ el, view: { columns, rows }, state }) {
  const arrow = j => state.sort === j ? (state.desc ? ' ▼' : ' ▲') : '';
  const sel = j => state.col === j ? ' class="sel"' : '';
  const frac = (v, j) => typeof v === 'number' ? format(v, columns[j].float).split('.')[1]?.length ?? -1 : -1;
  const places = columns.map((_, j) => Math.max(...rows.map(r => frac(r[j + 1], j))));
  const pad = (v, j) => typeof v === 'number' && places[j] >= 0 ? `<span class="pad">${'.'.padEnd(places[j] + 1, '0').slice(frac(v, j) + 1)}</span>` : '';
  el.querySelector('thead').innerHTML = `<tr><th>#</th>${columns.map((c, j) => `<th data-col="${j}" title="${esc(c.dtype)}"${sel(j)}>${esc(c.name)}${arrow(j)}</th>`).join('')}</tr>`;
  el.querySelector('tbody').innerHTML = rows.map(([r, ...cells]) => `<tr><th>${r}</th>${cells.map((v, j) =>
    `<td data-col="${j}" class="${typeof v === 'number' ? 'num' : v === null ? 'null' : ''}${state.col === j ? ' sel' : ''}">${esc(format(v, columns[j].float))}${pad(v, j)}</td>`).join('')}</tr>`).join('');
}

function histogram(counts, min, max) {
  const [W, H, L, R, T, B] = [260, 170, 46, 10, 8, 40], plotW = W - L - R, plotH = H - T - B;
  const peak = Math.max(...counts) || 1, barW = plotW / counts.length, y = c => T + plotH * (1 - c / peak);
  const edge = i => min + (max - min) * i / counts.length;
  const bars = counts.map((c, i) => `<rect x="${L + i * barW}" y="${y(c)}" width="${Math.max(barW - 1, 0.5)}" height="${T + plotH - y(c)}"><title>[${fixed(edge(i))}, ${fixed(edge(i + 1))}): ${c}</title></rect>`);
  const xTicks = [[0, 'start'], [0.5, 'middle'], [1, 'end']].map(([f, anchor]) => `<line x1="${L + f * plotW}" x2="${L + f * plotW}" y1="${T + plotH}" y2="${T + plotH + 4}"/><text x="${L + f * plotW}" y="${T + plotH + 15}" text-anchor="${anchor}">${fixed(min + f * (max - min))}</text>`);
  const yTicks = [0, 0.5, 1].map(f => `<line x1="${L - 4}" x2="${L}" y1="${y(f * peak)}" y2="${y(f * peak)}"/><text x="${L - 6}" y="${y(f * peak) + 3}" text-anchor="end">${compact.format(Math.round(f * peak))}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}">${bars.join('')}<path d="M${L} ${T}V${T + plotH}H${L + plotW}"/>${xTicks.join('')}${yTicks.join('')}
    <text class="axis" x="${L + plotW / 2}" y="${H - 4}" text-anchor="middle">value</text>
    <text class="axis" transform="translate(11 ${T + plotH / 2}) rotate(-90)" text-anchor="middle">count</text></svg>`;
}

function renderActive() {
  const { view, state } = active;
  for (const el of $('tree').children) el.classList.toggle('active', [`${state.table}`, `${state.table}:${state.col}`].includes(el.dataset.key));
  if (!view) return;
  const { stats: { histogram: counts, top, ...values }, columns, rows, total, offset } = view, t = tables[state.table], c = columns[state.col];
  const row = (k, v) => `<div class="row"><span>${esc(k)}</span><span class="value">${esc(v)}</span></div>`;
  const shape = c ? [] : [row('Shape', t.shape.join(' × ') || 'scalar')];
  $('range').textContent = `${rows.length ? offset + 1 : 0}–${offset + rows.length} of ${total.toLocaleString()}`;
  $('start').value = offset + 1;
  $('stats').innerHTML = `<h3>${esc(c?.name ?? t.name)}</h3><small>${esc(c?.dtype ?? t.dtype)}</small>`
    + shape.concat(Object.entries(values).map(([k, v]) => row(k[0].toUpperCase() + k.slice(1), Number.isInteger(v) ? v : fixed(v)))).join('')
    + (counts ? histogram(counts, values.min, values.max) : '')
    + (top?.length ? `<h4>Most frequent</h4>${top.map(([k, n]) => row(k, n)).join('')}` : '');
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'init') {
    tables = data.tables;
    $('title').textContent = `${data.name} · ${tables.length} ${tables.length === 1 ? 'table' : 'tables'}`;
    setPrefs(data.prefs ?? {});
    renderTree();
    tables.length ? select(0) : status(active, 'No readable tables in this file.');
  }
  if (data.type === 'add' && data.tables.length) {
    tables.push(...data.tables);
    renderTree();
    activate(split(active.el, 'right'));
    select(tables.length - data.tables.length);
  }
  if (data.type === 'view' && panes.has(data.id)) {
    const pane = panes.get(data.id);
    pane.view = data;
    status(pane, '');
    renderGrid(pane);
    pane === active && renderActive();
  }
  if (data.type === 'error') status(panes.get(data.id) ?? active, `Error: ${data.message}`);
});

$('tree').onclick = e => { const key = e.target.closest('[data-key]')?.dataset.key; key && selectKey(key); };
$('tree').ondragstart = e => dragged = e.target.dataset.key;
$('panes').onclick = e => {
  const pane = paneOf(e.target), col = e.target.closest('[data-col]')?.dataset.col;
  if (!pane) return;
  if (e.target.closest('.close')) return close(pane);
  activate(pane);
  if (col === undefined) return;
  if (!e.target.closest('thead')) return select(pane.state.table, +col);
  const { state } = pane, desc = state.sort === +col && !state.desc, cleared = state.sort === +col && state.desc;
  Object.assign(state, { sort: cleared ? null : +col, desc, offset: 0 });
  request();
};
document.ondragover = e => {
  const el = dragged && e.target.closest('.pane');
  if (!el) return drop.remove();
  e.preventDefault();
  const { left, top, width, height } = el.getBoundingClientRect(), x = (e.clientX - left) / width, y = (e.clientY - top) / height;
  const [side, distance] = Object.entries({ left: x, right: 1 - x, top: y, bottom: 1 - y }).reduce((a, b) => b[1] < a[1] ? b : a);
  drop.className = distance < 1 / 3 ? side : '';
  if (drop.parentElement !== el) el.append(drop);
};
document.ondrop = () => {
  const target = drop.parentElement;
  if (!target) return;
  activate(drop.className ? split(target, drop.className) : paneOf(target));
  drop.remove();
  selectKey(dragged);
};
document.ondragend = () => { dragged = null; drop.remove(); };
$('decimals').onchange = e => { setPrefs({ decimals: e.target.value }); panes.forEach(p => p.view && renderGrid(p)); renderActive(); };
$('path').onkeydown = e => { if (e.key === 'Enter') vscode.postMessage({ type: 'open', path: e.target.value.trim() }); };
$('font').onchange =e => setPrefs({ font: e.target.value });
$('size').onchange = e => { setPrefs({ size: Math.max(1, +e.target.value || 200) }); panes.forEach(p => request(p)); };
$('start').onchange = e => go(+e.target.value - 1);
$('first').onclick = () => go(0);
$('prev').onclick = () => go(active.state.offset - prefs.size);
$('next').onclick = () => go(active.state.offset + prefs.size);
$('last').onclick = () => go(Infinity);
for (const sash of document.querySelectorAll('.sash')) {
  const pane = sash.dataset.pane, width = e => Math.max(100, pane === 'left' ? e.clientX : innerWidth - e.clientX);
  sash.onmousedown = e => e.preventDefault();
  sash.onpointerdown = e => sash.setPointerCapture(e.pointerId);
  sash.onpointermove = e => sash.hasPointerCapture(e.pointerId) && document.body.style.setProperty(`--${pane}`, `${width(e)}px`);
  sash.onpointerup = e => setPrefs({ [pane]: width(e) });
}

activate(addPane());
$('panes').append(active.el);
vscode.postMessage({ type: 'ready' });
