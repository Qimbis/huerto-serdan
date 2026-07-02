import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ============================================================
// Config check — full-screen notice if config.js still has placeholders
// ============================================================
const CONFIG_IS_PLACEHOLDER = SUPABASE_URL === 'PON_AQUI_TU_URL' || SUPABASE_ANON_KEY === 'PON_AQUI_TU_ANON_KEY';

if (CONFIG_IS_PLACEHOLDER) {
  document.body.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-6">
      <div class="max-w-md text-center space-y-3">
        <i data-lucide="settings" class="w-10 h-10 mx-auto text-amber-400"></i>
        <h1 class="text-xl font-semibold">Falta configurar la conexión</h1>
        <p class="text-sm text-slate-400">Esta aplicación necesita conectarse a la base de datos antes de usarse. Sigue las instrucciones en <code class="text-emerald-400">SETUP.md</code> y completa <code class="text-emerald-400">config.js</code> con los datos de tu proyecto Supabase.</p>
      </div>
    </div>
  `;
  lucide.createIcons();
  throw new Error('config.js not configured');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// Static Spanish labels (data keys stay English, see ROADMAP.md)
// ============================================================
const STAGE_LABELS = { Producing: 'Produciendo', Young: 'Joven' };
const labelForStage = s => STAGE_LABELS[s] || s;

const LOG_TYPE_LABELS = {
  'Fertilization': 'Fertilización',
  'Gopher Loss': 'Pérdida por topo',
  'Graft Rejected': 'Injerto rechazado',
  'Variety Confirmed': 'Variedad confirmada',
  'Pruning': 'Poda',
  'Frost/Hail Damage': 'Daño por helada/granizo',
  'Tree State': 'Estado de árboles',
  'Health': 'Salud',
  'Census': 'Censo',
  'Other': 'Otro',
};
const labelForLogType = t => LOG_TYPE_LABELS[t] || t;
// 'Tree State' / 'Health' / 'Census' events carry tree positions, so they
// are created from the tree grid or census flow, not the history dropdown
const LOG_TYPES = Object.keys(LOG_TYPE_LABELS).filter(t => !['Tree State', 'Health', 'Census'].includes(t));

// Per-tree alive-state ('Tree State' events) — data keys English, labels Spanish
const TREE_STATE_LABELS = {
  'ok': 'Bien',
  'graft-rejected': 'Injerto rechazado',
  'lost-gopher': 'Perdido (topo)',
  'replanted': 'Replantado',
  'empty': 'Vacío',
};
const TREE_STATE_CLASSES = {
  'ok': 'bg-emerald-700/80 border-emerald-500 text-emerald-100',
  'graft-rejected': 'bg-amber-700/80 border-amber-500 text-amber-100',
  'lost-gopher': 'bg-red-700/80 border-red-500 text-red-100',
  'replanted': 'bg-sky-700/80 border-sky-500 text-sky-100',
  'empty': 'bg-slate-800 border-slate-600 text-slate-500',
};

// Per-tree health ('Health' events)
const HEALTH_LABELS = {
  'healthy': 'Sano',
  'stressed': 'Estresado',
  'diseased': 'Enfermo',
  'pest': 'Plaga',
  'recovering': 'En recuperación',
};
const HEALTH_DOT_CLASSES = {
  'stressed': 'bg-amber-400',
  'diseased': 'bg-red-400',
  'pest': 'bg-fuchsia-400',
  'recovering': 'bg-sky-400',
  // 'healthy' draws no dot — it is the quiet default
};
const labelForTreeState = s => TREE_STATE_LABELS[s] || s;
const labelForHealth = s => HEALTH_LABELS[s] || s;

// Loss/replant report — cause colors match the tree-grid entities but use
// darker steps validated for contrast + CVD separation on the slate surfaces
const LOSS_CAUSE_META = {
  'lost-gopher':    { label: 'Perdido (topo)',    color: '#ef4444' },
  'graft-rejected': { label: 'Injerto rechazado', color: '#d97706' },
  'replanted':      { label: 'Replantado',        color: '#0284c7' },
};
const LOSS_CAUSES = Object.keys(LOSS_CAUSE_META);

const TASK_STATUS_LABELS = { Pending: 'Pendiente', 'In Progress': 'En progreso', Completed: 'Completada' };
const labelForStatus = s => TASK_STATUS_LABELS[s] || s;

const TASK_CATEGORY_LABELS = {
  'Pruning': 'Poda',
  'Bordelesa Paste': 'Pasta bordelesa',
  'Structural Maintenance': 'Mantenimiento estructural',
  'Grafting': 'Injerto',
  'Fertilization': 'Fertilización',
  'Other': 'Otro',
};
const labelForCategory = c => TASK_CATEGORY_LABELS[c] || c;
const TASK_CATEGORIES = Object.keys(TASK_CATEGORY_LABELS);

// ============================================================
// In-memory data (assembled from Supabase after login)
// ============================================================
let VARIETIES = {};
let SECTIONS = {};
let ORCHARD_DATA = {
  orchard: {
    name: 'Huerto Serdán',
    location: 'Ciudad Serdán, Puebla, México',
    structure: 'Estructura protectora de arco gótico sobre columnas de concreto',
  },
  inventory: { targetTrees: 1000 },
  rows: [],
  tasks: [],
};

let showOnlyUnconfirmed = false;
let showNewTaskForm = false;
let currentUser = null;
let lastFetchAt = 0;
const REFETCH_THROTTLE_MS = 30_000;

function rowsBySection(sectionId) {
  return ORCHARD_DATA.rows.filter(r => r.sectionId === sectionId);
}

// Derive per-tree state from the append-only event log. Position N's state
// is the status of the latest 'Tree State' event covering N (default 'ok');
// health likewise from 'Health' events; replantedAt is the date of the most
// recent replant, which (falling back to the row's plantedAt) gives the
// tree's effective age. row.log is already sorted oldest→newest.
function deriveTreePositions(row) {
  const n = row.treeCount;
  const states = Array(n).fill('ok');
  const health = Array(n).fill('healthy');
  const replantedAt = Array(n).fill(null);
  for (const e of row.log) {
    if (!e.positions || !e.status) continue;
    for (const p of e.positions) {
      if (p < 1 || p > n) continue; // event predates a count correction
      if (e.type === 'Tree State') {
        states[p - 1] = e.status;
        if (e.status === 'replanted') replantedAt[p - 1] = e.date;
      } else if (e.type === 'Health') {
        health[p - 1] = e.status;
      }
    }
  }
  return { states, health, replantedAt };
}

function stageBadgeClass(stage) {
  return stage === 'Producing'
    ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700'
    : 'bg-amber-900/50 text-amber-300 border-amber-700';
}

function varietyBadge(key, count, { size = 'sm' } = {}) {
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs';
  const v = VARIETIES[key] || VARIETIES.unconfirmed;
  return `<span class="inline-flex items-center gap-1 rounded-full ${padding} font-medium text-slate-900"
                style="background-color:${v.color}">
            ${esc(v.label)} · ${count}
          </span>`;
}

function showSaveError(msg) {
  const indicator = $('#save-indicator');
  if (indicator) indicator.textContent = msg;
  alert(msg);
}

// ---------- Weather (Open-Meteo, live) — unchanged from Phase 1 ----------
const WEATHER_CACHE_KEY = 'orchardWeatherCache';
const WEATHER_LAT = 18.99;
const WEATHER_LON = -97.45;
const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current_weather=true&hourly=temperature_2m,weathercode&forecast_days=3&timezone=America%2FMexico_City`;

function frostRiskFromMin(minTemp) {
  if (minTemp <= 0) return { level: 'Alto', color: 'text-red-400' };
  if (minTemp <= 3) return { level: 'Moderado', color: 'text-amber-400' };
  return { level: 'Bajo', color: 'text-emerald-400' };
}

function hailRiskFromCodes(codes) {
  if (codes.some(c => c === 96 || c === 99)) return { level: 'Aviso de granizo', color: 'text-red-400' };
  if (codes.some(c => c === 95)) return { level: 'Tormenta posible', color: 'text-amber-400' };
  return { level: 'Sin aviso', color: 'text-emerald-400' };
}

function deriveWeatherView(data) {
  const current = data.current_weather;
  const hourly = data.hourly;
  const nowIndex = hourly.time.indexOf(current.time.slice(0, 13) + ':00');
  const startIndex = nowIndex >= 0 ? nowIndex : 0;
  const next48Temps = hourly.temperature_2m.slice(startIndex, startIndex + 48);
  const next48Codes = hourly.weathercode.slice(startIndex, startIndex + 48);
  const minTemp = Math.min(...next48Temps);

  return {
    temperatureC: current.temperature,
    windSpeedKmh: current.windspeed,
    frost: frostRiskFromMin(minTemp),
    minTemp,
    hail: hailRiskFromCodes(next48Codes),
  };
}

function loadWeatherCache() {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveWeatherCache(data) {
  localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ data, fetchedAt: new Date().toISOString() }));
}

function renderClimateView(view, { live, staleLabel }) {
  const badge = live
    ? `<span class="text-[11px] px-2 py-0.5 rounded-full border border-emerald-700 bg-emerald-900/40 text-emerald-300">En vivo</span>`
    : `<span class="text-[11px] px-2 py-0.5 rounded-full border border-amber-700 bg-amber-900/40 text-amber-300">${esc(staleLabel)}</span>`;

  $('#climate-panel').innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h2 class="font-semibold flex items-center gap-1.5">
        <i data-lucide="cloud-sun" class="w-4 h-4 text-slate-400"></i> Alerta climática
      </h2>
      ${badge}
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
      <div class="rounded-lg bg-slate-900/60 border border-slate-700 py-3">
        <i data-lucide="thermometer" class="w-4 h-4 mx-auto mb-1 text-slate-400"></i>
        <div class="text-xl font-semibold">${view.temperatureC}°C</div>
        <div class="text-[11px] text-slate-400">Temperatura</div>
      </div>
      <div class="rounded-lg bg-slate-900/60 border border-slate-700 py-3">
        <i data-lucide="snowflake" class="w-4 h-4 mx-auto mb-1 text-slate-400"></i>
        <div class="text-xl font-semibold ${view.frost.color}">${view.frost.level}</div>
        <div class="text-[11px] text-slate-400">Riesgo de helada · mín. ${view.minTemp}°C (48h)</div>
      </div>
      <div class="rounded-lg bg-slate-900/60 border border-slate-700 py-3">
        <i data-lucide="wind" class="w-4 h-4 mx-auto mb-1 text-slate-400"></i>
        <div class="text-xl font-semibold">${view.windSpeedKmh} km/h</div>
        <div class="text-[11px] text-slate-400">Velocidad del viento</div>
      </div>
      <div class="rounded-lg bg-slate-900/60 border border-slate-700 py-3">
        <i data-lucide="cloud-hail" class="w-4 h-4 mx-auto mb-1 text-slate-400"></i>
        <div class="text-xl font-semibold ${view.hail.color}">${view.hail.level}</div>
        <div class="text-[11px] text-slate-400">Aviso de granizo (próx. 48h)</div>
      </div>
    </div>
    <p class="text-[11px] text-slate-500 mt-2">Usa estas lecturas para decidir si desplegar o revisar las cubiertas del arco gótico.</p>
  `;
}

function renderClimateError() {
  $('#climate-panel').innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <h2 class="font-semibold flex items-center gap-1.5">
        <i data-lucide="cloud-sun" class="w-4 h-4 text-slate-400"></i> Alerta climática
      </h2>
      <span class="text-[11px] px-2 py-0.5 rounded-full border border-red-700 bg-red-900/40 text-red-300">Sin datos</span>
    </div>
    <p class="text-sm text-slate-400">No se pudo obtener el clima y no hay datos guardados anteriores. Revisa la conexión e intenta de nuevo más tarde.</p>
  `;
  lucide.createIcons();
}

async function loadClimate() {
  const cache = loadWeatherCache();
  try {
    const res = await fetch(WEATHER_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    saveWeatherCache(data);
    renderClimateView(deriveWeatherView(data), { live: true });
  } catch (e) {
    console.error('Weather fetch failed', e);
    if (cache) {
      const fetchedDate = new Date(cache.fetchedAt);
      const staleLabel = `Datos de ${fetchedDate.toLocaleDateString('es-MX')} ${fetchedDate.toLocaleTimeString('es-MX')} — sin conexión`;
      renderClimateView(deriveWeatherView(cache.data), { live: false, staleLabel });
    } else {
      renderClimateError();
    }
  }
  lucide.createIcons();
}

// ---------- Rows / map tab ----------
function renderMap() {
  const legend = Object.values(VARIETIES).map(v =>
    `<span class="inline-flex items-center gap-1.5 text-xs text-slate-300">
       <span class="w-2.5 h-2.5 rounded-full inline-block" style="background-color:${v.color}"></span>${esc(v.label)}
     </span>`
  ).join('');

  const filterToggle = `
    <label class="flex items-center gap-2 text-xs text-slate-300 px-1 tap-target cursor-pointer">
      <input id="unconfirmed-filter" type="checkbox" class="w-4 h-4 rounded border-slate-600 bg-slate-900" ${showOnlyUnconfirmed ? 'checked' : ''} />
      Solo por confirmar
    </label>
  `;

  const sections = Object.values(SECTIONS).map(section => {
    let rows = rowsBySection(section.id);
    if (showOnlyUnconfirmed) rows = rows.filter(r => r.variety === 'unconfirmed');
    if (rows.length === 0) return '';

    const sectionTotal = rowsBySection(section.id).reduce((sum, r) => sum + r.treeCount, 0);
    const unconfirmedCount = rowsBySection(section.id).filter(r => r.variety === 'unconfirmed').length;

    const rowCards = rows.map(row => `
      <button data-row-id="${row.id}" class="row-card w-full text-left tap-target rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700/70 active:bg-slate-700 transition p-3 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="font-semibold">Hilera ${row.id}</span>
          <span class="text-xs px-2 py-0.5 rounded-full border ${stageBadgeClass(section.stage)}">${labelForStage(section.stage)}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${varietyBadge(row.variety, row.treeCount)}
          ${row.variety === 'unconfirmed' ? `<span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium border border-amber-600 text-amber-400">Variedad por confirmar</span>` : ''}
        </div>
      </button>
    `).join('');

    return `
      <div>
        <div class="flex items-baseline justify-between px-1 mb-2">
          <h3 class="font-semibold text-slate-200">${esc(section.name)} <span class="text-xs font-normal text-slate-500">— ${esc(section.description)}</span></h3>
          <span class="text-xs text-slate-400 shrink-0 ml-2 flex items-center gap-2">
            ${unconfirmedCount > 0 ? `<span class="px-1.5 py-0.5 rounded-full border border-amber-600 text-amber-400 text-[11px]">${unconfirmedCount} por confirmar</span>` : ''}
            ${sectionTotal} árboles
          </span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${rowCards}</div>
      </div>
    `;
  }).join('');

  const emptyState = (!sections.trim())
    ? `<p class="text-sm text-slate-500 italic px-1">No hay hileras que coincidan con el filtro.</p>`
    : '';

  $('#tab-map').innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3 px-1">
      <div class="flex flex-wrap gap-3">${legend}</div>
      ${filterToggle}
    </div>
    ${sections}
    ${emptyState}
  `;

  $$('.row-card').forEach(btn =>
    btn.addEventListener('click', () => openRowDetail(Number(btn.dataset.rowId)))
  );
  $('#unconfirmed-filter').addEventListener('change', e => {
    showOnlyUnconfirmed = e.target.checked;
    renderMap();
  });
}

function openRowDetail(rowId) {
  const row = ORCHARD_DATA.rows.find(r => r.id === rowId);
  const section = SECTIONS[row.sectionId];
  const today = new Date().toISOString().slice(0, 10);

  $('#row-detail-panel').innerHTML = `
    <div class="p-5 space-y-4">
      <div class="flex items-start justify-between">
        <div>
          <h3 class="text-xl font-semibold">Hilera ${row.id}</h3>
          <p class="text-sm text-slate-400">${esc(section.name)} · ${row.treeCount} árboles</p>
        </div>
        <button id="close-row-detail" class="tap-target p-2 -m-2 text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>

      <div class="flex flex-wrap gap-2">
        <span class="inline-block text-xs px-2 py-1 rounded-full border ${stageBadgeClass(section.stage)}">${labelForStage(section.stage)}</span>
        ${row.variety === 'unconfirmed' ? `<span class="inline-block text-xs px-2 py-1 rounded-full border border-amber-600 text-amber-400">Variedad por confirmar</span>` : ''}
      </div>

      <div class="grid grid-cols-2 gap-3">
        <label class="text-xs text-slate-400 block">
          Variedad
          <select data-field="variety" class="tap-target mt-1 w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100">
            ${Object.entries(VARIETIES).map(([key, v]) => `<option value="${key}" ${key === row.variety ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
          </select>
        </label>
        <label class="text-xs text-slate-400 block">
          Número de árboles
          <input data-field="treeCount" type="number" min="0" value="${row.treeCount}"
                 class="tap-target mt-1 w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
        </label>
      </div>

      <label class="text-xs text-slate-400 block">
        Edad (años)
        <input data-field="age" type="number" min="0" value="${row.age}"
               class="tap-target mt-1 w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
      </label>

      <label class="text-xs text-slate-400 block">
        Notas
        <textarea data-field="notes" rows="2" placeholder="Notas generales sobre esta hilera..."
                  class="mt-1 w-full rounded-md bg-slate-900 border border-slate-600 px-2 py-1.5 text-sm text-slate-100">${esc(row.notes || '')}</textarea>
      </label>

      ${renderTreeGrid(row)}

      <div>
        <h4 class="text-sm font-medium text-slate-300 mb-2">Historial</h4>
        <div class="space-y-1.5 max-h-40 overflow-y-auto mb-3">
          ${row.log.length === 0
            ? `<p class="text-xs text-slate-500 italic">Sin entradas todavía</p>`
            : [...row.log].reverse().map(entry => `
                <div class="text-xs border border-slate-700 rounded-md px-2 py-1.5">
                  <span class="text-slate-500">${esc(entry.date)}</span>
                  <span class="text-slate-300 font-medium ml-1">${esc(labelForLogType(entry.type))}</span>
                  ${entry.status ? `<span class="text-slate-400 ml-1">— ${esc(entry.type === 'Health' ? labelForHealth(entry.status) : labelForTreeState(entry.status))}</span>` : ''}
                  ${entry.positions?.length ? `<p class="text-slate-500 mt-0.5">Árboles: ${entry.positions.join(', ')}</p>` : ''}
                  ${entry.text ? `<p class="text-slate-400 mt-0.5">${esc(entry.text)}</p>` : ''}
                </div>
              `).join('')}
        </div>
        <div class="grid grid-cols-2 gap-2">
          <input id="log-date" type="date" value="${today}" class="tap-target rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
          <select id="log-type" class="tap-target rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100">
            ${LOG_TYPES.map(t => `<option value="${t}">${esc(labelForLogType(t))}</option>`).join('')}
          </select>
        </div>
        <input id="log-text" type="text" placeholder="Detalles (opcional)"
               class="tap-target mt-2 w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
        <button id="add-log-entry" class="tap-target mt-2 w-full rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium">
          Agregar entrada
        </button>
      </div>
    </div>
  `;
  lucide.createIcons();
  $('#row-detail-backdrop').classList.remove('hidden');
  $('#close-row-detail').addEventListener('click', closeRowDetail);
  wireTreeGrid(row);

  $$('[data-field]', $('#row-detail-panel')).forEach(el => {
    el.addEventListener('change', () => {
      const field = el.dataset.field;

      if (field === 'variety') {
        const newVariety = el.value;
        const oldVariety = row.variety;
        if (newVariety === oldVariety) return;

        if (oldVariety !== 'unconfirmed') {
          const msg = newVariety === 'unconfirmed'
            ? '¿Marcar la variedad de esta hilera como no confirmada?'
            : '¿Corregir la variedad de esta hilera?';
          if (!confirm(msg)) {
            el.value = oldVariety;
            return;
          }
        }

        const wasUnconfirmed = oldVariety === 'unconfirmed';
        const today2 = new Date().toISOString().slice(0, 10);
        const patch = { variety_key: newVariety };
        if (newVariety === 'unconfirmed') {
          patch.variety_confirmed_at = null;
        } else if (wasUnconfirmed) {
          patch.variety_confirmed_at = today2;
        }

        updateRowRemote(row, patch, () => {
          row.variety = newVariety;
          if (newVariety === 'unconfirmed') {
            delete row.varietyConfirmedAt;
          } else if (wasUnconfirmed) {
            row.varietyConfirmedAt = today2;
          }
        }, () => { el.value = oldVariety; }).then(ok => {
          if (ok && wasUnconfirmed && newVariety !== 'unconfirmed') {
            insertRowEventRemote(row, { date: today2, type: 'Variety Confirmed', text: VARIETIES[newVariety].label });
          }
        });
        return;
      }

      const dbField = { treeCount: 'tree_count', age: 'age', notes: 'notes' }[field];
      const value = (field === 'age' || field === 'treeCount') ? Math.max(0, Number(el.value) || 0) : el.value;
      const oldValue = row[field];

      updateRowRemote(row, { [dbField]: value }, () => {
        row[field] = value;
      }, () => { el.value = oldValue; });
    });
  });
  $('#add-log-entry').addEventListener('click', () => {
    const entry = { date: $('#log-date').value || today, type: $('#log-type').value, text: $('#log-text').value.trim() };
    insertRowEventRemote(row, entry);
  });
}

// Core write helpers (no UI side effects) — shared by the row-detail modal
// and the census flow.
async function updateRowCore(row, patch) {
  const { error } = await supabase.from('rows').update(patch).eq('id', row.id);
  if (error) {
    console.error('Row update failed', error);
    return false;
  }
  return true;
}

async function insertRowEventCore(row, entry) {
  const payload = {
    row_id: row.id,
    event_date: entry.date,
    type: entry.type,
    note: entry.text || '',
    tree_positions: entry.positions || null,
    status: entry.status || null,
    created_by: currentUser?.id ?? null,
  };
  const { data, error } = await supabase.from('row_events').insert(payload).select().single();
  if (error) {
    console.error('Row event insert failed', error);
    return false;
  }
  row.log.push({
    date: data.event_date, type: data.type, text: data.note,
    positions: data.tree_positions || undefined,
    status: data.status || undefined,
  });
  return true;
}

async function updateRowRemote(row, patch, onSuccess, onFailure) {
  const ok = await updateRowCore(row, patch);
  if (!ok) {
    if (onFailure) onFailure();
    showSaveError('No se pudo guardar el cambio — revisa tu conexión e intenta de nuevo.');
    renderMap(); renderInventory(); openRowDetail(row.id);
    return false;
  }
  onSuccess();
  markSaved();
  renderMap();
  renderInventory();
  openRowDetail(row.id);
  return true;
}

async function insertRowEventRemote(row, entry) {
  const ok = await insertRowEventCore(row, entry);
  if (!ok) {
    showSaveError('No se pudo guardar la entrada del historial — revisa tu conexión e intenta de nuevo.');
    return;
  }
  markSaved();
  renderInventory(); // loss report reflects new tree-state events immediately
  openRowDetail(row.id);
}

function closeRowDetail() {
  $('#row-detail-backdrop').classList.add('hidden');
}

// ---------- Per-tree grid (Fase 3: estado y salud por árbol) ----------
function renderTreeGrid(row) {
  const { states, health, replantedAt } = deriveTreePositions(row);

  const cells = Array.from({ length: row.treeCount }, (_, i) => {
    const p = i + 1;
    const state = states[i];
    const h = health[i];
    const dot = HEALTH_DOT_CLASSES[h]
      ? `<span class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${HEALTH_DOT_CLASSES[h]}"></span>`
      : '';
    const planted = replantedAt[i] || row.plantedAt;
    const title = `Árbol ${p} — ${labelForTreeState(state)} · ${labelForHealth(h)}${planted ? ` · plantado ${planted}` : ''}`;
    return `<button data-pos="${p}" title="${esc(title)}"
                    class="tree-cell relative w-9 h-9 rounded border text-[11px] font-medium transition
                           ${TREE_STATE_CLASSES[state] || TREE_STATE_CLASSES.ok}">${p}${dot}</button>`;
  }).join('');

  const legend = Object.entries(TREE_STATE_LABELS).map(([key, label]) =>
    `<span class="inline-flex items-center gap-1 text-[11px] text-slate-400">
       <span class="w-2.5 h-2.5 rounded border inline-block ${TREE_STATE_CLASSES[key]}"></span>${esc(label)}
     </span>`
  ).join('');

  const stateButtons = Object.entries(TREE_STATE_LABELS).map(([key, label]) =>
    `<button data-tree-state="${key}" class="tap-target rounded-md border px-2 py-1.5 text-xs font-medium ${TREE_STATE_CLASSES[key]}">${esc(label)}</button>`
  ).join('');

  const healthButtons = Object.entries(HEALTH_LABELS).map(([key, label]) =>
    `<button data-tree-health="${key}" class="tap-target rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs font-medium text-slate-200">${esc(label)}</button>`
  ).join('');

  return `
    <div>
      <h4 class="text-sm font-medium text-slate-300 mb-1">Árboles <span class="text-xs font-normal text-slate-500">— toca uno o varios para marcar</span></h4>
      <div class="flex flex-wrap gap-2 mb-2">${legend}</div>
      <div id="tree-grid" class="flex flex-wrap gap-1">${cells}</div>
      <div id="tree-actions" class="hidden mt-3 rounded-lg border border-slate-600 bg-slate-900/70 p-3 space-y-2">
        <div class="text-xs text-slate-400"><span id="tree-selected-count"></span> seleccionado(s)</div>
        <div class="text-[11px] text-slate-500">Estado</div>
        <div class="flex flex-wrap gap-1.5">${stateButtons}</div>
        <div class="text-[11px] text-slate-500">Salud</div>
        <div class="flex flex-wrap gap-1.5">${healthButtons}</div>
        <input id="tree-note" type="text" placeholder="Detalles (opcional)"
               class="tap-target w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
        <button id="tree-cancel" class="tap-target w-full rounded-md bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium">Cancelar selección</button>
      </div>
    </div>
  `;
}

function wireTreeGrid(row) {
  const grid = $('#tree-grid');
  if (!grid) return;
  const selected = new Set();

  const syncUi = () => {
    $$('.tree-cell', grid).forEach(cell => {
      const p = Number(cell.dataset.pos);
      cell.classList.toggle('ring-2', selected.has(p));
      cell.classList.toggle('ring-white', selected.has(p));
    });
    $('#tree-actions').classList.toggle('hidden', selected.size === 0);
    $('#tree-selected-count').textContent = selected.size;
  };

  $$('.tree-cell', grid).forEach(cell => {
    cell.addEventListener('click', () => {
      const p = Number(cell.dataset.pos);
      if (selected.has(p)) selected.delete(p); else selected.add(p);
      syncUi();
    });
  });

  const apply = (type, status) => {
    if (selected.size === 0) return;
    insertRowEventRemote(row, {
      date: new Date().toISOString().slice(0, 10),
      type,
      status,
      positions: [...selected].sort((a, b) => a - b),
      text: $('#tree-note').value.trim(),
    });
    // insertRowEventRemote re-renders the panel, which clears the selection
  };

  $$('[data-tree-state]').forEach(btn =>
    btn.addEventListener('click', () => apply('Tree State', btn.dataset.treeState)));
  $$('[data-tree-health]').forEach(btn =>
    btn.addEventListener('click', () => apply('Health', btn.dataset.treeHealth)));
  $('#tree-cancel').addEventListener('click', () => { selected.clear(); syncUi(); });
}

// ---------- Census tab (Fase 3/4: censo árbol por árbol) ----------
const CENSUS_STASH_KEY = 'orchardCensusProgress';

// { rowId, pos, answers: { [pos]: {state, health, note} | null (= saltado) } }
let censusSession = null;

function saveCensusStash() {
  try { localStorage.setItem(CENSUS_STASH_KEY, JSON.stringify(censusSession)); } catch (e) { /* full/blocked storage: stash is best-effort */ }
}
function clearCensusStash() {
  censusSession = null;
  localStorage.removeItem(CENSUS_STASH_KEY);
}
function loadCensusStash() {
  try {
    const raw = localStorage.getItem(CENSUS_STASH_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const row = ORCHARD_DATA.rows.find(r => r.id === s.rowId);
    if (!row || s.pos < 1) return null;
    return s;
  } catch (e) {
    return null;
  }
}

function lastCensusDate(row) {
  let last = null;
  for (const e of row.log) if (e.type === 'Census') last = e.date; // log is oldest→newest
  return last;
}

function renderCensus() {
  const panel = $('#tab-census');
  if (!panel) return;
  if (censusSession) {
    const row = ORCHARD_DATA.rows.find(r => r.id === censusSession.rowId);
    if (!row) { clearCensusStash(); renderCensusList(); return; }
    if (censusSession.pos > row.treeCount) renderCensusEnd(row);
    else renderCensusTree(row);
    return;
  }
  renderCensusList();
}

function renderCensusList() {
  const panel = $('#tab-census');
  const stash = loadCensusStash();

  const resumeBanner = stash ? `
    <div class="rounded-lg border border-amber-700 bg-amber-900/30 p-3 flex items-center justify-between gap-2">
      <div class="text-sm">Censo de la <span class="font-semibold">Hilera ${stash.rowId}</span> sin terminar (árbol ${Math.min(stash.pos, (ORCHARD_DATA.rows.find(r => r.id === stash.rowId)?.treeCount ?? stash.pos))} pendiente)</div>
      <div class="flex gap-1.5 shrink-0">
        <button id="census-resume" class="tap-target rounded-md bg-amber-700 hover:bg-amber-600 text-white text-xs font-medium px-3">Continuar</button>
        <button id="census-discard" class="tap-target rounded-md bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium px-3">Descartar</button>
      </div>
    </div>` : '';

  const sections = Object.values(SECTIONS).map(section => {
    const rows = rowsBySection(section.id);
    if (rows.length === 0) return '';
    const cards = rows.map(row => {
      const last = lastCensusDate(row);
      const badge = last
        ? `<span class="text-[11px] px-2 py-0.5 rounded-full border border-slate-600 text-slate-400">Censada ${esc(last)}</span>`
        : `<span class="text-[11px] px-2 py-0.5 rounded-full border border-amber-600 text-amber-400">Nunca censada</span>`;
      return `
        <button data-census-row="${row.id}" class="census-row-card w-full text-left tap-target rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700/70 active:bg-slate-700 transition p-3 flex items-center justify-between gap-2">
          <div>
            <span class="font-semibold">Hilera ${row.id}</span>
            <span class="text-xs text-slate-400 ml-2">${esc((VARIETIES[row.variety] || {}).label || row.variety)} · ${row.treeCount} árboles</span>
          </div>
          ${badge}
        </button>`;
    }).join('');
    return `
      <div>
        <h3 class="font-semibold text-slate-200 px-1 mb-2">${esc(section.name)}</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${cards}</div>
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="px-1">
      <h2 class="font-semibold">Censo</h2>
      <p class="text-xs text-slate-400 mt-0.5">Elige una hilera y revisa sus árboles uno por uno. Puedes salir a la mitad y continuar después.</p>
    </div>
    ${resumeBanner}
    ${sections}
    <div class="pt-1">
      <button id="census-add-row" class="tap-target w-full rounded-lg border border-dashed border-slate-600 text-slate-400 hover:text-white hover:border-slate-400 text-sm py-2.5 flex items-center justify-center gap-1.5">
        <i data-lucide="plus" class="w-4 h-4"></i> Agregar hilera (si falta alguna)
      </button>
      <div id="census-add-row-form" class="hidden mt-2 rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-2">
        <div class="grid grid-cols-2 gap-2">
          <select id="new-row-section" class="tap-target rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100">
            ${Object.values(SECTIONS).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
          </select>
          <select id="new-row-variety" class="tap-target rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100">
            ${Object.entries(VARIETIES).map(([key, v]) => `<option value="${key}">${esc(v.label)}</option>`).join('')}
          </select>
        </div>
        <input id="new-row-count" type="number" min="1" value="8" placeholder="Número de árboles"
               class="tap-target w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
        <div class="flex gap-2">
          <button id="save-new-row" class="tap-target flex-1 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium">Guardar</button>
          <button id="cancel-new-row" class="tap-target flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium">Cancelar</button>
        </div>
      </div>
    </div>
  `;
  lucide.createIcons();

  $$('.census-row-card', panel).forEach(btn =>
    btn.addEventListener('click', () => {
      const rowId = Number(btn.dataset.censusRow);
      const stash2 = loadCensusStash();
      if (stash2 && stash2.rowId !== rowId &&
          !confirm(`Hay un censo sin terminar de la Hilera ${stash2.rowId}. ¿Descartarlo y empezar con la Hilera ${rowId}?`)) return;
      censusSession = { rowId, pos: 1, answers: {} };
      saveCensusStash();
      renderCensus();
    }));

  if (stash) {
    $('#census-resume').addEventListener('click', () => {
      censusSession = stash;
      renderCensus();
    });
    $('#census-discard').addEventListener('click', () => {
      if (!confirm('¿Descartar el censo sin terminar? Las respuestas no guardadas se perderán.')) return;
      clearCensusStash();
      renderCensus();
    });
  }

  $('#census-add-row').addEventListener('click', () => {
    $('#census-add-row-form').classList.toggle('hidden');
  });
  $('#cancel-new-row').addEventListener('click', () => $('#census-add-row-form').classList.add('hidden'));
  $('#save-new-row').addEventListener('click', async () => {
    const sectionId = Number($('#new-row-section').value);
    const varietyKey = $('#new-row-variety').value;
    const count = Math.max(1, Number($('#new-row-count').value) || 1);
    const newId = Math.max(...ORCHARD_DATA.rows.map(r => r.id)) + 1;
    if (!confirm(`Se creará la Hilera ${newId} en ${SECTIONS[sectionId].name} con ${count} árboles. ¿Continuar?`)) return;
    const payload = {
      id: newId, section_id: sectionId, variety_key: varietyKey,
      tree_count: count, age: 0, notes: '',
      variety_confirmed_at: varietyKey === 'unconfirmed' ? null : new Date().toISOString().slice(0, 10),
    };
    const { error } = await supabase.from('rows').insert(payload);
    if (error) {
      console.error('Row insert failed', error);
      showSaveError('No se pudo crear la hilera — revisa tu conexión e intenta de nuevo.');
      return;
    }
    ORCHARD_DATA.rows.push({
      id: newId, sectionId, variety: varietyKey, treeCount: count, age: 0,
      notes: '', varietyConfirmedAt: payload.variety_confirmed_at || undefined, log: [],
    });
    ORCHARD_DATA.rows.sort((a, b) => a.id - b.id);
    markSaved();
    renderCensus(); renderMap(); renderInventory();
  });
}

function renderCensusTree(row) {
  const panel = $('#tab-census');
  const pos = censusSession.pos;
  const { states, health } = deriveTreePositions(row);
  const prev = censusSession.answers[pos]; // revisiting via "atrás"
  const curState = prev?.state ?? states[pos - 1];
  const curHealth = prev?.health ?? health[pos - 1];
  const pct = Math.round(((pos - 1) / row.treeCount) * 100);

  const stateButtons = Object.entries(TREE_STATE_LABELS).map(([key, label]) =>
    `<button data-census-state="${key}" class="tap-target rounded-md border px-2 py-2 text-sm font-medium transition ${TREE_STATE_CLASSES[key]} ${key === curState ? 'ring-2 ring-white' : 'opacity-60'}">${esc(label)}</button>`
  ).join('');
  const healthButtons = Object.entries(HEALTH_LABELS).map(([key, label]) =>
    `<button data-census-health="${key}" class="tap-target rounded-md border border-slate-600 bg-slate-900 px-2 py-2 text-sm font-medium text-slate-200 transition ${key === curHealth ? 'ring-2 ring-white' : 'opacity-60'}">${esc(label)}</button>`
  ).join('');

  panel.innerHTML = `
    <div class="rounded-xl border border-slate-700 bg-slate-800 p-4 space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="font-semibold text-lg">Hilera ${row.id} — Árbol ${pos} de ${row.treeCount}</h2>
          <p class="text-xs text-slate-400">${esc((VARIETIES[row.variety] || {}).label || row.variety)}</p>
        </div>
        <button id="census-exit" title="Salir (se guarda el avance)" class="tap-target p-2 -m-2 text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>
      <div class="h-1.5 rounded-full bg-slate-700 overflow-hidden">
        <div class="h-full bg-emerald-500" style="width:${pct}%"></div>
      </div>

      <div>
        <div class="text-[11px] text-slate-500 mb-1.5">Estado</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">${stateButtons}</div>
      </div>
      <div>
        <div class="text-[11px] text-slate-500 mb-1.5">Salud</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">${healthButtons}</div>
      </div>
      <input id="census-note" type="text" placeholder="Nota sobre este árbol (opcional)" value="${esc(prev?.note || '')}"
             class="tap-target w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />

      <div class="flex gap-2">
        <button id="census-back" ${pos === 1 ? 'disabled' : ''} class="tap-target rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white px-3">
          <i data-lucide="chevron-left" class="w-5 h-5"></i>
        </button>
        <button id="census-skip" class="tap-target flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium">No sé / Saltar</button>
        <button id="census-next" class="tap-target flex-1 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium">Guardar y seguir</button>
      </div>
      ${pos > 1 ? `<button id="census-end-here" class="tap-target w-full rounded-md border border-red-800 text-red-400 hover:bg-red-900/30 text-xs font-medium py-2">La hilera termina aquí (quedan ${pos - 1} árboles)</button>` : ''}
    </div>
  `;
  lucide.createIcons();

  let selState = curState;
  let selHealth = curHealth;
  const highlight = () => {
    $$('[data-census-state]', panel).forEach(b => {
      const on = b.dataset.censusState === selState;
      b.classList.toggle('ring-2', on); b.classList.toggle('ring-white', on); b.classList.toggle('opacity-60', !on);
    });
    $$('[data-census-health]', panel).forEach(b => {
      const on = b.dataset.censusHealth === selHealth;
      b.classList.toggle('ring-2', on); b.classList.toggle('ring-white', on); b.classList.toggle('opacity-60', !on);
    });
  };
  $$('[data-census-state]', panel).forEach(b =>
    b.addEventListener('click', () => { selState = b.dataset.censusState; highlight(); }));
  $$('[data-census-health]', panel).forEach(b =>
    b.addEventListener('click', () => { selHealth = b.dataset.censusHealth; highlight(); }));

  $('#census-next').addEventListener('click', () => {
    censusSession.answers[pos] = { state: selState, health: selHealth, note: $('#census-note').value.trim() };
    censusSession.pos = pos + 1;
    saveCensusStash();
    renderCensus();
  });
  $('#census-skip').addEventListener('click', () => {
    censusSession.answers[pos] = null;
    censusSession.pos = pos + 1;
    saveCensusStash();
    renderCensus();
  });
  $('#census-back').addEventListener('click', () => {
    if (pos > 1) { censusSession.pos = pos - 1; saveCensusStash(); renderCensus(); }
  });
  $('#census-exit').addEventListener('click', () => {
    censusSession = null; // stash stays in localStorage for the resume banner
    renderCensus();
  });
  const endBtn = $('#census-end-here');
  if (endBtn) endBtn.addEventListener('click', async () => {
    const newCount = pos - 1;
    if (!confirm(`¿La Hilera ${row.id} tiene solo ${newCount} árboles? El conteo se corregirá y el censo terminará aquí.`)) return;
    const ok = await updateRowCore(row, { tree_count: newCount });
    if (!ok) { showSaveError('No se pudo corregir el conteo — revisa tu conexión.'); return; }
    row.treeCount = newCount;
    for (const p of Object.keys(censusSession.answers)) if (Number(p) > newCount) delete censusSession.answers[p];
    censusSession.pos = newCount + 1;
    saveCensusStash();
    markSaved();
    renderCensus();
  });
}

function renderCensusEnd(row) {
  const panel = $('#tab-census');
  const entries = Object.entries(censusSession.answers).filter(([p]) => Number(p) <= row.treeCount);
  const reviewed = entries.filter(([, a]) => a !== null).length;
  const skipped = entries.filter(([, a]) => a === null).length;

  panel.innerHTML = `
    <div class="rounded-xl border border-slate-700 bg-slate-800 p-4 space-y-4 text-center">
      <i data-lucide="flag" class="w-8 h-8 mx-auto text-emerald-500"></i>
      <h2 class="font-semibold text-lg">Fin de la Hilera ${row.id}</h2>
      <p class="text-sm text-slate-400">${reviewed} revisado(s) · ${skipped} saltado(s) · de ${row.treeCount} árboles</p>
      <div class="space-y-2">
        <button id="census-add-tree" class="tap-target w-full rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700 text-sm font-medium py-2">
          Hay un árbol más — agregar (+1)
        </button>
        <button id="census-finish" class="tap-target w-full rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium py-2">
          Guardar censo de la hilera
        </button>
        <button id="census-abort" class="tap-target w-full rounded-md bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium py-2">
          Cancelar (no guardar nada)
        </button>
      </div>
    </div>
  `;
  lucide.createIcons();

  $('#census-add-tree').addEventListener('click', async () => {
    const newCount = row.treeCount + 1;
    const ok = await updateRowCore(row, { tree_count: newCount });
    if (!ok) { showSaveError('No se pudo agregar el árbol — revisa tu conexión.'); return; }
    row.treeCount = newCount;
    censusSession.pos = newCount; // go census the new tree
    saveCensusStash();
    markSaved();
    renderCensus();
  });
  $('#census-finish').addEventListener('click', () => finishCensusRow(row));
  $('#census-abort').addEventListener('click', () => {
    if (!confirm('¿Cancelar el censo de esta hilera? Las respuestas no se guardarán.')) return;
    clearCensusStash();
    renderCensus();
  });
}

async function finishCensusRow(row) {
  const today = new Date().toISOString().slice(0, 10);
  const { states, health } = deriveTreePositions(row);

  // Only record changes; the Census event documents what was reviewed.
  const stateGroups = {};  // status -> { positions, notes }
  const healthGroups = {};
  const reviewedPositions = [];
  for (const [pStr, a] of Object.entries(censusSession.answers)) {
    const p = Number(pStr);
    if (p < 1 || p > row.treeCount) continue;
    if (a === null) continue; // saltado
    reviewedPositions.push(p);
    if (a.state !== states[p - 1]) {
      (stateGroups[a.state] ??= { positions: [], notes: [] }).positions.push(p);
      if (a.note) stateGroups[a.state].notes.push(`Árbol ${p}: ${a.note}`);
    }
    if (a.health !== health[p - 1]) {
      (healthGroups[a.health] ??= { positions: [], notes: [] }).positions.push(p);
      if (a.note) healthGroups[a.health].notes.push(`Árbol ${p}: ${a.note}`);
    }
    // a note on an unchanged tree still deserves recording
    if (a.note && a.state === states[p - 1] && a.health === health[p - 1]) {
      (stateGroups[a.state] ??= { positions: [], notes: [] });
      if (!stateGroups[a.state].positions.includes(p)) stateGroups[a.state].positions.push(p);
      stateGroups[a.state].notes.push(`Árbol ${p}: ${a.note}`);
    }
  }
  reviewedPositions.sort((a, b) => a - b);

  const inserts = [];
  for (const [status, g] of Object.entries(stateGroups)) {
    inserts.push({ date: today, type: 'Tree State', status, positions: g.positions.sort((a, b) => a - b), text: g.notes.join('; ') });
  }
  for (const [status, g] of Object.entries(healthGroups)) {
    inserts.push({ date: today, type: 'Health', status, positions: g.positions.sort((a, b) => a - b), text: g.notes.join('; ') });
  }
  inserts.push({
    date: today, type: 'Census',
    positions: reviewedPositions.length ? reviewedPositions : null,
    text: `Censo: ${reviewedPositions.length} de ${row.treeCount} árboles revisados`,
  });

  for (const entry of inserts) {
    const ok = await insertRowEventCore(row, entry);
    if (!ok) {
      showSaveError('No se pudo guardar el censo completo — revisa tu conexión e intenta "Guardar censo" de nuevo.');
      return; // stash intact; the user can retry
    }
  }

  clearCensusStash();
  markSaved();
  renderCensus(); renderMap(); renderInventory();
}

// ---------- Tasks tab ----------
const TASK_STATUSES = ['Pending', 'In Progress', 'Completed'];
const NEXT_STATUS = { Pending: 'In Progress', 'In Progress': 'Completed', Completed: 'Pending' };

const CATEGORY_ICON = {
  'Pruning': 'scissors',
  'Bordelesa Paste': 'paintbrush',
  'Structural Maintenance': 'hammer',
  'Grafting': 'shovel',
  'Fertilization': 'droplets',
  'Other': 'circle',
};

function renderTasks() {
  const columns = TASK_STATUSES.map(status => {
    const tasks = ORCHARD_DATA.tasks.filter(t => t.status === status);
    const cards = tasks.map(t => `
      <div data-task-id="${t.id}" class="task-card rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-1.5 cursor-pointer hover:bg-slate-700/70 active:bg-slate-700 transition">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-1.5 text-xs text-slate-400">
            <i data-lucide="${CATEGORY_ICON[t.category] || 'circle'}" class="w-3.5 h-3.5"></i>
            ${esc(labelForCategory(t.category))}${t.rowId ? ` · Hilera ${t.rowId}` : ''}
          </div>
          <button data-delete-task-id="${t.id}" class="task-delete-btn tap-target -m-2 p-2 text-slate-500 hover:text-red-400 shrink-0">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
        <p class="text-sm leading-snug">${esc(t.title)}</p>
      </div>
    `).join('') || `<p class="text-xs text-slate-500 italic px-1">Sin tareas</p>`;

    return `
      <div class="flex-1 min-w-0">
        <h3 class="text-sm font-semibold text-slate-300 mb-2 px-1">${labelForStatus(status)} <span class="text-slate-500 font-normal">(${tasks.length})</span></h3>
        <div class="space-y-2">${cards}</div>
      </div>
    `;
  }).join('');

  const newTaskForm = showNewTaskForm ? `
    <div class="rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-2">
      <input id="new-task-title" type="text" placeholder="Título de la tarea (obligatorio)"
             class="tap-target w-full rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
      <div class="grid grid-cols-2 gap-2">
        <select id="new-task-category" class="tap-target rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100">
          ${TASK_CATEGORIES.map(c => `<option value="${c}">${esc(labelForCategory(c))}</option>`).join('')}
        </select>
        <input id="new-task-row" type="number" min="1" placeholder="Hilera (opcional)"
               class="tap-target rounded-md bg-slate-900 border border-slate-600 px-2 text-sm text-slate-100" />
      </div>
      <div class="flex gap-2">
        <button id="save-new-task" class="tap-target flex-1 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium">Guardar</button>
        <button id="cancel-new-task" class="tap-target flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium">Cancelar</button>
      </div>
    </div>
  ` : '';

  $('#tab-tasks').innerHTML = `
    <div class="flex items-center justify-between px-1">
      <h2 class="font-semibold">Tareas</h2>
      <button id="new-task-btn" class="tap-target rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium px-3 flex items-center gap-1.5">
        <i data-lucide="plus" class="w-4 h-4"></i> Nueva tarea
      </button>
    </div>
    ${newTaskForm}
    <div class="flex flex-col sm:flex-row gap-4">${columns}</div>
  `;
  lucide.createIcons();

  $('#new-task-btn').addEventListener('click', () => { showNewTaskForm = true; renderTasks(); });
  if (showNewTaskForm) {
    $('#cancel-new-task').addEventListener('click', () => { showNewTaskForm = false; renderTasks(); });
    $('#save-new-task').addEventListener('click', async () => {
      const title = $('#new-task-title').value.trim();
      if (!title) { $('#new-task-title').focus(); return; }
      const category = $('#new-task-category').value;
      const rowValRaw = $('#new-task-row').value.trim();
      let rowId = null;
      if (rowValRaw !== '') {
        const n = Number(rowValRaw);
        if (!Number.isInteger(n) || !ORCHARD_DATA.rows.some(r => r.id === n)) {
          alert('Esa hilera no existe.');
          return;
        }
        rowId = n;
      }

      const payload = { title, category, status: 'Pending', row_id: rowId, created_by: currentUser?.id ?? null };
      const { data, error } = await supabase.from('tasks').insert(payload).select().single();
      if (error) {
        console.error('Task insert failed', error);
        showSaveError('No se pudo guardar la tarea — revisa tu conexión e intenta de nuevo.');
        return;
      }
      ORCHARD_DATA.tasks.push(taskFromRow(data));
      showNewTaskForm = false;
      markSaved();
      renderTasks();
    });
  }

  $$('.task-card').forEach(card => {
    card.addEventListener('click', async e => {
      if (e.target.closest('.task-delete-btn')) return;
      const task = ORCHARD_DATA.tasks.find(t => t.id === card.dataset.taskId);
      const oldStatus = task.status;
      const oldCompletedAt = task.completedAt;
      const newStatus = NEXT_STATUS[task.status] || 'Pending';
      const newCompletedAt = newStatus === 'Completed' ? new Date().toISOString() : null;

      const { error } = await supabase.from('tasks')
        .update({ status: newStatus, completed_at: newCompletedAt })
        .eq('id', task.id);
      if (error) {
        console.error('Task status update failed', error);
        showSaveError('No se pudo actualizar la tarea — revisa tu conexión e intenta de nuevo.');
        return;
      }
      task.status = newStatus;
      task.completedAt = newCompletedAt;
      markSaved();
      renderTasks();
    });
  });
  $$('.task-delete-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('¿Eliminar esta tarea?')) return;
      const id = btn.dataset.deleteTaskId;
      const { error } = await supabase.from('tasks').delete().eq('id', id);
      if (error) {
        console.error('Task delete failed', error);
        showSaveError('No se pudo eliminar la tarea — revisa tu conexión e intenta de nuevo.');
        return;
      }
      ORCHARD_DATA.tasks = ORCHARD_DATA.tasks.filter(t => t.id !== id);
      markSaved();
      renderTasks();
    });
  });
}

// ---------- Loss/replant trend report (Fase 5) ----------
function collectLossData() {
  const byMonth = {};   // 'YYYY-MM' -> { cause: n }
  const bySection = {}; // sectionId -> { cause: n }
  for (const row of ORCHARD_DATA.rows) {
    for (const e of row.log) {
      let cause = null;
      if (e.type === 'Tree State' && LOSS_CAUSE_META[e.status]) cause = e.status;
      else if (e.type === 'Gopher Loss') cause = 'lost-gopher';      // legacy manual entries,
      else if (e.type === 'Graft Rejected') cause = 'graft-rejected'; // counted as 1 tree if no positions
      if (!cause) continue;
      const month = (e.date || '').slice(0, 7);
      if (month.length !== 7) continue;
      const n = e.positions?.length ?? 1;
      const m = (byMonth[month] ??= {});
      m[cause] = (m[cause] || 0) + n;
      const s = (bySection[row.sectionId] ??= {});
      s[cause] = (s[cause] || 0) + n;
    }
  }
  return { byMonth, bySection };
}

function renderLossReport() {
  const { byMonth, bySection } = collectLossData();
  const anyData = Object.keys(byMonth).length > 0;

  const legend = LOSS_CAUSES.map(c =>
    `<span class="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
       <span class="w-2.5 h-2.5 rounded-sm inline-block" style="background:${LOSS_CAUSE_META[c].color}"></span>${LOSS_CAUSE_META[c].label}
     </span>`).join('');

  // last 12 calendar months, oldest first
  const buckets = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('es-MX', { month: 'short' }),
    });
  }
  const totals = buckets.map(b => LOSS_CAUSES.reduce((s, c) => s + (byMonth[b.key]?.[c] || 0), 0));
  const maxTotal = Math.max(...totals, 1);
  const CHART_H = 96;

  // DOM top→bottom = replanted, graft-rejected, lost-gopher — gopher (the
  // headline cause) anchors the baseline in every column
  const stackOrder = [...LOSS_CAUSES].reverse();
  const columns = buckets.map((b, i) => {
    const total = totals[i];
    const segs = stackOrder.filter(c => byMonth[b.key]?.[c]).map((c, idx) => {
      const n = byMonth[b.key][c];
      const h = Math.max(3, Math.round((n / maxTotal) * CHART_H));
      return `<div title="${LOSS_CAUSE_META[c].label}: ${n}" style="height:${h}px;background:${LOSS_CAUSE_META[c].color}" class="w-full ${idx === 0 ? 'rounded-t' : ''}"></div>`;
    }).join('');
    return `
      <div class="flex-1 flex flex-col items-center justify-end">
        ${total > 0 ? `<div class="text-[10px] text-slate-400 mb-0.5">${total}</div>` : ''}
        <div class="w-full max-w-[22px] flex flex-col justify-end gap-0.5" style="min-height:0">${segs}</div>
        <div class="text-[10px] text-slate-500 mt-1">${b.label}</div>
      </div>`;
  }).join('');

  const maxSection = Math.max(1, ...Object.values(SECTIONS).map(s =>
    LOSS_CAUSES.reduce((sum, c) => sum + ((bySection[s.id] || {})[c] || 0), 0)));
  const sectionBars = Object.values(SECTIONS).map(s => {
    const data = bySection[s.id] || {};
    const total = LOSS_CAUSES.reduce((sum, c) => sum + (data[c] || 0), 0);
    const segs = LOSS_CAUSES.filter(c => data[c]).map(c =>
      `<div title="${LOSS_CAUSE_META[c].label}: ${data[c]}" style="width:${(data[c] / maxSection) * 100}%;background:${LOSS_CAUSE_META[c].color}" class="h-3 rounded-sm"></div>`
    ).join('');
    return `
      <div class="flex items-center gap-2 text-xs">
        <span class="w-20 shrink-0 text-slate-400">${esc(s.name)}</span>
        <div class="flex-1 flex gap-0.5 items-center">${segs || '<span class="text-slate-600">—</span>'}</div>
        <span class="w-8 text-right text-slate-400">${total || ''}</span>
      </div>`;
  }).join('');

  const monthsWithData = Object.keys(byMonth).sort();
  const tableRows = monthsWithData.map(m =>
    `<tr><td class="py-0.5 pr-4 text-slate-400">${m}</td>${LOSS_CAUSES.map(c => `<td class="py-0.5 pr-4 text-right text-slate-300">${byMonth[m][c] || ''}</td>`).join('')}</tr>`
  ).join('');

  return `
    <div class="rounded-lg border border-slate-700 bg-slate-800 p-4 mt-3">
      <h3 class="text-sm font-semibold text-slate-300 mb-1">Pérdidas y replantes — últimos 12 meses</h3>
      ${!anyData ? `
        <p class="text-xs text-slate-500 mt-2">Sin registros todavía. Los árboles marcados como perdidos, rechazados o replantados (desde el censo o la cuadrícula de cada hilera) aparecerán aquí por mes y por sección.</p>
      ` : `
        <div class="flex flex-wrap gap-3 mt-1 mb-3">${legend}</div>
        <div class="flex items-end gap-1">${columns}</div>
        <h4 class="text-xs font-medium text-slate-400 mt-4 mb-2">Por sección — total histórico</h4>
        <div class="space-y-1.5">${sectionBars}</div>
        <details class="mt-3">
          <summary class="text-[11px] text-slate-500 cursor-pointer">Ver tabla</summary>
          <table class="text-[11px] mt-2">
            <thead><tr><th class="text-left pr-4 font-normal text-slate-500">Mes</th>${LOSS_CAUSES.map(c => `<th class="text-right pr-4 font-normal text-slate-500">${LOSS_CAUSE_META[c].label}</th>`).join('')}</tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </details>
      `}
    </div>`;
}

// ---------- Inventory tab ----------
function renderInventory() {
  const inv = ORCHARD_DATA.inventory;
  const activeTotal = ORCHARD_DATA.rows.reduce((sum, r) => sum + r.treeCount, 0);
  const targetPct = Math.round((activeTotal / inv.targetTrees) * 100);
  const remaining = Math.max(0, inv.targetTrees - activeTotal);

  const producingTotal = ORCHARD_DATA.rows
    .filter(r => SECTIONS[r.sectionId].stage === 'Producing')
    .reduce((sum, r) => sum + r.treeCount, 0);
  const youngTotal = activeTotal - producingTotal;
  const unconfirmedTotal = ORCHARD_DATA.rows
    .filter(r => r.variety === 'unconfirmed')
    .reduce((sum, r) => sum + r.treeCount, 0);

  const varietyTotals = Object.keys(VARIETIES).map(key => ({
    key,
    count: ORCHARD_DATA.rows.filter(r => r.variety === key).reduce((sum, r) => sum + r.treeCount, 0),
  })).filter(v => v.count > 0);

  const sectionRows = Object.values(SECTIONS).map(section => {
    const total = rowsBySection(section.id).reduce((sum, r) => sum + r.treeCount, 0);
    return `
      <div class="flex items-center justify-between text-sm py-1.5">
        <span class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full border ${stageBadgeClass(section.stage)}">${labelForStage(section.stage)}</span>
          ${esc(section.name)}
        </span>
        <span class="text-slate-400">${total} árboles</span>
      </div>
    `;
  }).join('');

  $('#tab-inventory').innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div class="rounded-lg border border-slate-700 bg-slate-800 p-4">
        <div class="text-xs text-slate-400 mb-1">Total de árboles activos</div>
        <div class="text-2xl font-semibold">${activeTotal} <span class="text-sm text-slate-500 font-normal">/ ${inv.targetTrees}</span></div>
        <div class="h-1.5 rounded-full bg-slate-700 mt-2 overflow-hidden">
          <div class="h-full bg-emerald-500" style="width:${Math.min(targetPct,100)}%"></div>
        </div>
        <div class="text-[11px] text-slate-500 mt-1">${remaining} árboles restantes para alcanzar la meta</div>
      </div>
      <div class="rounded-lg border border-slate-700 bg-slate-800 p-4">
        <div class="text-xs text-slate-400 mb-1">Produciendo vs. joven</div>
        <div class="text-2xl font-semibold">${producingTotal} <span class="text-sm text-slate-500 font-normal">/ ${youngTotal}</span></div>
        <div class="text-[11px] text-slate-500 mt-1">Produciendo / Joven (injertado este año)</div>
      </div>
      <div class="rounded-lg border border-slate-700 bg-slate-800 p-4">
        <div class="text-xs text-slate-400 mb-1">Variedad por confirmar</div>
        <div class="text-2xl font-semibold">${unconfirmedTotal}</div>
        <div class="text-xs text-slate-500 mt-2">Árboles en Secciones 2-4</div>
      </div>
    </div>

    <div class="rounded-lg border border-slate-700 bg-slate-800 p-4 mt-3">
      <h3 class="text-sm font-semibold text-slate-300 mb-2">Árboles por sección</h3>
      <div class="divide-y divide-slate-700">${sectionRows}</div>
    </div>

    <div class="rounded-lg border border-slate-700 bg-slate-800 p-4 mt-3">
      <h3 class="text-sm font-semibold text-slate-300 mb-3">Árboles por variedad</h3>
      <div class="space-y-2">
        ${varietyTotals.map(({ key, count }) => {
          const v = VARIETIES[key];
          const pct = Math.round((count / activeTotal) * 100);
          return `
            <div>
              <div class="flex justify-between text-xs mb-1">
                <span class="flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full inline-block" style="background-color:${v.color}"></span>${esc(v.label)}
                </span>
                <span class="text-slate-400">${count} árboles · ${pct}%</span>
              </div>
              <div class="h-2 rounded-full bg-slate-700 overflow-hidden">
                <div class="h-full rounded-full" style="width:${pct}%;background-color:${v.color}"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    ${renderLossReport()}
  `;
}

// ============================================================
// Data assembly (Supabase rows -> in-memory shape the UI expects)
// ============================================================
function taskFromRow(t) {
  return {
    id: t.id,
    title: t.title,
    category: t.category,
    status: t.status,
    rowId: t.row_id,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
}

async function fetchAllData() {
  const [varietiesRes, sectionsRes, rowsRes, eventsRes, tasksRes] = await Promise.all([
    supabase.from('varieties').select('*'),
    supabase.from('sections').select('*'),
    supabase.from('rows').select('*'),
    supabase.from('row_events').select('*').order('event_date', { ascending: true }).order('created_at', { ascending: true }),
    supabase.from('tasks').select('*'),
  ]);

  for (const res of [varietiesRes, sectionsRes, rowsRes, eventsRes, tasksRes]) {
    if (res.error) throw res.error;
  }

  VARIETIES = {};
  for (const v of varietiesRes.data) VARIETIES[v.key] = { label: v.label, color: v.color };

  SECTIONS = {};
  for (const s of sectionsRes.data) SECTIONS[s.id] = { id: s.id, name: s.name, stage: s.stage, description: s.description };

  const eventsByRow = {};
  for (const e of eventsRes.data) {
    (eventsByRow[e.row_id] ??= []).push({
      date: e.event_date, type: e.type, text: e.note,
      positions: e.tree_positions || undefined,
      status: e.status || undefined,
    });
  }

  ORCHARD_DATA.rows = rowsRes.data
    .map(r => ({
      id: r.id,
      sectionId: r.section_id,
      variety: r.variety_key,
      treeCount: r.tree_count,
      age: r.age,
      notes: r.notes || '',
      varietyConfirmedAt: r.variety_confirmed_at || undefined,
      plantedAt: r.planted_at || undefined,
      log: eventsByRow[r.id] || [],
    }))
    .sort((a, b) => a.id - b.id);

  ORCHARD_DATA.tasks = tasksRes.data.map(taskFromRow);
}

function markSaved() {
  const indicator = $('#save-indicator');
  if (indicator) indicator.textContent = `Guardado · ${new Date().toLocaleTimeString('es-MX')}`;
}

async function refreshData({ silent = false } = {}) {
  try {
    await fetchAllData();
    renderMap();
    renderCensus();
    renderTasks();
    renderInventory();
    if (!silent) markSaved();
  } catch (e) {
    console.error('Refresh failed', e);
    if (!silent) showSaveError('No se pudieron actualizar los datos — revisa tu conexión.');
  }
}

// ---------- Export / v1 import ----------
function exportData() {
  const blob = new Blob([JSON.stringify(ORCHARD_DATA, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `orchard-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importV1Data(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let v1;
    try {
      v1 = JSON.parse(reader.result);
    } catch (e) {
      alert('No se pudo leer el archivo — verifica que sea un JSON de respaldo válido.');
      return;
    }

    const confirmed = confirm(
      'Esto importará los datos del respaldo anterior (de un solo dispositivo) a la base de datos compartida: ' +
      'sobrescribirá los campos de cada hilera (variedad, árboles, edad, notas) y agregará su historial y tareas como entradas nuevas. ' +
      'NO debe ejecutarse más de una vez, o el historial y las tareas se duplicarán. ¿Continuar?'
    );
    if (!confirmed) return;

    try {
      for (const row of v1.rows) {
        const { error } = await supabase.from('rows').update({
          variety_key: row.variety,
          tree_count: row.treeCount,
          age: row.age,
          notes: row.notes || '',
          variety_confirmed_at: row.varietyConfirmedAt || null,
        }).eq('id', row.id);
        if (error) throw error;

        for (const entry of (row.log || [])) {
          const { error: evError } = await supabase.from('row_events').insert({
            row_id: row.id,
            event_date: entry.date,
            type: entry.type,
            note: entry.text || '',
            created_by: currentUser?.id ?? null,
          });
          if (evError) throw evError;
        }
      }

      for (const task of (v1.tasks || [])) {
        const { error } = await supabase.from('tasks').insert({
          title: task.title,
          category: task.category,
          status: task.status,
          row_id: task.rowId,
          created_by: currentUser?.id ?? null,
          completed_at: task.completedAt || null,
        });
        if (error) throw error;
      }

      alert('Importación completa.');
      await refreshData();
    } catch (e) {
      console.error('v1 import failed', e);
      alert('La importación falló a la mitad — revisa la consola y verifica los datos antes de reintentar.');
    }
  };
  reader.readAsText(file);
}

// ---------- Tabs ----------
function setActiveTab(tab) {
  $$('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('bg-emerald-700', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('text-slate-400', !active);
  });
  $$('.tab-panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== `tab-${tab}`));
  lucide.createIcons();
}

function wireAppEvents() {
  $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => setActiveTab(btn.dataset.tab)));
  $('#row-detail-backdrop').addEventListener('click', e => {
    if (e.target.id === 'row-detail-backdrop') closeRowDetail();
  });
  $('#export-btn').addEventListener('click', exportData);
  $('#import-input').addEventListener('change', e => {
    if (e.target.files[0]) importV1Data(e.target.files[0]);
    e.target.value = '';
  });
  $('#logout-btn').addEventListener('click', () => supabase.auth.signOut());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeRefetch();
  });
  window.addEventListener('focus', maybeRefetch);
}

function maybeRefetch() {
  const now = Date.now();
  if (now - lastFetchAt < REFETCH_THROTTLE_MS) return;
  lastFetchAt = now;
  refreshData({ silent: true });
}

async function startApp() {
  renderAppShell();
  wireAppEvents();
  $('#orchard-name').textContent = ORCHARD_DATA.orchard.name;
  $('#orchard-location').textContent = `${ORCHARD_DATA.orchard.location} · ${ORCHARD_DATA.orchard.structure}`;
  loadClimate();
  lastFetchAt = Date.now();
  await refreshData();
  setActiveTab('map');
}

function renderAppShell() {
  $('#app-root').classList.remove('hidden');
  $('#auth-root').classList.add('hidden');
}

// ============================================================
// Auth screen
// ============================================================
function renderLoginForm(message = '') {
  $('#auth-root').innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-6">
      <div class="max-w-sm w-full space-y-4">
        <div class="text-center space-y-1">
          <i data-lucide="trees" class="w-8 h-8 mx-auto text-emerald-500"></i>
          <h1 class="text-lg font-semibold">Huerto Serdán</h1>
          <p class="text-sm text-slate-400">Inicia sesión con tu correo</p>
        </div>
        <form id="login-form" class="space-y-3">
          <input id="login-email" type="email" required placeholder="tu@correo.com"
                 class="tap-target w-full rounded-md bg-slate-900 border border-slate-600 px-3 text-sm text-slate-100" />
          <button type="submit" class="tap-target w-full rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium">
            Enviar enlace de acceso
          </button>
        </form>
        ${message ? `<p class="text-sm text-center text-slate-400">${esc(message)}</p>` : ''}
      </div>
    </div>
  `;
  lucide.createIcons();

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    if (!email) return;
    const submitBtn = $('#login-form button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) {
      console.error('signInWithOtp failed', error);
      renderLoginForm('No se pudo enviar el enlace — verifica tu correo e intenta de nuevo.');
      return;
    }
    renderLoginConfirmation(email);
  });
}

function renderLoginConfirmation(email) {
  $('#auth-root').innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-6">
      <div class="max-w-sm w-full text-center space-y-3">
        <i data-lucide="mail-check" class="w-10 h-10 mx-auto text-emerald-500"></i>
        <h1 class="text-lg font-semibold">Revisa tu correo</h1>
        <p class="text-sm text-slate-400">Enviamos un enlace de acceso a <span class="text-slate-200">${esc(email)}</span>. Ábrelo desde este dispositivo para entrar.</p>
      </div>
    </div>
  `;
  lucide.createIcons();
}

// ============================================================
// Service worker registration
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => console.error('SW registration failed', e));
  });
}

// ============================================================
// Init — session check drives auth screen vs. app shell
// ============================================================
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session?.user) {
    currentUser = session.user;
    startApp();
  } else if (event === 'SIGNED_OUT') {
    currentUser = null;
    location.reload();
  }
});

(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    currentUser = session.user;
    await startApp();
  } else {
    renderLoginForm();
  }
})();
