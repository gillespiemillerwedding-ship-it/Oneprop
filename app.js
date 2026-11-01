'use strict';
/* =====================================================================
   key-per — landlord tracker.  Data lives on this device only.
   ===================================================================== */

const LS_KEY = 'laudi_properties';   // old storage key, kept so existing data carries over
const DB_NAME = 'keyper-db';
const DB_STORE = 'kv';
const MAX_FILE = 6 * 1024 * 1024;

let properties = [];
let view = { screen:'dashboard', propId:null, tab:'property', editKey:null, rentYear:new Date().getFullYear() };
let editSnap = null;
let collapsed = {};
try { collapsed = JSON.parse(localStorage.getItem('keyper_collapsed') || '{}'); } catch(e) { collapsed = {}; }

const $ = (s) => document.querySelector(s);

/* ---------------------------------------------------------------- storage */
let dbPromise = null;
function getDb(){
  if(!dbPromise){
    dbPromise = new Promise((res, rej) => {
      if(!window.indexedDB){ rej(new Error('no indexedDB')); return; }
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(DB_STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}
async function idbGet(k){
  const db = await getDb();
  return new Promise((res, rej) => {
    const rq = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(k);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbPut(k, v){
  const db = await getDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('aborted'));
  });
}
let saveWarnAt = 0;
async function saveData(){
  const json = JSON.stringify(properties);
  try { await idbPut('properties', json); return true; }
  catch(e){
    try { localStorage.setItem(LS_KEY, json); return true; }
    catch(e2){
      if(Date.now() - saveWarnAt > 8000){
        saveWarnAt = Date.now();
        alert("Couldn't save — this phone's storage for the app looks full. Remove some photos or files and try again.");
      }
      return false;
    }
  }
}
function saveCollapsed(){ try { localStorage.setItem('keyper_collapsed', JSON.stringify(collapsed)); } catch(e) {} }

async function loadData(){
  let raw = null, fromLS = false;
  try { raw = await idbGet('properties'); } catch(e) {}
  if(!raw){
    try { raw = localStorage.getItem(LS_KEY); fromLS = !!raw; } catch(e) {}
  }
  try { properties = raw ? JSON.parse(raw) : []; } catch(e) { properties = []; }
  if(!Array.isArray(properties)) properties = [];
  const changed = migrate();
  if(fromLS || changed) await saveData();
  try { if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch(e) {}
  render(true);
}

/* Bring older saved data up to the current shape without losing anything */
function migrate(){
  let changed = false;
  properties.forEach(p => {
    if(!p.tenants){
      const legacy = p.tenantName || p.tenantEmail || p.tenantPhone || p.tenancyStart || p.rightToRentDate || p.depositScheme || p.depositReference || p.monthlyRent;
      p.tenants = legacy ? [{
        id: uid('t'), name:p.tenantName||'', email:p.tenantEmail||'', phone:p.tenantPhone||'',
        monthlyRent:p.monthlyRent||'', tenancyStart:p.tenancyStart||'', rightToRentDate:p.rightToRentDate||'',
        depositScheme:p.depositScheme||'', depositReference:p.depositReference||'', rtrDocs:[], rentPaid:{}
      }] : [];
      changed = true;
    }
    p.tenants.forEach(t => { if(!t.rtrDocs) t.rtrDocs = []; if(!t.rentPaid) t.rentPaid = {}; });
    if(!p.agents){
      p.agents = (p.lettingAgentName || p.lettingAgentPhone)
        ? [{ id:uid('a'), name:p.lettingAgentName||'', phone:p.lettingAgentPhone||'', email:'' }] : [];
      changed = true;
    }
    if(p.notes && String(p.notes).trim()){     // the old "Other details" box becomes a note
      p.noteLog = p.noteLog || [];
      p.noteLog.push({ id:uid('n'), text:String(p.notes).trim(), date:todayISO() });
      p.notes = '';
      changed = true;
    }
  });
  return changed;
}

/* ---------------------------------------------------------------- helpers */
function uid(p){ return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function todayISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function daysUntil(ds){
  if(!ds) return null;
  const t = new Date(); t.setHours(0,0,0,0);
  const d = new Date(ds + 'T00:00:00');
  if(isNaN(d)) return null;
  return Math.round((d - t) / 86400000);
}
function fmtDate(ds){
  if(!ds) return '';
  const d = new Date(String(ds).length <= 10 ? ds + 'T00:00:00' : ds);
  if(isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}
function fmtDateTime(iso){
  const d = new Date(iso);
  if(isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) + ', ' +
         d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}
function money(v){
  const n = parseFloat(v);
  if(isNaN(n)) return String(v);
  return '£' + n.toLocaleString('en-GB', { minimumFractionDigits:0, maximumFractionDigits:2 });
}
/* RAG: red = within 2 weeks (or overdue), amber = within a month, green = further out */
function ragOf(days){ return days <= 14 ? 'red' : (days <= 30 ? 'amber' : 'green'); }
function daysText(d){
  if(d < 0) return Math.abs(d) + 'd overdue';
  if(d === 0) return 'today';
  if(d === 1) return '1 day';
  if(d <= 90) return d + ' days';
  return Math.round(d / 30) + ' months';
}
function ragBadge(ds){
  const d = daysUntil(ds);
  if(d === null) return '';
  return `<span class="rag ${ragOf(d)}">${daysText(d)}</span>`;
}
function worstRag(prop, fields){
  let min = null;
  (fields || []).forEach(f => {
    if(!f.rag) return;
    const d = daysUntil(prop[f.key]);
    if(d !== null && (min === null || d < min)) min = d;
  });
  return min === null ? null : ragOf(min);
}
function currentProp(){ return properties.find(p => p.id === view.propId) || null; }
function isOpen(key, defOpen){ return collapsed[key] === undefined ? defOpen : !collapsed[key]; }
function propLabel(p){ return p.address || p.name || 'the property'; }

/* ---------------------------------------------------------------- definitions */
const FIELD = (key, label, o) => Object.assign({ key, label }, o || {});

const PROPERTY_BOXES = [
  { key:'overview', label:'Overview', fields:[
    FIELD('photo', 'Property photo', { type:'photo' }),
    FIELD('name', 'Property nickname', { placeholder:'e.g. 12 Elm Street' }),
    FIELD('address', 'Full address', { placeholder:'Street, city, postcode' }),
    FIELD('yearBuilt', 'Year built', { placeholder:'e.g. 1935', inputmode:'numeric' }),
  ]},
  { key:'access', label:'Access', fields:[
    FIELD('keySafeCode', 'Key safe / safe code', { placeholder:'e.g. 4471' }),
  ]},
  { key:'mortgage', label:'Mortgage', fields:[
    FIELD('mortgageLender', 'Lender', { placeholder:'e.g. Nationwide' }),
    FIELD('mortgageAmount', 'Outstanding balance', { money:true, placeholder:'e.g. 145000' }),
    FIELD('mortgageRate', 'Interest rate', { placeholder:'e.g. 4.8% fixed' }),
    FIELD('mortgageRenewal', 'Deal ends / renewal date', { type:'date', rag:true }),
    FIELD('mortgageAdviserPhone', 'Mortgage adviser number', { type:'tel', placeholder:'e.g. 07700 900123' }),
  ]},
  { key:'insurance', label:'Insurance', fields:[
    FIELD('insurer', 'Insured with', { placeholder:'e.g. Direct Line for Business' }),
    FIELD('policyNumber', 'Policy number', { placeholder:'e.g. LL-00234871' }),
    FIELD('insuranceRenewal', 'Renewal date', { type:'date', rag:true }),
    FIELD('insurerPhone', 'Insurer number', { type:'tel', placeholder:'e.g. 0345 246 8000' }),
  ]},
  { key:'compliance', label:'Compliance', legend:true, extra:'compliance', fields:[
    FIELD('gasSafetyRenewal', 'Gas Safety Certificate — renewal date (yearly)', { type:'date', rag:true }),
    FIELD('eicrRenewal', 'EICR — renewal date (every 5 years)', { type:'date', rag:true }),
    FIELD('epcRating', 'EPC rating', { placeholder:'e.g. C' }),
    FIELD('epcExpiry', 'EPC expiry date', { type:'date', rag:true }),
    FIELD('smokeAlarmTest', 'Smoke alarm last tested', { type:'date' }),
    FIELD('coAlarmTest', 'CO alarm last tested', { type:'date' }),
    FIELD('legionellaAssessment', 'Legionella risk assessment date', { type:'date' }),
  ]},
  { key:'hmo', label:'HMO licensing', extra:'hmo', fields:[
    FIELD('hmoLicence', 'HMO licence number', { placeholder:'Leave blank if not applicable' }),
    FIELD('hmoLicenceRenewal', 'HMO licence renewal date', { type:'date', rag:true }),
  ]},
  { key:'agents', label:'Letting agents', custom:'agents' },
  { key:'utilities', label:'Energy, meters & council tax', fields:[
    FIELD('utilitySupplier', 'Energy supplier', { placeholder:'e.g. British Gas' }),
    FIELD('smartMeter', 'Smart meter?', { type:'select', options:['', 'Yes', 'No', 'Not sure'] }),
    FIELD('elecReading', 'Electricity meter reading', { placeholder:'Most recent reading', inputmode:'decimal' }),
    FIELD('gasReading', 'Gas meter reading', { placeholder:'Most recent reading', inputmode:'decimal' }),
    FIELD('waterReading', 'Water meter reading', { placeholder:'If metered', inputmode:'decimal' }),
    FIELD('readingDate', 'Date of readings', { type:'date' }),
    FIELD('councilTaxBand', 'Council tax band', { placeholder:'e.g. D' }),
    FIELD('councilTaxRef', 'Council tax reference', { placeholder:'e.g. CT-88213' }),
  ]},
  { key:'leasehold', label:'Leasehold (if applicable)', fields:[
    FIELD('freeholder', 'Freeholder / management company', { placeholder:'Leave blank if freehold' }),
    FIELD('groundRent', 'Ground rent', { money:true, placeholder:'e.g. 250' }),
    FIELD('serviceCharge', 'Service charge', { money:true, placeholder:'e.g. 1800' }),
  ]},
];

const AGENT_FIELDS = [
  FIELD('name', 'Agent name', { placeholder:'e.g. Smith & Co Lettings' }),
  FIELD('phone', 'Agent number', { type:'tel', placeholder:'e.g. 020 7946 0958' }),
  FIELD('email', 'Agent email', { type:'email', placeholder:'e.g. office@agent.co.uk' }),
];

const TENANT_FIELDS = [
  FIELD('name', 'Tenant name', { placeholder:'e.g. J. Patel' }),
  FIELD('email', 'Tenant email', { type:'email', placeholder:'e.g. j.patel@email.com' }),
  FIELD('phone', 'Tenant number', { type:'tel', placeholder:'e.g. 07700 900456' }),
  FIELD('previousAddress', 'Previous address', { placeholder:'Where they lived before' }),
  FIELD('checkInDate', 'Check-in date', { type:'date' }),
  FIELD('tenancyStart', 'Tenancy start date', { type:'date' }),
  FIELD('monthlyRent', 'Monthly rent (their share, if joint)', { money:true, placeholder:'e.g. 1250' }),
  FIELD('holdingDeposit', 'Holding deposit amount', { money:true, placeholder:'e.g. 250' }),
  FIELD('depositAmount', 'Deposit amount', { money:true, placeholder:'e.g. 1442' }),
  FIELD('depositScheme', 'Deposit protection scheme', { placeholder:'e.g. TDS, DPS, MyDeposits' }),
  FIELD('depositReference', 'Deposit reference number', { placeholder:'e.g. DEP-4471029' }),
  FIELD('rightToRentDate', 'Right to Rent check date', { type:'date' }),
  FIELD('shareCode', 'Right to Rent code', { placeholder:'e.g. W12 3456 7' }),
];

const CHECKLIST_STEPS = [
  { key:'rtr', label:'Right to Rent checked for every tenant (copies kept on each tenant)' },
  { key:'referencing', label:'Referencing / credit check completed', url:'https://homelet.co.uk/letting-agents/tenant-referencing' },
  { key:'howToRent', label:'How to Rent guide sent', send:true },
  { key:'certs', label:'EPC, Gas Safety & EICR provided to tenant', send:true },
  { key:'contractSent', label:'Tenancy agreement sent', send:true, attach:true, ai:true },
  { key:'depositProtected', label:'Deposit received & protected in scheme' },
  { key:'inventory', label:'Move-in inventory completed (see Inventory below)' },
  { key:'inventorySent', label:'Inventory sent to tenant', send:true },
  { key:'signoff', label:'Final sign-off — tenant confirms everything received', send:true },
];

const RENEWAL_FIELDS = [
  { field:'mortgageRenewal', label:'Mortgage deal ends' },
  { field:'insuranceRenewal', label:'Insurance renews' },
  { field:'gasSafetyRenewal', label:'Gas Safety Certificate due' },
  { field:'eicrRenewal', label:'EICR due' },
  { field:'epcExpiry', label:'EPC expires' },
  { field:'hmoLicenceRenewal', label:'HMO licence renewal' },
];
const COMING_UP_DAYS = 42;   // 6 weeks
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------------------------------------------------------------- generic UI pieces */
function box(o){
  const open = isOpen(o.ck, o.open !== false);
  return `<section class="box ${o.cls || ''}">
    <div class="box-head">
      <button type="button" class="box-toggle" data-act="toggle" data-ck="${esc(o.ck)}" data-def="${o.open !== false ? 1 : 0}" aria-expanded="${open}">
        <span class="chev ${open ? '' : 'closed'}">▾</span>
        <span class="box-title">${esc(o.title)}</span>
        ${o.dot ? `<span class="dot ${o.dot}"></span>` : ''}
        ${o.sub ? `<span class="head-sub">${esc(o.sub)}</span>` : ''}
      </button>
      ${open ? (o.actions || '') : ''}
    </div>
    ${open ? `<div class="box-body">${o.body}</div>` : ''}
  </section>`;
}
function editBtns(key){
  if(view.editKey === key){
    return `<div class="box-actions"><button type="button" class="mini ghost" data-act="cancel">Cancel</button><button type="button" class="mini primary" data-act="save">Save</button></div>`;
  }
  if(view.editKey) return '';
  return `<button type="button" class="mini" data-act="edit" data-key="${esc(key)}">Edit</button>`;
}
function fieldView(f, v){
  if(v === undefined || v === null || v === '') return '<span class="muted">—</span>';
  if(f.type === 'date') return esc(fmtDate(v)) + (f.rag ? ragBadge(v) : '');
  if(f.type === 'tel') return `<a href="tel:${esc(String(v).replace(/[^0-9+]/g, ''))}">${esc(v)}</a>`;
  if(f.type === 'email') return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if(f.money) return esc(money(v));
  return esc(v);
}
function fieldInput(f, v, extra){
  const a = `data-f="${f.key}" ${extra || ''}`;
  if(f.type === 'select'){
    return `<select ${a}>` + f.options.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o || 'Select…')}</option>`).join('') + `</select>`;
  }
  const type = f.type === 'date' ? 'date' : f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : 'text';
  const im = f.inputmode || (f.money ? 'decimal' : '');
  return `<input type="${type}" ${a} ${im ? `inputmode="${im}"` : ''} placeholder="${esc(f.placeholder || '')}" value="${esc(v || '')}" autocomplete="off" ${f.type === 'email' ? 'autocapitalize="none"' : ''}>`;
}
function fieldRow(f, obj, editing, extra){
  const v = obj[f.key];
  return `<div class="field-row"><label>${esc(f.label)}</label>` +
    (editing ? fieldInput(f, v, extra) : `<div class="view-value">${fieldView(f, v)}</div>`) + `</div>`;
}
function addFileBtn(list, label, tid, cls){
  return `<label class="${cls || 'chip-btn ghost'}">${label}<input type="file" style="display:none" data-chg="addFile" data-list="${list}" ${tid ? `data-tid="${tid}"` : ''}></label>`;
}
function fileRow(list, d, o, tid){
  o = o || {};
  const a = `data-list="${list}" data-id="${d.id}" ${tid ? `data-tid="${tid}"` : ''}`;
  return `<div class="file-row"><div class="file-item">
      <button type="button" class="file-link" data-act="openFile" ${a}>${esc(d.name)}</button>
      <span class="file-date">${esc(fmtDate(d.date))}</span>
      <button type="button" class="x-btn" data-act="delFile" ${a} aria-label="Remove file">×</button>
    </div>` +
    (o.email ? `<div class="file-actions"><button type="button" class="chip-btn ghost" data-act="emailDoc" ${a}>✉ Email tenants</button><button type="button" class="chip-btn ghost" data-act="shareDoc" ${a}>Share…</button></div>` : '') +
    `</div>`;
}
function notesBlock(list, arr){
  arr = arr || [];
  let h = '';
  if(!arr.length) h += `<p class="empty-note">No notes yet.</p>`;
  arr.slice().reverse().forEach(n => {
    h += `<div class="note-entry"><button type="button" class="x-btn" data-act="delNote" data-list="${list}" data-id="${n.id}" aria-label="Delete note">×</button>
      <div class="note-date">${esc(fmtDate(n.date))}</div><div class="note-text">${esc(n.text)}</div></div>`;
  });
  h += `<div class="add-row"><input type="text" id="in-${list}" data-enter="addNote" data-list="${list}" placeholder="Add a note"><button type="button" class="add-btn-sm" data-act="addNote" data-list="${list}">Add</button></div>`;
  return h;
}

/* ---------------------------------------------------------------- dashboard */
function getRenewals(){
  const items = [];
  properties.forEach(p => {
    RENEWAL_FIELDS.forEach(r => {
      const d = daysUntil(p[r.field]);
      if(d !== null && d <= COMING_UP_DAYS) items.push({ id:p.id, prop:p.name || p.address || 'Untitled property', what:r.label, date:p[r.field], days:d });
    });
  });
  return items.sort((a, b) => a.days - b.days);
}
function getOpenTodos(){
  const items = [];
  properties.forEach(p => (p.todos || []).forEach(t => { if(!t.done) items.push({ id:p.id, prop:p.name || p.address || 'Untitled property', text:t.text }); }));
  return items;
}
function propWorstRag(p){
  let min = null;
  RENEWAL_FIELDS.forEach(r => { const d = daysUntil(p[r.field]); if(d !== null && (min === null || d < min)) min = d; });
  return min === null || min > COMING_UP_DAYS ? null : ragOf(min);
}
function renderDashboard(){
  const ren = getRenewals(), tasks = getOpenTodos();
  let h = `<h2 class="section-title">Coming up<span class="count-pill">${ren.length ? ren.length + ' in the next 6 weeks' : ''}</span></h2>`;
  h += `<p class="hint legend"><span class="rag red">Red</span> within 2 weeks &nbsp;<span class="rag amber">Amber</span> within a month &nbsp;<span class="rag green">Green</span> within 6 weeks</p>`;
  if(!ren.length) h += `<p class="empty-note">Nothing due in the next 6 weeks.</p>`;
  ren.forEach(r => {
    h += `<div class="alert-card ${ragOf(r.days)}" data-act="openProp" data-id="${r.id}">
      <div><div class="prop">${esc(r.prop)}</div><div class="what">${esc(r.what)}</div></div>
      <div class="right"><div class="date">${esc(fmtDate(r.date))}</div><div class="days">${esc(daysText(r.days))}</div></div></div>`;
  });

  h += `<h2 class="section-title">Open tasks<span class="count-pill">${tasks.length || ''}</span></h2><div class="todo-panel">`;
  if(!tasks.length) h += `<p class="empty-note" style="padding:2px 0;">Nothing on your to-do list.</p>`;
  tasks.forEach(t => { h += `<div class="todo-panel-item" data-act="openProp" data-id="${t.id}"><span class="prop-tag">${esc(t.prop)}</span><span class="task-text">${esc(t.text)}</span></div>`; });
  h += `</div>`;

  h += `<h2 class="section-title">Properties<span class="count-pill">${properties.length}</span></h2>`;
  if(!properties.length){
    h += `<div class="empty-state"><div class="big">No properties yet</div>Add your first one to start tracking it.</div>`;
  } else {
    [...properties].sort((a, b) => (a.name || a.address || 'zzzz').localeCompare(b.name || b.address || 'zzzz', undefined, { sensitivity:'base' })).forEach(p => {
      const nm = p.name || p.address || 'Untitled property';
      const avatar = p.photo ? `<img src="${p.photo}" class="tab-photo" alt="">` : `<div class="tab-letter">${esc(nm.trim().charAt(0).toUpperCase() || '?')}</div>`;
      const rent = (p.tenants || []).reduce((s, t) => s + (parseFloat(t.monthlyRent) || 0), 0);
      const rg = propWorstRag(p);
      h += `<div class="prop-card" data-act="openProp" data-id="${p.id}">${avatar}
        <div class="info"><div class="name">${esc(nm)}</div><div class="sub">${esc(p.address || 'No address yet')}</div></div>
        ${rg ? `<span class="dot ${rg}"></span>` : ''}<div class="rent">${rent ? esc(money(rent)) + '/mo' : ''}</div></div>`;
    });
  }
  h += `<button type="button" class="add-btn" data-act="addProp">+ Add a property</button>`;

  h += `<h2 class="section-title">Backup</h2>
    <p class="hint">Everything is stored on this phone only. Download a backup now and then, especially before changing the home screen icon or phone.</p>
    <button type="button" class="chip-btn ghost" data-act="backup">Download backup</button>
    <label class="chip-btn ghost">Restore backup<input type="file" accept=".json,application/json" style="display:none" data-chg="restore"></label>`;
  return h;
}

/* ---------------------------------------------------------------- property detail */
const CLOSED_BY_DEFAULT = new Set(['hmo', 'agents', 'utilities', 'leasehold']);

function renderPhotoField(p, editing){
  let h = `<div class="field-row"><div id="photo-slot">`;
  if(editing){
    h += `<img id="photo-preview" class="photo-preview" alt="" ${p.photo ? `src="${p.photo}"` : 'style="display:none"'}>
      </div><button type="button" class="chip-btn ghost" data-act="propPhotoCam">📷 Take photo</button>
      <label class="chip-btn ghost">Choose photo<input type="file" accept="image/*" style="display:none" data-chg="propPhotoFile"></label>
      <button type="button" class="link-danger" data-act="propPhotoRemove">Remove photo</button>`;
  } else {
    h += p.photo ? `<img class="photo-preview" alt="" src="${p.photo}">` : '';
    h += `</div>`;
  }
  return h + `</div>`;
}
function complianceExtra(p){
  const docs = p.complianceDocs || [];
  let h = `<p class="hint legend"><span class="rag red">Red</span> within 2 weeks &nbsp;<span class="rag amber">Amber</span> within a month &nbsp;<span class="rag green">Green</span> more than a month</p>`;
  h += `<div class="sub-head">Compliance documents</div>`;
  if(!docs.length) h += `<p class="empty-note">None yet — add each new certificate when you get it.</p>`;
  docs.forEach(d => { h += fileRow('complianceDocs', d, { email:true }); });
  h += addFileBtn('complianceDocs', '+ Add document');
  h += `<p class="hint">Email opens your mail app with every tenant in BCC. Attach the file there, or use Share.</p>`;
  return h;
}
function hmoExtra(p){
  let h = `<div class="sub-head">Licence &amp; schedule of works</div>`;
  (p.hmoFiles || []).forEach(d => { h += fileRow('hmoFiles', d); });
  h += addFileBtn('hmoFiles', '+ Attach file');
  h += `<div class="sub-head">HMO notes</div>` + notesBlock('hmoNotes', p.hmoNotes);
  return h;
}
function renderPropertyBox(p, b){
  if(b.custom === 'agents') return renderAgentsBox(p);
  const editing = view.editKey === b.key;
  let body = '';
  b.fields.forEach(f => {
    if(f.type === 'photo'){ body += renderPhotoField(p, editing); return; }
    body += fieldRow(f, p, editing);
  });
  if(!editing){
    if(b.extra === 'compliance') body = complianceExtra(p).split('<div class="sub-head">')[0] + body + '<div class="sub-head">' + complianceExtra(p).split('<div class="sub-head">').slice(1).join('<div class="sub-head">');
    if(b.extra === 'hmo') body += hmoExtra(p);
  }
  return box({ ck:p.id + ':' + b.key, title:b.label, dot:worstRag(p, b.fields), open:!CLOSED_BY_DEFAULT.has(b.key), actions:editBtns(b.key), body });
}
function renderAgentsBox(p){
  const editing = view.editKey === 'agents';
  const agents = p.agents || [];
  let body = agents.length ? '' : `<p class="empty-note">No agents added.</p>`;
  agents.forEach((a, i) => {
    body += `<div class="sub-item"><div class="sub-label">Agent ${i + 1}</div>`;
    AGENT_FIELDS.forEach(f => { body += fieldRow(f, a, editing, `data-aid="${a.id}"`); });
    if(!editing) body += `<button type="button" class="link-danger" data-act="removeAgent" data-aid="${a.id}">Remove agent</button>`;
    body += `</div>`;
  });
  if(!editing) body += `<button type="button" class="add-btn" data-act="addAgent">+ Add agent</button>`;
  return box({ ck:p.id + ':agents', title:'Letting agents', sub:agents.length ? String(agents.length) : '', open:false, actions:agents.length ? editBtns('agents') : '', body });
}
function renderPropertyTab(p){
  let h = '';
  PROPERTY_BOXES.forEach(b => { h += renderPropertyBox(p, b); });

  const docs = p.attachments || [];
  let d = docs.length ? '' : `<p class="empty-note">Agreements, certificates, anything worth keeping with this property.</p>`;
  docs.forEach(f => { d += fileRow('attachments', f); });
  d += addFileBtn('attachments', '+ Add a file');
  h += box({ ck:p.id + ':docs', title:'Documents', sub:docs.length ? String(docs.length) : '', body:d });

  const todos = p.todos || [];
  let t = todos.length ? '' : `<p class="empty-note">No tasks yet.</p>`;
  todos.forEach(x => {
    t += `<div class="todo-item ${x.done ? 'done' : ''}"><input type="checkbox" data-act="toggleTodo" data-id="${x.id}" ${x.done ? 'checked' : ''}><span class="todo-text">${esc(x.text)}</span><button type="button" class="x-btn" data-act="delTodo" data-id="${x.id}" aria-label="Delete task">×</button></div>`;
  });
  t += `<div class="add-row"><input type="text" id="in-todo" data-enter="addTodo" placeholder="Add a task"><button type="button" class="add-btn-sm" style="background:var(--orange)" data-act="addTodo">Add</button></div>`;
  h += box({ ck:p.id + ':todo', title:'To-do', cls:'todo-accent', sub:todos.filter(x => !x.done).length ? todos.filter(x => !x.done).length + ' open' : '', body:t });

  h += box({ ck:p.id + ':notes', title:'Notes', body:notesBlock('noteLog', p.noteLog) });
  h += `<button type="button" class="btn-danger-outline" data-act="deleteProp">Delete this property</button>`;
  return h;
}

/* ---------------------------------------------------------------- tenants tab */
function rentCal(p, t){
  const y = view.rentYear, paid = t.rentPaid || {};
  let cells = '', pn = 0, mn = 0;
  for(let m = 0; m < 12; m++){
    const k = y + '-' + String(m + 1).padStart(2, '0'), s = paid[k];
    if(s === 'paid') pn++; if(s === 'missed') mn++;
    cells += `<button type="button" class="rent-cell ${s || ''}" data-act="rentCell" data-tid="${t.id}" data-m="${k}" aria-label="${MONTHS[m]} ${y}"><span class="rm">${MONTHS[m]}</span><span class="rs">${s === 'paid' ? '✓' : s === 'missed' ? '✗' : ''}</span></button>`;
  }
  return `<div class="rent-nav"><button type="button" data-act="rentYear" data-d="-1" aria-label="Previous year">‹</button><strong>${y}</strong><button type="button" data-act="rentYear" data-d="1" aria-label="Next year">›</button></div>
    <div class="rent-grid">${cells}</div>
    <p class="hint">Tap a month: ✓ paid → ✗ not paid → blank. &nbsp;${pn} paid${mn ? `, ${mn} missed` : ''} in ${y}.</p>`;
}
function renderTenantBox(p, t, i){
  const key = 't:' + t.id, editing = view.editKey === key;
  let body = '';
  TENANT_FIELDS.forEach(f => { body += fieldRow(f, t, editing, `data-tid="${t.id}"`); });
  if(!editing){
    body += `<div class="sub-head">Right to Rent copies (passport / visa)</div>`;
    (t.rtrDocs || []).forEach(d => { body += fileRow('rtrDocs', d, {}, t.id); });
    body += addFileBtn('rtrDocs', '+ Add ID copy', t.id);
    body += box({ ck:p.id + ':rent:' + t.id, title:'Rent paid', cls:'sub', open:false, body:rentCal(p, t) });
    body += `<button type="button" class="link-danger block" data-act="removeTenant" data-tid="${t.id}">Remove tenant</button>`;
  }
  return box({ ck:p.id + ':' + key, title:t.name || ('Tenant ' + (i + 1)), cls:'tenant-box', open:false, sub:t.monthlyRent ? money(t.monthlyRent) + '/mo' : '', actions:editBtns(key), body });
}
function renderChecklist(p){
  const done = p.checklistDone || {};
  let body = '';
  CHECKLIST_STEPS.forEach((s, i) => {
    const isDone = !!done[s.key];
    const locked = !isDone && !CHECKLIST_STEPS.slice(0, i).every(x => done[x.key]);
    body += `<div class="check-item ${locked ? 'locked' : ''} ${isDone ? 'done' : ''}">
      <input type="checkbox" data-act="tick" data-step="${s.key}" ${isDone ? 'checked' : ''} ${locked ? 'disabled' : ''}>
      <span class="check-text">${esc(s.label)}</span>
      ${s.url ? `<a class="chip-btn" href="${s.url}" target="_blank" rel="noopener">Start</a>` : ''}
      ${s.send ? `<button type="button" class="chip-btn" data-act="sendStep" data-step="${s.key}" ${locked ? 'disabled' : ''}>Send</button>` : ''}
      ${s.attach ? addFileBtn('attachments', '+ Add', null, 'chip-btn ghost') : ''}
      ${s.ai ? `<button type="button" class="chip-btn ai" data-act="aiFill">✨ Autofill via AI</button>` : ''}
    </div>`;
  });
  body += `<p class="hint">Send opens your mail app with every tenant in BCC. Tick a step yourself once it has really gone. Steps unlock in order.</p>`;
  const n = CHECKLIST_STEPS.filter(s => done[s.key]).length;
  return box({ ck:p.id + ':checklist', title:'Tenant onboarding checklist', sub:n + '/' + CHECKLIST_STEPS.length, body });
}
function renderInventory(p){
  const photos = (p.inventoryPhotos || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let body = `<button type="button" class="chip-btn" data-act="invCamera">📷 Take photos</button>
    <label class="chip-btn ghost">Add from library<input type="file" accept="image/*" multiple style="display:none" data-chg="invFiles"></label>
    <p class="hint">Photos taken here stay inside key-per — they are not saved to your phone's Photos.</p>`;
  if(photos.length){
    body += `<div class="inv-grid">`;
    photos.forEach(ph => {
      body += `<div class="inv-photo"><button type="button" class="inv-img" data-act="viewInv" data-id="${ph.id}"><img src="${ph.dataUrl}" alt=""></button>
        <button type="button" class="x-badge" data-act="delInv" data-id="${ph.id}" aria-label="Delete photo">×</button>
        <div class="inv-date">${esc(fmtDateTime(ph.at))}</div></div>`;
    });
    body += `</div>`;
    body += `<button type="button" class="chip-btn ghost" data-act="emailInventory">✉ Email tenants</button><button type="button" class="chip-btn ghost" data-act="shareInventory">Share photos…</button>
      <p class="hint">Email puts every tenant in BCC but can't attach photos itself. Use Share photos to send them as attachments.</p>`;
  }
  body += `<div class="sub-head">Inventory notes</div>` + notesBlock('inventoryNotes', p.inventoryNotes);
  return box({ ck:p.id + ':inventory', title:'Move-in inventory', sub:photos.length ? photos.length + ' photos' : '', body });
}
function renderTenantsTab(p){
  let h = '';
  const ts = p.tenants || [];
  if(!ts.length) h += `<p class="empty-note">No tenants yet.</p>`;
  ts.forEach((t, i) => { h += renderTenantBox(p, t, i); });
  h += `<button type="button" class="add-btn" data-act="addTenant">+ Add tenant</button>`;
  h += renderChecklist(p);
  h += renderInventory(p);
  return h;
}
function renderDetail(p){
  return `<div class="detail-header"><button type="button" class="back-btn" data-act="back">← Back</button></div>
    <div class="detail-tabs">
      <button type="button" class="detail-tab ${view.tab === 'property' ? 'active' : ''}" data-act="tab" data-tab="property">Property details</button>
      <button type="button" class="detail-tab ${view.tab === 'tenant' ? 'active' : ''}" data-act="tab" data-tab="tenant">Tenant details</button>
    </div>` + (view.tab === 'tenant' ? renderTenantsTab(p) : renderPropertyTab(p));
}

/* ---------------------------------------------------------------- products / news */
function renderProducts(){
  const items = [
    { icon:'🏦', title:'Compare mortgages', desc:'Shop deals ahead of your renewal date', url:'https://www.moneysupermarket.com/mortgages/' },
    { icon:'🛡️', title:'Compare landlord insurance', desc:'Check you are not overpaying', url:'https://www.comparethemarket.com/landlord-insurance/' },
    { icon:'🔎', title:'Tenant referencing', desc:'HomeLet referencing for new tenants', url:'https://homelet.co.uk/letting-agents/tenant-referencing' },
    { icon:'📋', title:'Landlord responsibilities', desc:'Official gov.uk guidance', url:'https://www.gov.uk/renting-out-a-property' },
  ];
  let h = `<h2 class="section-title">Products</h2>`;
  items.forEach(i => { h += `<a class="product-card" href="${i.url}" target="_blank" rel="noopener"><span class="product-icon">${i.icon}</span><div><div class="product-title">${i.title}</div><div class="product-desc">${i.desc}</div></div></a>`; });
  return h;
}
function renderNews(){
  const items = [
    { title:'Renters’ Rights Act', desc:'Section 21 “no-fault” evictions have ended and tenancies have moved to a periodic model, effective from 1 May 2026. Worth double-checking your notice processes and tenancy paperwork are up to date.' },
    { title:'Making Tax Digital for landlords', desc:'From 6 April 2026, landlords with gross rental income over £50,000 a year must keep digital records and send quarterly updates to HMRC via approved software. The threshold drops to £30,000 in 2027, then £20,000 in 2028.' },
    { title:'EPC minimum rating', desc:'Still E for now. The government has confirmed rental properties will need a minimum EPC rating of C by 1 October 2030, with a £10,000 spending cap on upgrades — worth planning for early.' },
  ];
  let h = `<h2 class="section-title">News</h2><p class="empty-note">A short, occasionally updated summary — not a live feed. Always confirm details before acting on them.</p>`;
  items.forEach(i => { h += `<div class="news-card"><div class="news-title">${i.title}</div><div class="news-desc">${i.desc}</div></div>`; });
  return h;
}

/* ---------------------------------------------------------------- render */
function render(toTop){
  const main = $('#main'), tag = $('#tagline');
  const y = window.scrollY;
  let p = null;
  if(view.screen === 'detail'){ p = currentProp(); if(!p){ view.screen = 'dashboard'; } }
  if(view.screen === 'dashboard'){ tag.textContent = 'Every property, every renewal, in one place'; main.innerHTML = renderDashboard(); }
  else if(view.screen === 'detail'){ tag.textContent = p.name || p.address || 'New property'; main.innerHTML = renderDetail(p); }
  else if(view.screen === 'products'){ tag.textContent = 'Useful links for landlords'; main.innerHTML = renderProducts(); }
  else if(view.screen === 'news'){ tag.textContent = 'What’s changing for landlords'; main.innerHTML = renderNews(); }
  document.querySelectorAll('.bottom-link').forEach(l => {
    const n = l.dataset.nav;
    l.classList.toggle('active', n === view.screen || (n === 'dashboard' && view.screen === 'detail'));
  });
  window.scrollTo(0, toTop ? 0 : y);
}
function go(v){ view = Object.assign({ screen:'dashboard', propId:null, tab:'property', editKey:null, rentYear:view.rentYear }, v); pendingPhoto = undefined; render(true); }

/* ---------------------------------------------------------------- files, photos, camera */
function readDataUrl(file){
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
}
function loadImg(src){ return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function compressImage(file, max, q){
  const url = URL.createObjectURL(file);
  try{
    const img = await loadImg(url);
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const s = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * s); h = Math.round(h * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', q);
  } finally { URL.revokeObjectURL(url); }
}
function listFor(p, list, tid){
  if(tid){ const t = (p.tenants || []).find(x => x.id === tid); if(!t) return []; t.rtrDocs = t.rtrDocs || []; return t.rtrDocs; }
  p[list] = p[list] || []; return p[list];
}
async function addFile(file, list, tid){
  const p = currentProp(); if(!p || !file) return;
  if(file.size > MAX_FILE){ alert('That file is over 6MB — please use a smaller scan or photo.'); return; }
  let dataUrl;
  try { dataUrl = file.type.indexOf('image/') === 0 ? await compressImage(file, 1800, 0.85) : await readDataUrl(file); }
  catch(e){ alert("Couldn't read that file."); return; }
  listFor(p, list, tid).push({ id:uid('f'), name:file.name || 'file', dataUrl, date:todayISO() });
  await saveData(); render();
}
async function openDoc(d){
  if(!d) return;
  if(d.dataUrl.indexOf('data:image') === 0){ lightbox(d.dataUrl, d.name); return; }
  try{
    const blob = await (await fetch(d.dataUrl)).blob();
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if(!w){ const a = document.createElement('a'); a.href = url; a.download = d.name; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }catch(e){ alert("Couldn't open that file."); }
}
function lightbox(src, cap){
  const el = document.createElement('div'); el.id = 'lightbox';
  el.innerHTML = `<button type="button" class="lb-x" aria-label="Close">×</button><img alt=""><div class="lb-cap"></div>`;
  el.querySelector('img').src = src; el.querySelector('.lb-cap').textContent = cap || '';
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}
async function shareFiles(files, title, text){
  try{
    if(navigator.canShare && navigator.canShare({ files })){ await navigator.share({ files, title, text }); return true; }
  }catch(e){ if(e && e.name === 'AbortError') return true; }
  alert("Sharing files isn't available on this device. You can still open the file and send it from there.");
  return false;
}
async function dataUrlToFile(d, name){
  const b = await (await fetch(d)).blob();
  return new File([b], name, { type:b.type });
}

let camStream = null;
async function openCamera(cfg){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ alert("This browser can't open the camera from inside the app. Use 'Choose photo' / 'Add from library' instead."); return; }
  try{
    camStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1920 }, height:{ ideal:1080 } }, audio:false });
  }catch(e){ alert("Couldn't open the camera. Allow camera access for this app, or use 'Choose photo' / 'Add from library' instead."); return; }
  const ov = document.createElement('div'); ov.id = 'cam-overlay';
  ov.innerHTML = `<video id="cam-video" autoplay playsinline muted></video>
    <div class="cam-bar"><button type="button" class="cam-btn" id="cam-done">Done</button><button type="button" class="cam-shutter" id="cam-shot" aria-label="Take photo"></button><div id="cam-count"></div></div>`;
  document.body.appendChild(ov);
  const v = ov.querySelector('#cam-video'); v.srcObject = camStream; try { await v.play(); } catch(e) {}
  let n = 0;
  const stop = () => { if(camStream){ camStream.getTracks().forEach(t => t.stop()); camStream = null; } ov.remove(); if(cfg.onDone) cfg.onDone(n); };
  ov.querySelector('#cam-done').onclick = stop;
  ov.querySelector('#cam-shot').onclick = async () => {
    if(!v.videoWidth) return;
    const s = Math.min(1, 1400 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.8);
    n++; ov.querySelector('#cam-count').textContent = n + (n === 1 ? ' photo' : ' photos');
    ov.classList.add('flash'); setTimeout(() => ov.classList.remove('flash'), 120);
    await cfg.onShot(dataUrl, new Date().toISOString());
    if(!cfg.multi) stop();
  };
}

let pendingPhoto;   // undefined = untouched, '' = removed, string = new photo
function setPhotoPreview(src){
  pendingPhoto = src;
  const img = $('#photo-preview'); if(!img) return;
  if(src){ img.src = src; img.style.display = 'block'; } else { img.removeAttribute('src'); img.style.display = 'none'; }
}

/* ---------------------------------------------------------------- email */
function openMail(url){ window.__lastMail = url; const a = document.createElement('a'); a.href = url; document.body.appendChild(a); a.click(); a.remove(); }
function tenantEmails(p){ return (p.tenants || []).map(t => (t.email || '').trim()).filter(Boolean); }
function mailTenants(p, subject, body){
  const em = tenantEmails(p);
  if(!em.length){ alert('Add at least one tenant email address first (Tenant details).'); return false; }
  openMail('mailto:?bcc=' + em.map(encodeURIComponent).join(',') + '&subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body));
  return true;
}
function stepMail(p, key){
  const where = propLabel(p), sub = (s) => s + ' – ' + where;
  const dep = [];
  (p.tenants || []).forEach(t => { if(t.depositAmount || t.depositScheme || t.depositReference) dep.push([t.depositAmount ? money(t.depositAmount) : '', t.depositScheme, t.depositReference ? 'ref ' + t.depositReference : ''].filter(Boolean).join(', ')); });
  const photos = (p.inventoryPhotos || []).length;
  const T = {
    howToRent:{ s:sub('How to Rent guide'), b:`Hi,\n\nHere is the current government "How to Rent" guide:\nhttps://www.gov.uk/government/publications/how-to-rent\n\nPlease reply to confirm you have received it.\n\nBest,\n` },
    certs:{ s:sub('Compliance certificates'), b:`Hi,\n\nPlease find attached the EPC, Gas Safety Certificate and EICR for ${where}.\n\nBest,\n` },
    contractSent:{ s:sub('Tenancy agreement'), b:`Hi,\n\nPlease find attached the tenancy agreement for ${where}.\n\nBest,\n` },
    inventorySent:{ s:sub('Move-in inventory'), b:`Hi,\n\nPlease find the move-in inventory for ${where}${photos ? ' (' + photos + ' dated photos)' : ''}. Please check it carefully and reply with anything you think is missing or wrong.\n\nBest,\n` },
    signoff:{ s:sub('Please confirm everything received'), b:`Hi,\n\nPlease reply "I confirm" to say you have received all of the following for ${where}:\n\n- How to Rent guide\n- EPC, Gas Safety Certificate and EICR\n- Tenancy agreement\n- Deposit protection details${dep.length ? ' (' + dep.join('; ') + ')' : ''}\n- Move-in inventory\n\nThank you,\n` },
  };
  return T[key];
}

/* ---------------------------------------------------------------- saving edits */
function cleanMoney(s){ const v = String(s).replace(/[^0-9.\-]/g, ''); return v; }
function saveEdits(){
  const p = currentProp(); if(!p || !view.editKey) return;
  const k = view.editKey;
  document.querySelectorAll('#main [data-f]').forEach(inp => {
    const key = inp.dataset.f; let v = inp.value.trim();
    const money = inp.getAttribute('inputmode') === 'decimal' && /rent|deposit|Deposit|Amount|groundRent|serviceCharge/i.test(key);
    if(money) v = cleanMoney(v);
    if(inp.dataset.tid){ const t = (p.tenants || []).find(x => x.id === inp.dataset.tid); if(t) t[key] = v; }
    else if(inp.dataset.aid){ const a = (p.agents || []).find(x => x.id === inp.dataset.aid); if(a) a[key] = v; }
    else p[key] = v;
  });
  if(k === 'overview' && pendingPhoto !== undefined){ if(pendingPhoto) p.photo = pendingPhoto; else delete p.photo; }
  delete p._new;
  pendingPhoto = undefined;
}

/* ---------------------------------------------------------------- editing helpers */
function startEdit(key){
  const p = currentProp(); if(!p) return;
  editSnap = JSON.stringify(p);
  view.editKey = key;
  collapsed[p.id + ':' + key] = false; saveCollapsed();
  pendingPhoto = undefined;
  render();
}
function restoreSnap(){
  const p = currentProp();
  if(p && editSnap){
    const old = JSON.parse(editSnap);
    if(old._new){ properties = properties.filter(x => x.id !== p.id); view.screen = 'dashboard'; view.propId = null; }
    else { const i = properties.indexOf(p); properties[i] = old; }
  }
  editSnap = null; view.editKey = null; pendingPhoto = undefined;
}
function leaveEdit(){
  if(!view.editKey) return true;
  if(!confirm('Discard your unsaved changes?')) return false;
  restoreSnap(); return true;
}
function newTenant(){
  return { id:uid('t'), name:'', email:'', phone:'', previousAddress:'', checkInDate:'', tenancyStart:'', monthlyRent:'', holdingDeposit:'', depositAmount:'', depositScheme:'', depositReference:'', rightToRentDate:'', shareCode:'', rtrDocs:[], rentPaid:{} };
}

/* ---------------------------------------------------------------- click handling */
async function handleClick(e){
  const nav = e.target.closest('[data-nav]');
  if(nav){ if(!leaveEdit()) return; go({ screen:nav.dataset.nav }); return; }
  const el = e.target.closest('[data-act]'); if(!el) return;
  const act = el.dataset.act, p = currentProp(), d = el.dataset;
  switch(act){
    case 'toggle': {
      if(view.editKey) return;
      collapsed[d.ck] = isOpen(d.ck, d.def === '1'); saveCollapsed(); render(); return;
    }
    case 'openProp': go({ screen:'detail', propId:d.id, tab:'property' }); return;
    case 'addProp': {
      const np = { id:uid('p'), _new:true, name:'', address:'', tenants:[], agents:[], todos:[], noteLog:[], attachments:[], inventoryPhotos:[], inventoryNotes:[], checklistDone:{} };
      editSnap = JSON.stringify(np);
      properties.push(np);
      go({ screen:'detail', propId:np.id, tab:'property', editKey:'overview' });
      return;
    }
    case 'back': if(!leaveEdit()) return; go({ screen:'dashboard' }); return;
    case 'tab': if(d.tab === view.tab) return; if(!leaveEdit()) return; view.tab = d.tab; render(true); return;
    case 'edit': startEdit(d.key); return;
    case 'cancel': restoreSnap(); render(); return;
    case 'save': saveEdits(); editSnap = null; view.editKey = null; await saveData(); render(); return;
    case 'deleteProp':
      if(!p || !confirm('Delete this property and everything stored on it? This cannot be undone.')) return;
      properties = properties.filter(x => x.id !== p.id); editSnap = null; await saveData(); go({ screen:'dashboard' }); return;
    case 'addTodo': case 'addNote': {
      if(!p) return;
      const inp = act === 'addTodo' ? $('#in-todo') : $('#in-' + d.list);
      const text = inp && inp.value.trim(); if(!text) return;
      if(act === 'addTodo'){ p.todos = p.todos || []; p.todos.push({ id:uid('d'), text, done:false }); }
      else { p[d.list] = p[d.list] || []; p[d.list].push({ id:uid('n'), text, date:todayISO() }); }
      await saveData(); render(); return;
    }
    case 'toggleTodo': { const t = (p.todos || []).find(x => x.id === d.id); if(t){ t.done = el.checked; await saveData(); render(); } return; }
    case 'delTodo': p.todos = (p.todos || []).filter(x => x.id !== d.id); await saveData(); render(); return;
    case 'delNote': if(!confirm('Delete this note?')) return; p[d.list] = (p[d.list] || []).filter(x => x.id !== d.id); await saveData(); render(); return;
    case 'addAgent': {
      editSnap = JSON.stringify(p);
      p.agents = p.agents || []; p.agents.push({ id:uid('a'), name:'', phone:'', email:'' });
      view.editKey = 'agents'; collapsed[p.id + ':agents'] = false; saveCollapsed(); render(); return;
    }
    case 'removeAgent': if(!confirm('Remove this agent?')) return; p.agents = p.agents.filter(a => a.id !== d.aid); await saveData(); render(); return;
    case 'addTenant': {
      const t = newTenant(); editSnap = JSON.stringify(p);
      p.tenants = p.tenants || []; p.tenants.push(t);
      view.editKey = 't:' + t.id; collapsed[p.id + ':t:' + t.id] = false; saveCollapsed(); render(); return;
    }
    case 'removeTenant': {
      const t = p.tenants.find(x => x.id === d.tid);
      if(!confirm('Remove ' + ((t && t.name) || 'this tenant') + ' and their documents?')) return;
      p.tenants = p.tenants.filter(x => x.id !== d.tid); await saveData(); render(); return;
    }
    case 'rentYear': view.rentYear += parseInt(d.d, 10); render(); return;
    case 'rentCell': {
      const t = p.tenants.find(x => x.id === d.tid); t.rentPaid = t.rentPaid || {};
      const cur = t.rentPaid[d.m];
      if(!cur) t.rentPaid[d.m] = 'paid'; else if(cur === 'paid') t.rentPaid[d.m] = 'missed'; else delete t.rentPaid[d.m];
      await saveData(); render(); return;
    }
    case 'tick': {
      p.checklistDone = p.checklistDone || {};
      const idx = CHECKLIST_STEPS.findIndex(s => s.key === d.step);
      if(el.checked) p.checklistDone[d.step] = true;
      else CHECKLIST_STEPS.slice(idx).forEach(s => { delete p.checklistDone[s.key]; });
      await saveData(); render(); return;
    }
    case 'sendStep': { const m = stepMail(p, d.step); if(m) mailTenants(p, m.s, m.b); return; }
    case 'aiFill': alert('✨ Autofill via AI is coming soon. It will read the tenancy agreement and fill in the tenant details for you.'); return;
    case 'openFile': { const f = listFor(p, d.list, d.tid).find(x => x.id === d.id); openDoc(f); return; }
    case 'delFile': {
      if(!confirm('Remove this file?')) return;
      const arr = listFor(p, d.list, d.tid); const i = arr.findIndex(x => x.id === d.id); if(i > -1) arr.splice(i, 1);
      await saveData(); render(); return;
    }
    case 'emailDoc': {
      const f = listFor(p, d.list, d.tid).find(x => x.id === d.id); if(!f) return;
      mailTenants(p, 'New compliance document – ' + propLabel(p), `Hi,\n\nPlease find attached the latest "${f.name}" for ${propLabel(p)}.\n\nBest,\n`); return;
    }
    case 'shareDoc': { const f = listFor(p, d.list, d.tid).find(x => x.id === d.id); if(f) shareFiles([await dataUrlToFile(f.dataUrl, f.name)], f.name); return; }
    case 'propPhotoCam': openCamera({ multi:false, onShot:(url) => setPhotoPreview(url) }); return;
    case 'propPhotoRemove': setPhotoPreview(''); return;
    case 'invCamera': openCamera({ multi:true, onShot: async (url, at) => { p.inventoryPhotos = p.inventoryPhotos || []; p.inventoryPhotos.push({ id:uid('i'), dataUrl:url, at }); await saveData(); }, onDone:() => render() }); return;
    case 'viewInv': { const ph = p.inventoryPhotos.find(x => x.id === d.id); if(ph) lightbox(ph.dataUrl, fmtDateTime(ph.at)); return; }
    case 'delInv': if(!confirm('Delete this photo?')) return; p.inventoryPhotos = p.inventoryPhotos.filter(x => x.id !== d.id); await saveData(); render(); return;
    case 'emailInventory': { const m = stepMail(p, 'inventorySent'); mailTenants(p, m.s, m.b); return; }
    case 'shareInventory': {
      const files = []; let i = 1;
      for(const ph of p.inventoryPhotos){ files.push(await dataUrlToFile(ph.dataUrl, 'inventory-' + (i++) + '-' + ph.at.slice(0, 10) + '.jpg')); }
      shareFiles(files, 'Inventory – ' + propLabel(p)); return;
    }
    case 'backup': {
      const blob = new Blob([JSON.stringify(properties)], { type:'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'key-per-backup-' + todayISO() + '.json';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); return;
    }
  }
}

async function handleChange(e){
  const t = e.target, c = t.dataset && t.dataset.chg; if(!c) return;
  const p = currentProp(), files = Array.from(t.files || []);
  t.value = '';
  if(c === 'addFile'){ for(const f of files) await addFile(f, t.dataset.list, t.dataset.tid); return; }
  if(c === 'propPhotoFile' && files[0]){ try { setPhotoPreview(await compressImage(files[0], 1000, 0.8)); } catch(err) { alert("Couldn't read that photo."); } return; }
  if(c === 'invFiles' && p){
    for(const f of files){
      try { p.inventoryPhotos = p.inventoryPhotos || []; p.inventoryPhotos.push({ id:uid('i'), dataUrl:await compressImage(f, 1400, 0.8), at:new Date(f.lastModified || Date.now()).toISOString() }); } catch(err) {}
    }
    await saveData(); render(); return;
  }
  if(c === 'restore' && files[0]){
    try {
      const data = JSON.parse(await files[0].text());
      if(!Array.isArray(data)) throw 0;
      if(!confirm('Replace everything in the app with this backup?')) return;
      properties = data; migrate(); await saveData(); go({ screen:'dashboard' });
    } catch(err) { alert("That doesn't look like a key-per backup file."); }
  }
}

document.addEventListener('click', handleClick);
document.addEventListener('change', handleChange);
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter' || !e.target.dataset || !e.target.dataset.enter) return;
  e.preventDefault();
  const b = document.querySelector(`[data-act="${e.target.dataset.enter}"]` + (e.target.dataset.list ? `[data-list="${e.target.dataset.list}"]` : ''));
  if(b) b.click();
});
document.addEventListener('DOMContentLoaded', () => {
  const brand = $('#brand'); if(brand) brand.addEventListener('click', () => { if(leaveEdit()) go({ screen:'dashboard' }); });
  loadData();
});
if('serviceWorker' in navigator && location.protocol.indexOf('http') === 0){
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
