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
  'Other': 'Otro',
};
const labelForLogType = t => LOG_TYPE_LABELS[t] || t;
const LOG_TYPES = Object.keys(LOG_TYPE_LABELS);

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

      <div>
        <h4 class="text-sm font-medium text-slate-300 mb-2">Historial</h4>
        <div class="space-y-1.5 max-h-40 overflow-y-auto mb-3">
          ${row.log.length === 0
            ? `<p class="text-xs text-slate-500 italic">Sin entradas todavía</p>`
            : [...row.log].reverse().map(entry => `
                <div class="text-xs border border-slate-700 rounded-md px-2 py-1.5">
                  <span class="text-slate-500">${esc(entry.date)}</span>
                  <span class="text-slate-300 font-medium ml-1">${esc(labelForLogType(entry.type))}</span>
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

async function updateRowRemote(row, patch, onSuccess, onFailure) {
  const { error } = await supabase.from('rows').update(patch).eq('id', row.id);
  if (error) {
    console.error('Row update failed', error);
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
  const payload = {
    row_id: row.id,
    event_date: entry.date,
    type: entry.type,
    note: entry.text || '',
    created_by: currentUser?.id ?? null,
  };
  const { data, error } = await supabase.from('row_events').insert(payload).select().single();
  if (error) {
    console.error('Row event insert failed', error);
    showSaveError('No se pudo guardar la entrada del historial — revisa tu conexión e intenta de nuevo.');
    return;
  }
  row.log.push({ date: data.event_date, type: data.type, text: data.note });
  markSaved();
  openRowDetail(row.id);
}

function closeRowDetail() {
  $('#row-detail-backdrop').classList.add('hidden');
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
        <input id="new-task-row" type="number" min="1" max="40" placeholder="Hilera (opcional)"
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
        if (!Number.isInteger(n) || n < 1 || n > 40) {
          alert('El número de hilera debe estar entre 1 y 40.');
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
    (eventsByRow[e.row_id] ??= []).push({ date: e.event_date, type: e.type, text: e.note });
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
