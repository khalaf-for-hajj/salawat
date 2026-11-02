// ===== لوحة المشرف وشاشة السحب =====
import { rpc, DEMO } from './rpc.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import {
  DEFAULT_CONFIG, SEASON_TEXTS, STATUS_LABELS, fullConfig, clone, normalizePhone, displayPhone, fmt, pct, esc,
  dayKey, competitionDays, dayName, dayLabel, fmtDT, isoToLocalInput, localInputToIso, contestantTotal, sharesFor,
  applyTheme, toast, errMsg, toLatinDigits
} from './common.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const QR_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const SUPA_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const A = {
  tab: sessionStorage.getItem('sl_admin_tab') || 'overview',
  test: sessionStorage.getItem('sl_admin_test') === '1',
  D: null, X: null, auto: true, lastAt: 0, sb: null,
  sort: { k: 'total', d: -1 }, filt: { q: '', bus: '', g: '', st: '', today: false, flag: false },
  busSort: 'total', openBus: null, draft: null, preview: null, calib: { trials: [], cur: null }
};
const GENDER = { m: 'رجل', f: 'امرأة' };
const CSTATUS = { active: 'نشط', withdrawn: 'منسحب', excluded: 'مستبعد' };
const REVIEW = { none: '', pending: 'للمراجعة', approved: 'معتمد', deducted: 'خُصم', excluded: 'مستبعد' };
const FLAG = { reject_ratio: 'نسبة مرفوض عالية', daily_rate: 'معدل يومي مرتفع', robotic: 'نمط ضغط آلي' };
const MSTATUS = { pending: 'بانتظار الاعتماد', approved: 'معتمدة', rejected: 'مرفوضة', reverted: 'ملغاة' };
const TABS = [['overview', 'نظرة عامة'], ['buses', 'الباصات'], ['days', 'الأيام'], ['people', 'المتسابقون'], ['top', 'الأعلى'],
  ['review', 'المراجعة'], ['draw', 'السحب'], ['tools', 'أدوات'], ['settings', 'الإعدادات'], ['audit', 'السجل']];

// ================= الدخول =================
boot();
async function boot() {
  if (DEMO) {
    const d = $('#demo'); d.classList.remove('hidden');
    d.textContent = 'وضع تجريبي: لا يوجد اتصال بـ Supabase بعد، والبيانات محفوظة في هذا المتصفح فقط.';
    return start();
  }
  try {
    const { createClient } = await import(SUPA_URL);
    A.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  } catch { $('#app').innerHTML = `<div class="card">تعذر تحميل مكتبة Supabase. تحقق من الإنترنت ثم حدّث الصفحة.</div>`; return; }
  const { data } = await A.sb.auth.getSession();
  if (data.session) start(); else loginForm();
}

function loginForm(msg = '') {
  $('#tabs').classList.add('hidden');
  $('#app').innerHTML = `<div class="card" style="max-width:420px;margin:30px auto">
    <h2>دخول المشرف</h2>
    <form id="f-login"><label class="field"><span>البريد الإلكتروني</span><input class="input" id="email" type="email" dir="ltr" required autocomplete="username"></label>
    <label class="field"><span>كلمة المرور</span><input class="input" id="pass" type="password" dir="ltr" required autocomplete="current-password"></label>
    <div class="err" id="err">${esc(msg)}</div><button class="btn block" id="go">دخول</button></form></div>`;
  $('#f-login').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#go'); b.classList.add('busy'); $('#err').textContent = '';
    const { error } = await A.sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#pass').value });
    b.classList.remove('busy');
    if (error) $('#err').textContent = 'البريد أو كلمة المرور غير صحيحة.'; else start();
  };
}

async function call(name, params = {}) {
  let jwt;
  if (!DEMO) {
    const { data } = await A.sb.auth.getSession();
    jwt = data.session && data.session.access_token;
    if (!jwt) { loginForm('انتهت الجلسة، سجّل الدخول من جديد.'); throw new Error('not_admin'); }
  }
  return rpc(name, params, { jwt, timeout: 60000 });
}

async function start() {
  if (!DEMO) {
    try {
      const w = await call('sl_admin_whoami');
      if (!w.is_admin) {
        $('#app').innerHTML = `<div class="card" style="max-width:520px;margin:30px auto"><h2>ليس لديك صلاحية</h2>
          <p>البريد <b dir="ltr">${esc(w.email || '')}</b> غير موجود في جدول المشرفين <code>sl_admins</code>.</p>
          <p class="small muted">أضفه من Supabase → SQL Editor:<br><code dir="ltr">insert into sl_admins(email) values ('${esc(w.email || '')}');</code></p>
          <button class="btn ghost" id="so">خروج</button></div>`;
        $('#so').onclick = signOut; return;
      }
    } catch (e) { $('#app').innerHTML = `<div class="card">${esc(errMsg(e))} — هل شغّلت schema.sql؟</div>`; return; }
    $('#signout').classList.remove('hidden'); $('#signout').onclick = signOut;
  }
  await load(true);
  setInterval(() => { if (A.auto && document.visibilityState === 'visible') load(); }, 15000);
}
async function signOut() { await A.sb.auth.signOut(); location.reload(); }

// ================= البيانات =================
async function load(force = false) {
  try {
    A.D = await call('sl_admin_dump', { p_test: A.test });
    A.lastAt = Date.now();
    compute();
    // لا نعيد بناء الشاشة أثناء الكتابة أو في الإعدادات/الأدوات أو مع نافذة مفتوحة
    const typing = document.activeElement && document.activeElement.closest('#app') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (force || (!$('.modal-bg') && !$('.draw-screen') && !typing && !['settings', 'tools'].includes(A.tab))) render();
    else { const m = $('#last'); if (m) m.textContent = lastText(); renderTabs(); }
  } catch (e) { toast(errMsg(e), 'error'); if (force) $('#app').innerHTML = `<div class="card">${esc(errMsg(e))}</div>`; }
}
const lastText = () => 'آخر تحديث: ' + new Date(A.lastAt).toLocaleTimeString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

// تجهيز كل الإحصائيات من البيانات الخام
function compute() {
  const D = A.D, cfg = fullConfig(D.config), now = Date.parse(D.server_now), sh = cfg.schedule.day_start_hour || 0;
  const today = dayKey(now, sh), inc = cfg.manual.include_in_totals, wd = cfg.display.withdrawn_in_total;
  const val = (d) => d ? d[0] + d[2] + (inc ? d[1] : 0) : 0;      // [app, man, adj]
  const buses = {}; D.buses.forEach(b => buses[b.id] = b);
  const dmap = {};
  for (const [cid, d, app, man, adj] of D.daily) (dmap[cid] = dmap[cid] || {})[d] = [app, man, adj];
  const ov = {}; (D.overrides || []).forEach(o => ov[o.contestant_id] = o);
  const cs = D.contestants.map(c => {
    const m = dmap[c.id] || {};
    const total = contestantTotal(c, cfg), drawTotal = contestantTotal(c, cfg, true);
    return { ...c, bus: (buses[c.bus_id] || {}).name || '', dmap: m, total, drawTotal, today: val(m[today]),
      activeDays: Object.values(m).filter(v => val(v) > 0).length, shares: sharesFor(drawTotal, cfg),
      activeNow: c.last_sync_at && now - Date.parse(c.last_sync_at) < 120000, override: ov[c.id] || null,
      counted: c.status === 'active' || (c.status === 'withdrawn' && wd) };
  });
  const byId = {}; cs.forEach(c => byId[c.id] = c);
  let days = competitionDays(cfg, now);
  const extra = new Set(); D.daily.forEach(r => extra.add(r[1]));
  days.forEach(d => extra.delete(d.key));
  if (extra.size) days = [...days, ...[...extra].sort().map(k => ({ no: null, key: k }))];
  A.cfg = cfg;
  A.X = { cfg, now, today, inc, val, cs, byId, buses, days, act: cs.filter(c => c.status === 'active'), counted: cs.filter(c => c.counted), status: D.status };
  applyTheme(cfg);
  $('#campaign').textContent = cfg.identity.campaign_name; $('#contest').textContent = cfg.season.contest_name;
  logo();
}
let logoVer = null;
async function logo() {
  const v = A.D.logo_version || '';
  if (v === logoVer) return; logoVer = v;
  if (!v) { $('#logo').src = 'assets/logo.png'; return; }
  try { const l = await call('sl_get_logo'); if (l && l.data) $('#logo').src = l.data; } catch { }
}

// ================= العرض =================
function renderTabs() {
  const t = $('#tabs'); t.classList.remove('hidden');
  const pend = A.X.cs.filter(c => c.review_status === 'pending').length + (A.D.manual || []).filter(m => m.status === 'pending').length;
  t.innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${A.tab === k ? 'on' : ''}">${l}${k === 'review' && pend ? `<span class="badge">${pend}</span>` : ''}</button>`).join('');
  $$('[data-tab]', t).forEach(b => b.onclick = () => { A.tab = b.dataset.tab; sessionStorage.setItem('sl_admin_tab', A.tab); if (A.tab === 'settings') A.draft = null; render(); scrollTo(0, 0); });
}
function render() {
  renderTabs();
  const views = { overview: vOverview, buses: vBuses, days: vDays, people: vPeople, top: vTop, review: vReview, draw: vDraw, tools: vTools, settings: vSettings, audit: vAudit };
  const st = A.X.status;
  $('#app').innerHTML = `
    <div class="topbar no-print"><div class="row"><span class="status-chip ${st}">${STATUS_LABELS[st]}</span>
      <span class="meta" id="last">${lastText()}</span></div>
      <div class="row"><label class="check small"><input type="checkbox" id="auto" ${A.auto ? 'checked' : ''}> تحديث تلقائي كل 15 ثانية</label>
      <button class="btn sm ghost" id="refresh">تحديث الآن</button><button class="btn sm ghost" onclick="print()">طباعة</button></div></div>
    ${A.test ? `<div class="test-bar">تعرض الآن بيانات المحاكاة (is_test) — لا تدخل في أي إحصاء أو سحب حقيقي. <a href="#" id="exit-test">عرض البيانات الحقيقية</a></div>` : ''}
    <div id="view"></div>`;
  $('#auto').onchange = (e) => { A.auto = e.target.checked; };
  $('#refresh').onclick = () => load(true);
  const et = $('#exit-test'); if (et) et.onclick = (e) => { e.preventDefault(); setTest(false); };
  views[A.tab]($('#view'));
}
function setTest(v) { A.test = v; sessionStorage.setItem('sl_admin_test', v ? '1' : '0'); A.preview = null; load(true); }

// ---------- أدوات صغيرة ----------
function guard(btn, fn) {
  return async (ev) => {
    if (ev) ev.preventDefault();
    if (btn.classList.contains('busy')) return;          // منع الضغط المزدوج
    btn.classList.add('busy');
    try { await fn(); } catch (e) { if (e.message !== 'cancel') toast(errMsg(e), 'error'); } finally { btn.classList.remove('busy'); }
  };
}
const on = (sel, fn, root = document) => { const b = $(sel, root); if (b) b.onclick = guard(b, fn); };
async function act(name, params, ok = 'تم') { const r = await call(name, params); if (r && r.error) throw new Error(r.error); toast(ok, 'ok'); await load(true); return r; }
const tile = (v, l, cls = '') => `<div class="tile ${cls}"><b>${v}</b><span>${l}</span></div>`;
const tags = (c) => [
  c.status !== 'active' ? `<span class="tag ${c.status === 'excluded' ? 'red' : 'amber'}">${CSTATUS[c.status]}</span>` : '',
  c.review_status === 'pending' ? `<span class="tag red">للمراجعة</span>` : (c.review_status !== 'none' ? `<span class="tag blue">${REVIEW[c.review_status]}</span>` : ''),
  c.manual_pending ? `<span class="tag amber">يدوي معلّق</span>` : '',
  c.override ? `<span class="tag ${c.override.mode === 'include' ? 'green' : 'red'}">${c.override.mode === 'include' ? 'إدراج بالقوة' : 'مستبعد من السحب'}</span>` : '',
  c.activeNow ? `<span class="tag green">نشط الآن</span>` : ''].join('');
const dayTitle = (d) => d.no ? dayName(d.no) : 'خارج الجدولة';

// نافذة حوار عامة: تعيد القيم أو null
function dialog({ title, html = '', fields = [], ok = 'تأكيد', cancel = 'إلغاء', danger = false, wide = false, onOpen }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<form class="modal ${wide ? 'wide' : ''}"><h2>${title}</h2>${html}
      ${fields.map(f => `<label class="field"><span>${f.label}${f.required ? ' *' : ''}</span>${f.type === 'textarea' ? `<textarea class="input" name="${f.id}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}">${esc(f.value ?? '')}</textarea>`
        : f.type === 'select' ? `<select class="input" name="${f.id}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(f.value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
          : `<input class="input" name="${f.id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} ${f.dir ? `dir="${f.dir}"` : ''} placeholder="${esc(f.placeholder || '')}">`}</label>`).join('')}
      <div class="actions">${cancel ? `<button type="button" class="btn ghost" data-x>${cancel}</button>` : ''}${ok ? `<button class="btn ${danger ? 'danger' : ''}">${ok}</button>` : ''}</div></form>`;
    document.body.appendChild(bg);
    const form = $('form', bg), close = (v) => { bg.remove(); resolve(v); };
    const x = $('[data-x]', bg); if (x) x.onclick = () => close(null);
    bg.addEventListener('click', (e) => { if (e.target === bg) close(null); });
    form.onsubmit = (e) => { e.preventDefault(); const v = {}; fields.forEach(f => v[f.id] = form.elements[f.id].value.trim()); close(v); };
    if (onOpen) onOpen(form, close);
    const first = form.querySelector('input,textarea'); if (first) first.focus();
  });
}
const confirmBox = (title, html, danger = false, ok = 'تأكيد') => dialog({ title, html: `<p>${html}</p>`, ok, danger });
async function askReason(title, extra = []) {
  const v = await dialog({ title, fields: [...extra, { id: 'reason', label: 'السبب', type: 'textarea', required: true }] });
  if (!v) throw new Error('cancel');
  return v;
}
function loadScript(url, global) {
  if (window[global]) return Promise.resolve(window[global]);
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.onload = () => res(window[global]); s.onerror = () => rej(new Error('تعذر تحميل المكتبة، تحقق من الإنترنت')); document.head.appendChild(s); });
}

// ================= نظرة عامة =================
function vOverview(el) {
  const X = A.X, cfg = X.cfg, c = X.counted;
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const total = sum(c, x => x.total), app = sum(c, x => x.app_total), man = sum(c, x => x.manual_total), adj = sum(c, x => x.adj_total), pend = sum(c, x => x.manual_pending);
  const todayT = sum(c, x => x.today), goal = cfg.display.campaign_goal;
  const flagged = X.cs.filter(x => x.review_status === 'pending').length;
  const g = gstats();
  el.innerHTML = `
    ${controlCard()}
    <div class="tiles">
      ${tile(fmt(total), 'مجموع الصلوات', 'gold')}${tile(fmt(todayT), 'مجموع اليوم')}
      ${tile(fmt(app), 'ضغطات التطبيق')}${tile(fmt(man), 'المضاف يدوياً (معتمد)' + (cfg.manual.include_in_totals ? '' : ' — غير محتسب'))}
      ${tile(fmt(X.cs.length), `المسجلون (${fmt(X.act.length)} نشط)`)}${tile(fmt(X.act.filter(x => x.today > 0).length), 'النشطون اليوم')}
      ${tile(fmt(X.cs.filter(x => x.activeNow).length), 'النشطون الآن (آخر دقيقتين)')}${tile(fmt(flagged), 'موسومون للمراجعة', flagged ? 'alert' : '')}
      ${pend ? tile(fmt(pend), 'إضافات يدوية بانتظار الاعتماد', 'alert') : ''}${adj ? tile(fmt(adj), 'تعديلات المشرف') : ''}
    </div>
    ${goal > 0 ? `<div class="card"><div class="row between"><b>تقدم هدف الحملة</b><span class="num">${fmt(total)} / ${fmt(goal)} (${pct(total, goal).toFixed(1)}%)</span></div><div class="progress" style="margin-top:8px"><i style="width:${pct(total, goal)}%"></i></div></div>` : ''}
    <div class="card"><h2>الرجال مقابل النساء</h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th class="n">المشاركون</th><th class="n">النشطون اليوم</th><th class="n">المجموع</th><th class="n">المتوسط لكل مشارك</th><th class="n">اليوم</th></tr></thead>
      <tbody>${['m', 'f'].map(k => `<tr><td><b>${k === 'm' ? 'الرجال' : 'النساء'}</b></td><td class="n">${fmt(g[k].n)}</td><td class="n">${fmt(g[k].activeToday)}</td><td class="n">${fmt(g[k].total)}</td><td class="n">${fmt(g[k].avg)}</td><td class="n">${fmt(g[k].today)}</td></tr>`).join('')}</tbody></table></div>
      <p style="margin:10px 0 0">المتصدر بالمجموع: <b>${g.leadTotal}</b> · المتصدر بالمتوسط: <b>${g.leadAvg}</b> <span class="small muted">(نعرض الاثنين لأن عدد الرجال والنساء قد يختلف)</span></p></div>`;
  bindControl(el);
}
function gstats() {
  const X = A.X, r = {};
  for (const k of ['m', 'f']) {
    const a = X.act.filter(c => c.gender === k), t = a.reduce((s, c) => s + c.total, 0);
    r[k] = { n: a.length, total: t, avg: a.length ? Math.round(t / a.length) : 0, today: a.reduce((s, c) => s + c.today, 0), activeToday: a.filter(c => c.today > 0).length };
  }
  const lead = (x, y) => x > y ? 'الرجال' : y > x ? 'النساء' : 'متعادلون';
  r.leadTotal = lead(r.m.total, r.f.total); r.leadAvg = lead(r.m.avg, r.f.avg);
  return r;
}

function controlCard() {
  const s = A.X.status, sc = A.cfg.schedule;
  const b = (a, l, cls = '') => `<button class="btn sm ${cls}" data-state="${a}">${l}</button>`;
  const btns = {
    draft: [sc.start_at ? b('activate', 'اعتماد الجدولة') : '', b('start_now', 'ابدأ الآن')],
    scheduled: [b('start_now', 'ابدأ الآن'), b('draft', 'إرجاع لمسودة', 'ghost')],
    running: [b('pause', 'إيقاف مؤقت', 'gold'), b('end_now', 'إنهاء الآن', 'danger')],
    paused: [b('resume', 'استئناف'), b('end_now', 'إنهاء الآن', 'danger')],
    ended: [b('start_now', 'إعادة التشغيل الآن', 'ghost'), `<button class="btn sm gold" data-go="draw">الانتقال للنتائج والسحب</button>`],
    published: [b('unpublish', 'إخفاء النتائج', 'ghost')]
  }[s] || [];
  return `<div class="card soft"><div class="row between"><div><b>حالة المسابقة:</b> <span class="status-chip ${s}">${STATUS_LABELS[s]}</span>
    <div class="small muted">الانطلاق: ${fmtDT(sc.start_at)} · الإيقاف: ${fmtDT(sc.end_at)} (بتوقيت الرياض)</div></div>
    <div class="row no-print">${btns.join('')}<button class="btn sm ghost" data-go="settings">تعديل الجدولة</button></div></div></div>`;
}
function bindControl(el) {
  const msgs = { start_now: 'ستبدأ المسابقة الآن ويصبح اليوم هو اليوم الأول. متابعة؟', end_now: 'ستنتهي المسابقة الآن ويتعطل زر الضغط عند الجميع (مع مهلة مزامنة للضغطات المحفوظة). متابعة؟', pause: 'إيقاف المسابقة مؤقتاً؟', unpublish: 'إخفاء النتائج عن المتسابقين؟' };
  $$('[data-state]', el).forEach(btn => btn.onclick = guard(btn, async () => {
    const a = btn.dataset.state;
    if (msgs[a] && !await confirmBox('تأكيد', msgs[a], a === 'end_now')) return;
    await act('sl_admin_state', { p_action: a }, 'تم تحديث حالة المسابقة');
  }));
  $$('[data-go]', el).forEach(btn => btn.onclick = () => { A.tab = btn.dataset.go; A.draft = null; render(); });
}

// ================= الباصات =================
function busRows() {
  const X = A.X, list = Object.values(X.buses).map(b => ({ id: b.id, name: b.name }));
  if (X.act.some(c => !c.bus_id)) list.push({ id: null, name: 'بدون باص' });
  return list.map(b => {
    const m = X.act.filter(c => (c.bus_id || null) === b.id), t = m.reduce((s, c) => s + c.total, 0);
    return { ...b, members: m.length, active: m.filter(c => c.today > 0).length, total: t, avg: m.length ? Math.round(t / m.length) : 0,
      men: m.filter(c => c.gender === 'm').reduce((s, c) => s + c.total, 0), women: m.filter(c => c.gender === 'f').reduce((s, c) => s + c.total, 0),
      today: m.reduce((s, c) => s + c.today, 0), list: m };
  }).sort((a, b) => b[A.busSort] - a[A.busSort]);
}
function vBuses(el) {
  const rows = busRows();
  el.innerHTML = `<div class="card"><div class="row between"><h2 style="margin:0">ترتيب الباصات</h2>
    <select class="input" id="bsort" style="width:auto;min-height:40px"><option value="total">حسب المجموع</option><option value="avg" ${A.busSort === 'avg' ? 'selected' : ''}>حسب المتوسط لكل فرد</option></select></div>
    <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>#</th><th>الباص</th><th class="n">الأعضاء</th><th class="n">النشطون اليوم</th><th class="n">المجموع</th><th class="n">المتوسط</th><th class="n">رجال</th><th class="n">نساء</th><th class="n">اليوم</th></tr></thead>
    <tbody>${rows.map((b, i) => `<tr class="click" data-bus="${b.id}"><td>${i + 1}</td><td><b>${esc(b.name)}</b></td><td class="n">${fmt(b.members)}</td><td class="n">${fmt(b.active)}</td><td class="n">${fmt(b.total)}</td><td class="n">${fmt(b.avg)}</td><td class="n">${fmt(b.men)}</td><td class="n">${fmt(b.women)}</td><td class="n">${fmt(b.today)}</td></tr>
      ${String(A.openBus) === String(b.id) ? `<tr><td colspan="9" style="background:#fbf8ef"><table class="tbl"><tbody>${b.list.sort((x, y) => y.total - x.total).map(c => `<tr class="click" data-c="${c.id}"><td>${esc(c.name)}</td><td>${GENDER[c.gender]}</td><td class="n">${fmt(c.today)} اليوم</td><td class="n"><b>${fmt(c.total)}</b></td></tr>`).join('') || '<tr><td>لا أعضاء</td></tr>'}</tbody></table></td></tr>` : ''}`).join('')}</tbody></table></div>
    <p class="small muted">اضغط على باص لعرض أعضائه. المنسحبون والمستبعدون لا يُحسبون في الباصات.</p></div>`;
  $('#bsort').onchange = (e) => { A.busSort = e.target.value; render(); };
  $$('[data-bus]', el).forEach(r => r.onclick = () => { A.openBus = String(A.openBus) === r.dataset.bus ? null : r.dataset.bus; render(); });
  $$('[data-c]', el).forEach(r => r.onclick = (e) => { e.stopPropagation(); openContestant(r.dataset.c); });
}

// ================= الأيام =================
function dayRows() {
  const X = A.X;
  return X.days.map(d => {
    let m = 0, f = 0;
    for (const c of X.counted) { const v = X.val(c.dmap[d.key]); if (c.gender === 'm') m += v; else f += v; }
    return { ...d, m, f, total: m + f, active: X.counted.filter(c => X.val(c.dmap[d.key]) > 0).length };
  });
}
function vDays(el) {
  const rows = dayRows(), max = Math.max(1, ...rows.map(r => r.total)), X = A.X;
  const T = rows.reduce((a, r) => ({ m: a.m + r.m, f: a.f + r.f, t: a.t + r.total }), { m: 0, f: 0, t: 0 });
  el.innerHTML = `<div class="card"><h2>مجموع كل يوم</h2>
    ${rows.length ? `<div class="vbars">${rows.map(r => `<div class="vbar"><span class="v">${fmt(r.total)}</span>
      <div class="track"><div class="stack-bar" style="height:${Math.max(1, r.total / max * 100)}%"><div class="m" style="flex:${r.m || 0}"></div><div class="f" style="flex:${r.f || 0}"></div></div></div><small>${esc(dayTitle(r))}</small></div>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--primary)"></i>رجال</span><span><i style="background:var(--gold)"></i>نساء</span></div>` : '<p class="muted">حدد تاريخ الانطلاق لعرض الأيام.</p>'}
    <div class="tbl-wrap" style="margin-top:14px"><table class="tbl"><thead><tr><th>اليوم</th><th>التاريخ</th><th>الهجري</th><th class="n">النشطون</th><th class="n">رجال</th><th class="n">نساء</th><th class="n">المجموع</th></tr></thead>
    <tbody>${rows.map(r => { const L = dayLabel(r.key); return `<tr ${r.key === X.today ? 'style="background:#f3f8f6"' : ''}><td><b>${esc(dayTitle(r))}</b></td><td>${L.weekday} ${L.greg}</td><td>${L.hijri}</td><td class="n">${fmt(r.active)}</td><td class="n">${fmt(r.m)}</td><td class="n">${fmt(r.f)}</td><td class="n"><b>${fmt(r.total)}</b></td></tr>`; }).join('')}</tbody>
    <tfoot><tr><td colspan="4">المجموع النهائي</td><td class="n">${fmt(T.m)}</td><td class="n">${fmt(T.f)}</td><td class="n">${fmt(T.t)}</td></tr></tfoot></table></div></div>`;
}

// ================= المتسابقون =================
function filtered() {
  const f = A.filt, q = toLatinDigits(f.q).trim().toLowerCase(), qp = q.replace(/\D/g, '');
  let r = A.X.cs.filter(c => (!q || c.name.toLowerCase().includes(q) || (qp.length >= 3 && (c.phone.includes(qp) || displayPhone(c.phone).includes(qp))))
    && (!f.bus || String(c.bus_id) === f.bus) && (!f.g || c.gender === f.g) && (!f.st || c.status === f.st)
    && (!f.today || c.today > 0) && (!f.flag || c.review_status === 'pending'));
  const k = A.sort.k, d = A.sort.d;
  r.sort((a, b) => { const x = a[k] ?? '', y = b[k] ?? ''; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ar')) * d; });
  return r;
}
function vPeople(el) {
  const X = A.X, f = A.filt;
  const cols = [['name', 'الاسم'], ['phone', 'الجوال'], ['gender', 'الجنس'], ['bus', 'الباص'], ['today', 'اليوم', 1], ['total', 'الإجمالي', 1], ['app_total', 'التطبيق', 1], ['manual_total', 'يدوي', 1], ['shares', 'الأسهم', 1], ['last_sync_at', 'آخر نشاط'], ['review_status', 'علامات']];
  el.innerHTML = `<div class="card">
    <div class="row between" style="margin-bottom:10px"><h2 style="margin:0">المتسابقون (${fmt(X.cs.length)})</h2>
      <div class="row no-print"><button class="btn sm" id="add">+ إضافة متسابق</button><button class="btn sm ghost" id="imp">استيراد Excel/CSV</button><button class="btn sm ghost" id="exp">تصدير Excel</button></div></div>
    <div class="filters no-print">
      <input class="input search" id="q" placeholder="بحث بالاسم أو الجوال" value="${esc(f.q)}">
      <select class="input" data-f="bus"><option value="">كل الباصات</option>${Object.values(X.buses).map(b => `<option value="${b.id}" ${f.bus === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      <select class="input" data-f="g"><option value="">الجنسان</option><option value="m" ${f.g === 'm' ? 'selected' : ''}>رجال</option><option value="f" ${f.g === 'f' ? 'selected' : ''}>نساء</option></select>
      <select class="input" data-f="st"><option value="">كل الحالات</option>${Object.entries(CSTATUS).map(([k, l]) => `<option value="${k}" ${f.st === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="check small"><input type="checkbox" data-f="today" ${f.today ? 'checked' : ''}> نشط اليوم</label>
      <label class="check small"><input type="checkbox" data-f="flag" ${f.flag ? 'checked' : ''}> موسوم للمراجعة</label>
    </div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map(([k, l, n]) => `<th class="sort ${n ? 'n' : ''} ${A.sort.k === k ? (A.sort.d > 0 ? 'asc' : 'desc') : ''}" data-sort="${k}">${l}</th>`).join('')}</tr></thead>
    <tbody id="rows"></tbody></table></div></div>`;
  const draw = () => {
    const r = filtered();
    $('#rows').innerHTML = r.map(c => `<tr class="click ${c.status !== 'active' ? 'dim' : ''}" data-c="${c.id}"><td><b>${esc(c.name)}</b></td><td dir="ltr" style="text-align:right">${esc(displayPhone(c.phone))}</td><td>${GENDER[c.gender]}</td><td>${esc(c.bus)}</td>
      <td class="n">${fmt(c.today)}</td><td class="n"><b>${fmt(c.total)}</b></td><td class="n">${fmt(c.app_total)}</td><td class="n">${fmt(c.manual_total)}${c.manual_pending ? ` <span class="tag amber">+${fmt(c.manual_pending)}</span>` : ''}</td><td class="n">${fmt(c.shares)}</td>
      <td class="small">${c.last_sync_at ? fmtDT(c.last_sync_at) : '—'}</td><td>${tags(c)}</td></tr>`).join('') || `<tr><td colspan="11" class="muted center">لا نتائج</td></tr>`;
    $$('[data-c]', el).forEach(tr => tr.onclick = () => openContestant(tr.dataset.c));
  };
  draw();
  $('#q').oninput = (e) => { f.q = e.target.value; draw(); };
  $$('[data-f]', el).forEach(i => i.onchange = () => { f[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.value; draw(); });
  $$('[data-sort]', el).forEach(th => th.onclick = () => { const k = th.dataset.sort; A.sort = { k, d: A.sort.k === k ? -A.sort.d : (['name', 'bus', 'phone', 'gender'].includes(k) ? 1 : -1) }; vPeople(el); });
  on('#add', () => editContestant(null), el);
  on('#imp', importDialog, el);
  on('#exp', () => exportExcel(['people']), el);
}

async function editContestant(c) {
  const buses = Object.values(A.X.buses);
  const v = await dialog({
    title: c ? 'تعديل بيانات متسابق' : 'إضافة متسابق', ok: 'حفظ', fields: [
      { id: 'name', label: 'الاسم', required: true, value: c ? c.name : '' },
      { id: 'phone', label: 'الجوال', required: true, value: c ? displayPhone(c.phone) : '', dir: 'ltr', type: 'tel' },
      { id: 'gender', label: 'الجنس', type: 'select', value: c ? c.gender : 'm', options: [['m', 'رجل'], ['f', 'امرأة']] },
      { id: 'bus_id', label: 'الباص', type: 'select', value: c ? c.bus_id : (buses[0] || {}).id, options: [['', '— اختر أو اكتب باصاً جديداً أدناه —'], ...buses.map(b => [b.id, b.name])] },
      { id: 'bus_name', label: 'أو باص جديد (اسم أو رقم)', placeholder: 'مثال: 4' }]
  });
  if (!v) return;
  if (!normalizePhone(v.phone)) return toast('رقم الجوال غير صحيح', 'error');
  await act('sl_admin_upsert_contestant', { p: { id: c ? c.id : null, name: v.name, phone: v.phone, gender: v.gender, bus_id: v.bus_name ? null : (v.bus_id || null), bus_name: v.bus_name || null, joined_at: c ? null : new Date().toISOString() } }, 'تم الحفظ');
}

async function openContestant(id) {
  const c = A.X.byId[id]; if (!c) return;
  const det = await call('sl_admin_contestant', { p_id: id }).catch(e => { toast(errMsg(e), 'error'); return null; });
  if (!det) return;
  const X = A.X;
  const days = X.days.map(d => { const v = c.dmap[d.key] || [0, 0, 0]; return `<tr><td>${esc(dayTitle(d))}</td><td class="small">${dayLabel(d.key).greg}</td><td class="n">${fmt(v[0])}</td><td class="n">${fmt(v[1])}</td><td class="n">${fmt(v[2])}</td><td class="n"><b>${fmt(X.val(v))}</b></td></tr>`; }).join('');
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal wide">
    <div class="row between"><h2 style="margin:0">${esc(c.name)} ${tags(c)}</h2><button class="btn sm ghost" data-x>إغلاق</button></div>
    <p class="muted small" style="margin:4px 0 12px"><span dir="ltr">${esc(displayPhone(c.phone))}</span> · ${GENDER[c.gender]} · ${esc(c.bus || 'بدون باص')} · التحق ${fmtDT(c.joined_at)} (${({ admin: 'المشرف', self: 'تسجيل ذاتي', import: 'استيراد', sim: 'محاكاة', seed: 'تجريبي' })[c.created_by] || c.created_by}) · ${det.sessions} جلسة فعالة${c.pin_set ? ' · لديه رمز سري' : ''}</p>
    <div class="tiles">${tile(fmt(c.total), 'الإجمالي', 'gold')}${tile(fmt(c.app_total), 'ضغطات التطبيق')}${tile(fmt(c.manual_total), 'يدوي معتمد')}${tile(fmt(c.manual_pending), 'يدوي معلّق')}${tile(fmt(c.adj_total), 'تعديلات')}${tile(fmt(c.rejected_total), 'ضغطات مرفوضة', c.rejected_total ? 'alert' : '')}${tile(fmt(c.shares), 'الأسهم')}${tile(fmt(c.activeDays), 'أيام نشطة')}</div>
    ${c.flag_reasons && c.flag_reasons.length ? `<div class="card soft"><b>علامات المراجعة:</b> ${c.flag_reasons.map(r => `<span class="tag red">${FLAG[r] || r}</span>`).join('')} — الحالة: <b>${REVIEW[c.review_status] || 'لا شيء'}</b>
      <div class="small muted">أقل فاصل رُصد: ${c.stats.min_gap ?? '—'} ms · متوسط آخر دفعة: ${c.stats.last_avg ?? '—'} ms · الانحراف: ${c.stats.last_sd ?? '—'} ms${c.review_note ? ' · ملاحظة: ' + esc(c.review_note) : ''}</div></div>` : ''}
    <div class="row no-print" style="margin-bottom:12px">
      <button class="btn sm" id="c-edit">تعديل البيانات</button><button class="btn sm ghost" id="c-adj">تعديل العدد ±</button>
      ${c.review_status === 'pending' ? `<button class="btn sm gold" id="c-review">قرار المراجعة</button>` : `<button class="btn sm ghost" id="c-review">مراجعة</button>`}
      <button class="btn sm ghost" id="c-status">تغيير الحالة</button><button class="btn sm ghost" id="c-ovr">استثناء السحب</button>
      ${c.pin_set ? `<button class="btn sm ghost" id="c-pin">إعادة تعيين الرمز السري</button>` : ''}
      <button class="btn sm danger" id="c-del">حذف نهائي</button></div>
    <div class="grid2">
      <div><h3>تفصيل الأيام</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>اليوم</th><th>التاريخ</th><th class="n">تطبيق</th><th class="n">يدوي</th><th class="n">تعديل</th><th class="n">المجموع</th></tr></thead><tbody>${days}</tbody></table></div></div>
      <div><h3>الإضافات اليدوية والتعديلات</h3><div class="tbl-wrap"><table class="tbl"><tbody>
        ${det.manual.map(m => `<tr><td class="small">${fmtDT(m.created_at)}</td><td>يدوي</td><td class="n">${fmt(m.count)}</td><td><span class="tag">${MSTATUS[m.status]}</span></td><td>${m.status === 'approved' ? `<button class="btn sm ghost" data-rev="${m.id}">تراجع</button>` : m.status === 'pending' ? `<button class="btn sm" data-ap="${m.id}">اعتماد</button>` : ''}</td></tr>`).join('')}
        ${det.adjustments.map(a => `<tr><td class="small">${fmtDT(a.created_at)}</td><td>${a.kind === 'review_deduct' ? 'خصم مراجعة' : 'تعديل'}</td><td class="n">${a.delta > 0 ? '+' : ''}${fmt(a.delta)}</td><td colspan="2" class="small">${esc(a.reason)}</td></tr>`).join('')}
        ${!det.manual.length && !det.adjustments.length ? '<tr><td class="muted">لا يوجد</td></tr>' : ''}</tbody></table></div></div>
    </div>
    <h3 style="margin-top:14px">سجل الدفعات (${fmt(det.batch_count)})</h3>
    <div class="tbl-wrap" style="max-height:260px"><table class="tbl"><thead><tr><th>الوقت</th><th>اليوم</th><th class="n">مرسل</th><th class="n">مقبول</th><th class="n">مرفوض</th><th>السبب</th><th class="n">أقل فاصل</th><th class="n">متوسط</th><th class="n">انحراف</th></tr></thead>
      <tbody>${det.batches.map(b => `<tr><td class="small">${fmtDT(b.received_at)}</td><td class="small">${b.day_date}</td><td class="n">${fmt(b.requested)}</td><td class="n">${fmt(b.accepted)}</td><td class="n">${b.rejected ? `<b style="color:var(--danger)">${fmt(b.rejected)}</b>` : 0}</td><td class="small">${({ ok: '—', speed: 'سرعة', closed: 'خارج الوقت', daily_cap: 'سقف يومي', batch_cap: 'سقف الدفعة' })[b.reason] || b.reason}</td><td class="n">${b.client_stats && b.client_stats.min != null ? b.client_stats.min : '—'}</td><td class="n">${b.client_stats && b.client_stats.avg != null ? b.client_stats.avg : '—'}</td><td class="n">${b.client_stats && b.client_stats.sd != null ? b.client_stats.sd : '—'}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">لا توجد دفعات</td></tr>'}</tbody></table></div>
    ${det.audit.length ? `<h3 style="margin-top:14px">إجراءات المشرف</h3><ul class="list small">${det.audit.map(a => `<li><span>${fmtDT(a.at)} · ${esc(ACTIONS[a.action] || a.action)}${a.reason ? ' — ' + esc(a.reason) : ''}</span><span class="muted">${esc(a.actor || '')}</span></li>`).join('')}</ul>` : ''}
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  $('[data-x]', bg).onclick = close; bg.onclick = (e) => { if (e.target === bg) close(); };
  const reopen = async () => { close(); await load(true); openContestant(id); };
  on('#c-edit', async () => { close(); await editContestant(c); }, bg);
  on('#c-adj', async () => {
    const v = await askReason('تعديل عدد ' + c.name, [{ id: 'delta', label: 'العدد (موجب للزيادة، سالب للنقص)', type: 'number', required: true }]);
    const n = Math.trunc(Number(v.delta)); if (!n) return toast('اكتب عدداً غير صفري', 'error');
    await act('sl_admin_adjust', { p_id: id, p_delta: n, p_reason: v.reason }, 'سُجّل التعديل'); reopen();
  }, bg);
  on('#c-review', async () => {
    const v = await dialog({ title: 'قرار المراجعة — ' + esc(c.name), html: `<p class="small muted">العلامات للفحص وليست عقوبة تلقائية. القرار يُسجَّل مع سببه.</p>`, ok: 'تنفيذ', fields: [
      { id: 'decision', label: 'القرار', type: 'select', value: 'approve', options: [['approve', 'اعتماد (لا شيء مريب)'], ['deduct', 'خصم عدد'], ['exclude', 'استبعاد من المسابقة'], ['reset', 'مسح العلامات']] },
      { id: 'delta', label: 'عدد الخصم (عند اختيار الخصم)', type: 'number', value: c.rejected_total || '' },
      { id: 'reason', label: 'السبب', type: 'textarea', required: true }] });
    if (!v) return;
    await act('sl_admin_review', { p_id: id, p_decision: v.decision, p_delta: Math.abs(Math.trunc(Number(v.delta) || 0)), p_reason: v.reason }, 'سُجّل القرار'); reopen();
  }, bg);
  on('#c-status', async () => {
    const v = await askReason('تغيير حالة ' + c.name, [{ id: 'status', label: 'الحالة', type: 'select', value: c.status, options: Object.entries(CSTATUS) }]);
    await act('sl_admin_set_status', { p_id: id, p_status: v.status, p_reason: v.reason }, 'تم تغيير الحالة'); reopen();
  }, bg);
  on('#c-ovr', async () => {
    const v = await dialog({ title: 'استثناء يدوي من السحب', ok: 'حفظ', fields: [
      { id: 'mode', label: 'الاستثناء', type: 'select', value: c.override ? c.override.mode : '', options: [['', 'بلا استثناء (تطبق الشروط)'], ['include', 'إدراج بالقوة'], ['exclude', 'استبعاد من السحب']] },
      { id: 'reason', label: 'السبب', type: 'textarea', value: c.override ? c.override.reason : '' }] });
    if (!v) return;
    if (v.mode && !v.reason) return toast('السبب مطلوب', 'error');
    await act('sl_admin_override', { p_id: id, p_mode: v.mode || null, p_reason: v.reason || null }, 'تم الحفظ'); reopen();
  }, bg);
  on('#c-pin', async () => { if (await confirmBox('إعادة تعيين الرمز', 'سيُطلب من المتسابق إنشاء رمز جديد عند الدخول، وتُلغى جلساته.')) { await act('sl_admin_reset_pin', { p_id: id }); reopen(); } }, bg);
  on('#c-del', async () => {
    if (!await confirmBox('حذف نهائي', `سيُحذف <b>${esc(c.name)}</b> نهائياً مع <b>${fmt(c.app_total)}</b> ضغطة و<b>${fmt(c.manual_total + c.manual_pending)}</b> إضافة يدوية و${fmt(det.batch_count)} دفعة. لا يمكن التراجع. هل تريد بدلاً من ذلك تغيير حالته إلى منسحب؟`, true, 'متابعة الحذف')) return;
    const v = await askReason('تأكيد ثانٍ: اكتب سبب الحذف النهائي');
    await act('sl_admin_delete_contestant', { p_id: id, p_reason: v.reason }, 'حُذف المتسابق'); close();
  }, bg);
  $$('[data-rev]', bg).forEach(b => b.onclick = guard(b, async () => { const v = await askReason('التراجع عن إضافة يدوية'); await act('sl_admin_manual', { p_id: Number(b.dataset.rev), p_action: 'revert', p_reason: v.reason }); reopen(); }));
  $$('[data-ap]', bg).forEach(b => b.onclick = guard(b, async () => { await act('sl_admin_manual', { p_id: Number(b.dataset.ap), p_action: 'approve' }, 'اعتُمدت'); reopen(); }));
}

// استيراد قائمة من Excel/CSV مع معاينة
async function importDialog() {
  const XLSX = await loadScript(XLSX_URL, 'XLSX');
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal wide"><h2>استيراد المتسابقين</h2>
    <p class="small muted">ملف Excel أو CSV بأعمدة: <b>الاسم، الجوال، الجنس، رقم الباص</b> (الصف الأول عناوين). الجنس: رجل/امرأة أو ذكر/أنثى. تُنشأ الباصات تلقائياً.</p>
    <input type="file" id="file" accept=".xlsx,.xls,.csv" class="input">
    <div id="prev" style="margin-top:12px"></div>
    <div class="actions"><button class="btn ghost" data-x>إغلاق</button><button class="btn hidden" id="save">حفظ</button></div></div>`;
  document.body.appendChild(bg);
  $('[data-x]', bg).onclick = () => bg.remove();
  let rows = [];
  $('#file', bg).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    const head = (data[0] || []).map(h => String(h).trim().toLowerCase());
    const col = (re) => head.findIndex(h => re.test(h));
    const ci = { name: col(/اسم|name/), phone: col(/جوال|هاتف|phone|mobile|رقم ال?ج/), gender: col(/جنس|gender|sex/), bus: col(/باص|bus|حافلة/) };
    if (ci.name < 0 || ci.phone < 0) { $('#prev', bg).innerHTML = `<p class="err">لم أجد عمودي الاسم والجوال في الصف الأول.</p>`; return; }
    const existing = new Set(A.X.cs.map(c => c.phone)), seen = new Set();
    rows = data.slice(1).filter(r => r.some(x => String(x).trim())).map((r, i) => {
      const name = String(r[ci.name] || '').trim(), ph = normalizePhone(r[ci.phone]);
      const gr = String(ci.gender >= 0 ? r[ci.gender] : '').trim().toLowerCase();
      const g = /^(m|male|ذكر|رجل|رجال|ر)$/.test(gr) ? 'm' : /^(f|female|أنثى|انثى|امرأة|امراة|نساء|ن|إمرأة)$/.test(gr) ? 'f' : '';
      const bus = String(ci.bus >= 0 ? r[ci.bus] : '').trim();
      let st = 'ok', note = '';
      if (name.length < 2) { st = 'err'; note = 'الاسم ناقص'; }
      else if (!ph) { st = 'err'; note = 'جوال غير صحيح'; }
      else if (!g) { st = 'err'; note = 'الجنس غير معروف'; }
      else if (seen.has(ph)) { st = 'dup'; note = 'مكرر في الملف'; }
      else if (existing.has(ph)) { st = 'exists'; note = 'موجود مسبقاً'; }
      if (ph) seen.add(ph);
      return { line: i + 2, name, phone: ph, rawPhone: r[ci.phone], gender: g, bus, st, note };
    });
    const cnt = (s) => rows.filter(r => r.st === s).length;
    $('#prev', bg).innerHTML = `<div class="row" style="margin-bottom:8px"><span class="tag green">جديد: ${cnt('ok')}</span><span class="tag blue">موجود: ${cnt('exists')}</span><span class="tag amber">مكرر في الملف: ${cnt('dup')}</span><span class="tag red">أخطاء: ${cnt('err')}</span></div>
      <label class="field"><span>عند وجود الرقم مسبقاً</span><select class="input" id="dup"><option value="skip">تخطي</option><option value="update">تحديث البيانات</option></select></label>
      <div class="tbl-wrap" style="max-height:340px"><table class="tbl"><thead><tr><th>سطر</th><th>الاسم</th><th>الجوال</th><th>الجنس</th><th>الباص</th><th>الحالة</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.st === 'err' || r.st === 'dup' ? 'dim' : ''}"><td>${r.line}</td><td>${esc(r.name)}</td><td dir="ltr" style="text-align:right">${esc(r.phone ? displayPhone(r.phone) : r.rawPhone)}</td><td>${GENDER[r.gender] || '—'}</td><td>${esc(r.bus)}</td><td>${r.note ? `<span class="tag ${r.st === 'err' ? 'red' : r.st === 'exists' ? 'blue' : 'amber'}">${r.note}</span>` : '<span class="tag green">جديد</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    $('#save', bg).classList.toggle('hidden', !(cnt('ok') + cnt('exists')));
  };
  const sv = $('#save', bg);
  sv.onclick = guard(sv, async () => {
    const valid = rows.filter(r => r.st === 'ok' || r.st === 'exists').map(r => ({ name: r.name, phone: r.phone, gender: r.gender, bus: r.bus }));
    const res = await call('sl_admin_import', { p_rows: valid, p_on_dup: $('#dup', bg).value });
    bg.remove();
    toast(`أُضيف ${res.inserted} · حُدّث ${res.updated} · تُخطّي ${res.skipped} · أخطاء ${res.invalid} · باصات جديدة ${res.buses_created}`, 'ok');
    await load(true);
  });
}

// ================= الأعلى =================
function ranked(list) { return [...list].filter(c => c.total > 0).sort((a, b) => b.total - a.total || (a.reached_at || '9').localeCompare(b.reached_at || '9')); }
function vTop(el) {
  const X = A.X, t = (title, arr) => `<div class="card"><h2>${title}</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>الاسم</th><th>الباص</th><th class="n">الإجمالي</th><th class="n">الأسهم</th></tr></thead>
    <tbody>${arr.map((c, i) => `<tr class="click" data-c="${c.id}"><td>${i + 1}</td><td><b>${esc(c.name)}</b> ${c.review_status === 'pending' ? '<span class="tag red">للمراجعة</span>' : ''}</td><td>${esc(c.bus)}</td><td class="n"><b>${fmt(c.total)}</b></td><td class="n">${fmt(c.shares)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">لا يوجد</td></tr>'}</tbody></table></div></div>`;
  el.innerHTML = t('أعلى 20 عموماً', ranked(X.act).slice(0, 20)) + `<div class="grid2">${t('أعلى 10 رجال', ranked(X.act.filter(c => c.gender === 'm')).slice(0, 10))}${t('أعلى 10 نساء', ranked(X.act.filter(c => c.gender === 'f')).slice(0, 10))}</div>
    <p class="small muted">التعادل يُحسم بمن بلغ العدد أولاً. هذه قائمة حيّة للمشرف فقط ولا تظهر للمتسابقين.</p>`;
  $$('[data-c]', el).forEach(r => r.onclick = () => openContestant(r.dataset.c));
}

// ================= المراجعة والإضافات اليدوية =================
function vReview(el) {
  const X = A.X, flagged = X.cs.filter(c => c.review_status === 'pending'), decided = X.cs.filter(c => ['approved', 'deducted', 'excluded'].includes(c.review_status));
  const man = A.D.manual || [], pend = man.filter(m => m.status === 'pending');
  const nm = (id) => (X.byId[id] || {}).name || '—';
  el.innerHTML = `
    <div class="card"><h2>موسومون للمراجعة (${flagged.length})</h2><p class="small muted">علامات للفحص فقط وليست عقوبة. افتح المتسابق لرؤية سجل دفعاته ثم قرّر: اعتماد / خصم / استبعاد مع سبب.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>الاسم</th><th>الباص</th><th>العلامات</th><th class="n">الإجمالي</th><th class="n">المرفوض</th><th class="n">أقل فاصل</th><th class="n">الانحراف</th><th></th></tr></thead>
      <tbody>${flagged.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.bus)}</td><td>${c.flag_reasons.map(r => `<span class="tag red">${FLAG[r] || r}</span>`).join('')}</td><td class="n">${fmt(c.total)}</td><td class="n">${fmt(c.rejected_total)}</td><td class="n">${c.stats.min_gap ?? '—'}</td><td class="n">${c.stats.last_sd ?? '—'}</td><td><button class="btn sm" data-c="${c.id}">فتح وقرار</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">لا يوجد 👍</td></tr>'}</tbody></table></div></div>
    <div class="card"><h2>إضافات يدوية بانتظار الاعتماد (${pend.length})</h2>
      ${pend.length ? `<div class="row no-print" style="margin-bottom:8px"><button class="btn sm" id="ap-all">اعتماد الكل</button></div>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>المتسابق</th><th>اليوم</th><th class="n">العدد</th><th></th></tr></thead>
      <tbody>${pend.map(m => `<tr><td class="small">${fmtDT(m.created_at)}</td><td>${esc(nm(m.contestant_id))}</td><td class="small">${m.day_date}</td><td class="n"><b>${fmt(m.count)}</b></td><td><button class="btn sm" data-ap="${m.id}">اعتماد</button> <button class="btn sm ghost" data-rj="${m.id}">رفض</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">لا يوجد</td></tr>'}</tbody></table></div></div>
    <div class="card"><h2>سجل الإضافات اليدوية</h2><div class="tbl-wrap" style="max-height:380px"><table class="tbl"><thead><tr><th>الوقت</th><th>المتسابق</th><th class="n">العدد</th><th>الحالة</th><th>بواسطة</th><th></th></tr></thead>
      <tbody>${man.filter(m => m.status !== 'pending').map(m => `<tr><td class="small">${fmtDT(m.created_at)}</td><td>${esc(nm(m.contestant_id))}</td><td class="n">${fmt(m.count)}</td><td><span class="tag">${MSTATUS[m.status]}</span></td><td class="small">${esc(m.decided_by || '')}</td><td>${m.status === 'approved' ? `<button class="btn sm ghost" data-rv="${m.id}">تراجع</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">لا يوجد</td></tr>'}</tbody></table></div></div>
    ${decided.length ? `<div class="card"><h2>قرارات سابقة</h2><ul class="list">${decided.map(c => `<li><span>${esc(c.name)} — <span class="tag blue">${REVIEW[c.review_status]}</span> <span class="small muted">${esc(c.review_note || '')}</span></span><button class="btn sm ghost" data-c="${c.id}">فتح</button></li>`).join('')}</ul></div>` : ''}`;
  $$('[data-c]', el).forEach(b => b.onclick = () => openContestant(b.dataset.c));
  $$('[data-ap]', el).forEach(b => b.onclick = guard(b, () => act('sl_admin_manual', { p_id: Number(b.dataset.ap), p_action: 'approve' }, 'اعتُمدت')));
  $$('[data-rj]', el).forEach(b => b.onclick = guard(b, async () => { const v = await askReason('رفض إضافة يدوية'); await act('sl_admin_manual', { p_id: Number(b.dataset.rj), p_action: 'reject', p_reason: v.reason }, 'رُفضت'); }));
  $$('[data-rv]', el).forEach(b => b.onclick = guard(b, async () => { const v = await askReason('التراجع عن إضافة معتمدة'); await act('sl_admin_manual', { p_id: Number(b.dataset.rv), p_action: 'revert', p_reason: v.reason }, 'تم التراجع'); }));
  on('#ap-all', async () => {
    if (!await confirmBox('اعتماد الكل', `اعتماد ${pend.length} إضافة بمجموع ${fmt(pend.reduce((a, m) => a + m.count, 0))}؟`)) return;
    for (const m of pend) await call('sl_admin_manual', { p_id: m.id, p_action: 'approve' });
    toast('اعتُمدت كل الإضافات', 'ok'); await load(true);
  }, el);
}

// ================= السحب =================
function rulesSummary() {
  const d = A.cfg.draw, out = [];
  out.push(d.shares_enabled ? `نظام الأسهم: كل ${fmt(d.share_value)} صلاة = سهم${d.max_shares > 0 ? ` (حد أقصى ${d.max_shares} أسهم)` : ''}` : 'بدون أسهم: لكل مؤهل فرصة واحدة');
  if (d.min_total.on) out.push(`حد أدنى للإجمالي ${fmt(d.min_total.value)}`);
  if (d.active_days.on) out.push(`أيام نشطة ≥ ${d.active_days.days} (اليوم النشط ≥ ${fmt(d.active_days.day_min)})`);
  if (d.exclude_flagged) out.push('استبعاد الموسومين للمراجعة');
  if (d.exclude_inactive) out.push('استبعاد المنسحبين والمستبعدين');
  if (d.exclude_prev_winners) out.push('استبعاد الفائزين في جولات سابقة');
  if (d.exclude_top.on) out.push('استبعاد أصحاب المراكز الأولى');
  out.push(d.include_manual ? 'الإضافات اليدوية محتسبة' : 'الإضافات اليدوية غير محتسبة');
  (d.custom || []).filter(c => c.on).forEach(c => out.push(`شرط مخصص: ${esc(c.name || '')} (${CFIELDS[c.field]} ${OPS[c.op]} ${esc(c.value)})`));
  return out;
}
function vDraw(el) {
  const X = A.X, D = A.D, snap = D.snapshot, rounds = [...D.rounds].reverse(), st = X.status, cfg = A.cfg;
  const titles = { overall: 'الأكثر ذكراً عموماً', m: 'الرجال', f: 'النساء' };
  el.innerHTML = `
    <div class="card"><h2>أ) الأكثر ذكراً — تجميد النتائج والإعلان</h2>
      <p class="small muted">يُعلن أعلى ${cfg.results.top_n} ${({ overall: 'عموماً', gender: 'لكل جنس', both: 'عموماً ولكل جنس' })[cfg.results.scope]} (من الإعدادات). التعادل يُحسم بمن بلغ العدد أولاً. التجميد يحفظ لقطة ثابتة للأرقام قبل الإعلان.</p>
      <div class="row no-print"><button class="btn sm" id="freeze">${snap ? 'إعادة تجميد النتائج الآن' : 'تجميد النتائج'}</button>
      ${A.test ? '' : st === 'published' ? `<button class="btn sm ghost" id="unpub">إخفاء النتائج</button>` : `<button class="btn sm gold" id="pub">نشر النتائج للمتسابقين</button>`}</div>
      ${snap ? `<p class="small muted">آخر تجميد: ${fmtDT(snap.created_at)}</p><div class="grid2">${Object.entries(snap.data.lists).map(([k, l]) => `<div><h3>${titles[k]}</h3><ol class="small" style="margin:0;padding-inline-start:20px">${l.map(e => `<li>${esc(e.name)} <span class="muted">— ${esc(e.bus || '')} · ${fmt(e.total)}</span></li>`).join('') || '<li class="muted">لا يوجد</li>'}</ol></div>`).join('')}</div>` : ''}
    </div>
    <div class="card"><h2>ب) السحب بنظام الأسهم</h2>
      <div class="row between"><b>شروط السحب الحالية</b><button class="btn sm ghost no-print" id="edit-rules">تعديل الشروط</button></div>
      <ul class="small" style="margin:6px 0 14px">${rulesSummary().map(x => `<li>${x}</li>`).join('')}</ul>
      <form id="f-round" class="no-print"><div class="form-grid">
        <label class="field"><span>اسم الجولة</span><input class="input" id="r-name" value="${rounds.filter(r => r.status === 'done').length ? 'جوائز أخرى' : 'الجوائز الكبرى'}" required></label>
        <label class="field"><span>عدد الفائزين</span><input class="input" id="r-count" type="number" min="1" value="3" required></label>
        <label class="field"><span>الجنس</span><select class="input" id="r-g"><option value="all">الكل</option><option value="m">رجال فقط</option><option value="f">نساء فقط</option></select></label></div>
        <div class="row"><button type="button" class="btn ghost" id="prev-btn">معاينة المؤهلين</button><button class="btn" id="run">تنفيذ السحب</button></div></form>
      <div id="preview" style="margin-top:12px"></div>
    </div>
    ${rounds.map(r => roundCard(r)).join('')}`;
  on('#freeze', async () => { if (await confirmBox('تجميد النتائج', 'حفظ لقطة ثابتة بالأرقام الحالية للأكثر ذكراً؟')) await act('sl_admin_freeze', { p_test: A.test }, 'جُمّدت النتائج'); }, el);
  on('#pub', async () => { if (await confirmBox('نشر النتائج', 'سيرى جميع المتسابقين صفحة الفائزين (الأسماء والباصات فقط)، ويتعطل زر الضغط. ' + (snap ? '' : 'سيتم تجميد النتائج تلقائياً.'))) await act('sl_admin_state', { p_action: 'publish' }, 'نُشرت النتائج'); }, el);
  on('#unpub', async () => { if (await confirmBox('إخفاء النتائج', 'إخفاء صفحة النتائج عن المتسابقين؟')) await act('sl_admin_state', { p_action: 'unpublish' }, 'أُخفيت النتائج'); }, el);
  $('#edit-rules').onclick = () => { A.tab = 'settings'; A.draft = null; render(); setTimeout(() => { const s = $('#sec-draw'); if (s) s.scrollIntoView(); }, 50); };
  const params = () => ({ name: $('#r-name').value.trim(), count: Math.trunc(Number($('#r-count').value)), g: $('#r-g').value });
  on('#prev-btn', async () => { const p = params(); A.preview = { ...(await call('sl_draw_preview', { p_gender: p.g, p_test: A.test })), want: p.count }; showPreview(); }, el);
  on('#run', async () => {
    const p = params(); if (!p.name || !(p.count >= 1)) return toast('أكمل اسم الجولة وعدد الفائزين', 'error');
    const pv = await call('sl_draw_preview', { p_gender: p.g, p_test: A.test }); A.preview = { ...pv, want: p.count }; showPreview();
    if (!pv.count) return toast('لا يوجد مؤهلون للسحب بهذه الشروط', 'error');
    if (!await confirmBox('تنفيذ السحب', `جولة <b>${esc(p.name)}</b>: ${p.count} فائز من <b>${pv.count}</b> مؤهل (${fmt(pv.total_shares)} سهم).${pv.count < p.count ? '<br><b style="color:var(--danger)">تنبيه: المؤهلون أقل من عدد الفائزين، سيفوز جميع المؤهلين.</b>' : ''}<br>يُحسم السحب على الخادم ويُقفل بعد التنفيذ.`)) return;
    const res = await call('sl_run_draw', { p_name: p.name, p_count: p.count, p_gender: p.g, p_test: A.test });
    toast(`تم السحب: ${res.winners} فائز`, 'ok'); A.preview = null; await load(true);
    if (await confirmBox('عرض النتائج', 'فتح شاشة العرض بملء الشاشة الآن؟', false, 'افتح شاشة العرض')) drawScreen(res.round_id);
  }, el);
  showPreview();
  bindRounds(el);
}
function showPreview() {
  const box = $('#preview'), p = A.preview; if (!box) return;
  if (!p) { box.innerHTML = ''; return; }
  box.innerHTML = `${p.count < p.want ? `<div class="banner wait">تنبيه: عدد المؤهلين (${p.count}) أقل من عدد الفائزين المطلوب (${p.want}).</div>` : ''}
    <div class="row between"><b>المؤهلون: ${fmt(p.count)} · مجموع الأسهم: ${fmt(p.total_shares)}</b><button class="btn sm ghost" id="pv-x">إخفاء</button></div>
    <div class="tbl-wrap" style="max-height:380px;margin-top:8px"><table class="tbl"><thead><tr><th>#</th><th>الاسم</th><th>الباص</th><th>الجنس</th><th class="n">الإجمالي</th><th class="n">أيام نشطة</th><th class="n">الأسهم</th><th class="n">نسبة الفوز بالسحبة الأولى</th></tr></thead>
    <tbody>${p.entries.map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.name)} ${e.forced ? '<span class="tag green">إدراج بالقوة</span>' : ''}</td><td>${esc(e.bus_name || '')}</td><td>${GENDER[e.gender]}</td><td class="n">${fmt(e.total)}</td><td class="n">${e.active_days}</td><td class="n"><b>${fmt(e.shares)}</b></td><td class="n">${pct(e.shares, p.total_shares).toFixed(2)}%</td></tr>`).join('')}</tbody></table></div>`;
  $('#pv-x').onclick = () => { A.preview = null; showPreview(); };
}
function roundCard(r) {
  const ws = A.D.winners.filter(w => w.round_id === r.id), cancelled = r.status === 'cancelled';
  return `<div class="card" ${cancelled ? 'style="opacity:.6"' : ''}><div class="row between"><div><h2 style="margin:0">${esc(r.name)} ${cancelled ? '<span class="tag red">ملغى</span>' : '<span class="tag green">منفذ ومقفل</span>'}</h2>
    <div class="small muted">${fmtDT(r.executed_at)} · ${({ all: 'الكل', m: 'رجال', f: 'نساء' })[r.gender]} · ${r.winners_count} فائز مطلوب · ${fmt(r.eligible_count)} مؤهل · ${fmt(r.total_shares)} سهم${cancelled ? ` · أُلغي: ${esc(r.cancel_reason || '')}` : ''}</div></div>
    <div class="row no-print">${cancelled ? '' : `<button class="btn sm gold" data-show="${r.id}">عرض على الشاشة</button>`}<button class="btn sm ghost" data-xl="${r.id}">Excel</button>${cancelled ? '' : `<button class="btn sm ghost" data-cancel="${r.id}">إلغاء السحب</button>`}</div></div>
    <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>#</th><th>الفائز</th><th>الباص</th><th class="n">أسهمه</th><th class="n">إجماليه</th><th>تم التواصل</th><th>تم التسليم</th><th></th></tr></thead>
    <tbody>${ws.map(w => `<tr class="${w.status === 'replaced' ? 'dim' : ''}"><td>${w.draw_order}</td><td><b>${esc(w.name)}</b>${w.replacement_of ? ' <span class="tag blue">بديل</span>' : ''}${w.status === 'replaced' ? ` <span class="tag red">استُبدل: ${esc(w.replaced_reason || '')}</span>` : ''}</td><td>${esc(w.bus_name || '')}</td><td class="n">${fmt(w.shares)}</td><td class="n">${fmt(w.total)}</td>
      <td>${w.status === 'active' ? `<input type="checkbox" data-mark="contacted" data-w="${w.id}" ${w.contacted ? 'checked' : ''} ${cancelled ? 'disabled' : ''}>` : ''}</td><td>${w.status === 'active' ? `<input type="checkbox" data-mark="delivered" data-w="${w.id}" ${w.delivered ? 'checked' : ''} ${cancelled ? 'disabled' : ''}>` : ''}</td>
      <td>${w.status === 'active' && !cancelled ? `<button class="btn sm ghost no-print" data-rep="${w.id}">استبدال</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function bindRounds(el) {
  $$('[data-show]', el).forEach(b => b.onclick = () => drawScreen(Number(b.dataset.show)));
  $$('[data-xl]', el).forEach(b => b.onclick = guard(b, () => exportExcel(['winners'], Number(b.dataset.xl))));
  $$('[data-mark]', el).forEach(i => i.onchange = async () => { try { await call('sl_admin_winner_mark', { p_winner: Number(i.dataset.w), p_field: i.dataset.mark, p_value: i.checked }); toast('حُفظ', 'ok'); } catch (e) { toast(errMsg(e), 'error'); i.checked = !i.checked; } });
  $$('[data-rep]', el).forEach(b => b.onclick = guard(b, async () => {
    const v = await askReason('استبدال فائز (غائب أو تعذر التواصل)');
    const r = await act('sl_replace_winner', { p_winner: Number(b.dataset.rep), p_reason: v.reason }, 'سُحب بديل');
    toast(`البديل: ${r.name} (${r.bus || ''})`, 'ok');
  }));
  $$('[data-cancel]', el).forEach(b => b.onclick = guard(b, async () => {
    if (!await confirmBox('إلغاء السحب', 'سيُلغى هذا السحب ويبقى مسجلاً في السجل، ويمكنك تنفيذ جولة جديدة. متابعة؟', true)) return;
    const v = await askReason('تأكيد ثانٍ: سبب إلغاء السحب');
    await act('sl_cancel_draw', { p_round: Number(b.dataset.cancel), p_reason: v.reason }, 'أُلغي السحب');
  }));
}

// شاشة السحب بملء الشاشة — الحركة للعرض فقط، والنتيجة محسومة مسبقاً على الخادم
async function drawScreen(rid) {
  const r = A.D.rounds.find(x => x.id === rid); if (!r) return;
  const winners = A.D.winners.filter(w => w.round_id === rid && w.status === 'active').sort((a, b) => a.draw_order - b.draw_order);
  let pool = [];
  try { pool = (await call('sl_round_entries', { p_round: rid })).map(e => e.name); } catch { }
  if (pool.length < 2) pool = winners.map(w => w.name).concat(['…']);
  const el = document.createElement('div'); el.className = 'draw-screen';
  el.innerHTML = `<button class="btn sm ds-close">✕ إغلاق</button>
    <img class="ds-logo" src="${$('#logo').src}" alt="">
    <h1>${esc(A.cfg.identity.campaign_name)}</h1><h2>${esc(A.cfg.season.contest_name)} — ${esc(r.name)}</h2>
    <div class="order" id="ds-order"></div><div class="slot" id="ds-slot">🎁</div><div class="meta" id="ds-meta">${fmt(r.eligible_count)} مؤهل · ${fmt(r.total_shares)} سهم</div>
    <div class="ds-actions"><button class="btn gold" id="ds-go">ابدأ السحب</button></div>
    <div class="revealed" id="ds-list"></div>`;
  document.body.appendChild(el);
  try { await el.requestFullscreen(); } catch { }
  const close = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); el.remove(); };
  $('.ds-close', el).onclick = close;
  let i = 0, rolling = false;
  const go = $('#ds-go', el);
  go.onclick = async () => {
    if (rolling) return;
    if (i >= winners.length) return close();
    rolling = true; go.disabled = true;
    const w = winners[i], slot = $('#ds-slot', el), meta = $('#ds-meta', el);
    $('#ds-order', el).textContent = `الفائز رقم ${i + 1} من ${winners.length}`;
    meta.textContent = ''; slot.className = 'slot rolling';
    const t0 = performance.now(), dur = 4200;
    await new Promise(res => {
      const step = () => {
        const p = (performance.now() - t0) / dur;
        if (p >= 1) return res();
        slot.textContent = pool[Math.floor(Math.random() * pool.length)];
        setTimeout(step, 45 + 380 * p * p);          // يتباطأ تدريجياً
      };
      step();
    });
    slot.className = 'slot win'; slot.textContent = w.name;
    meta.textContent = `${w.bus_name || ''} · ${fmt(w.shares)} ${w.shares === 1 ? 'سهم' : 'أسهم'}`;
    $('#ds-list', el).insertAdjacentHTML('beforeend', `<span><b>${i + 1}</b>${esc(w.name)} — ${esc(w.bus_name || '')}</span>`);
    i++; rolling = false; go.disabled = false;
    go.textContent = i < winners.length ? 'الفائز التالي' : 'انتهى السحب 🎉 إغلاق';
  };
}

// ================= الأدوات =================
function vTools(el) {
  const X = A.X, url = new URL('index.html', location.href).href;
  el.innerHTML = `<div class="grid2">
    <div class="card"><h2>رابط المسابقة</h2><div class="row"><div class="qr" id="qr"></div><div class="grow stack">
      <input class="input small" dir="ltr" value="${esc(url)}" readonly id="link"><button class="btn sm" id="copy-link">نسخ الرابط</button><button class="btn sm ghost" id="dl-qr">تنزيل QR</button></div></div></div>
    <div class="card"><h2>نص إعلان جاهز (واتساب)</h2><textarea class="input" id="ann" style="min-height:190px">${esc(announceText())}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="copy-ann">نسخ</button><a class="btn sm ghost" id="wa" target="_blank" rel="noopener">فتح واتساب</a><button class="btn sm ghost" id="regen">تحديث النص</button></div></div>
    <div class="card"><h2>تصدير وطباعة</h2><div class="row">
      <button class="btn sm" data-x="people">المتسابقون</button><button class="btn sm" data-x="days">الأيام</button><button class="btn sm" data-x="buses">الباصات</button><button class="btn sm" data-x="winners">الفائزون</button>
      <button class="btn sm gold" data-x="all">نسخة احتياطية كاملة</button><button class="btn sm ghost" onclick="print()">طباعة الصفحة</button></div>
      <p class="small muted">ملفات Excel باتجاه من اليمين لليسار. للطباعة افتح التبويب المطلوب ثم «طباعة».</p></div>
    <div class="card"><h2>وضع التجربة (المحاكاة)</h2>
      <p class="small">يولّد 60 متسابقاً وهمياً (رجال ونساء على 4 باصات تجريبية) بأعداد وأيام عشوائية، موسومين <code>is_test</code> فلا يدخلون في أي إحصاء أو سحب حقيقي.</p>
      <p class="small muted">بيانات التجربة الحالية: ${fmt(A.D.test_count)} متسابق.</p>
      <div class="row"><button class="btn sm" id="sim">محاكاة 60 متسابقاً</button>
      <button class="btn sm ghost" id="view-test">${A.test ? 'عرض البيانات الحقيقية' : 'عرض بيانات التجربة'}</button>
      <button class="btn sm danger" id="del-test">حذف بيانات التجربة</button></div></div>
  </div>
  <div class="card" id="calib"></div>`;
  loadScript(QR_URL, 'qrcode').then(qrcode => { const q = qrcode(0, 'M'); q.addData(url); q.make(); $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }).catch(() => { $('#qr').textContent = 'QR يحتاج إنترنت'; });
  on('#copy-link', async () => { await navigator.clipboard.writeText(url); toast('نُسخ الرابط', 'ok'); }, el);
  on('#dl-qr', async () => {
    const svg = $('#qr svg'); if (!svg) return;
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML);
    await img.decode(); const c = document.createElement('canvas'); c.width = c.height = 800; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 800, 800); g.drawImage(img, 0, 0, 800, 800);
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'qr-salawat.png'; a.click();
  }, el);
  const setWa = () => { $('#wa').href = 'https://wa.me/?text=' + encodeURIComponent($('#ann').value); };
  setWa(); $('#ann').oninput = setWa;
  on('#copy-ann', async () => { await navigator.clipboard.writeText($('#ann').value); toast('نُسخ النص', 'ok'); }, el);
  $('#regen').onclick = () => { $('#ann').value = announceText(); setWa(); };
  $$('[data-x]', el).forEach(b => b.onclick = guard(b, () => exportExcel(b.dataset.x === 'all' ? ['people', 'days', 'buses', 'winners', 'manual', 'audit'] : [b.dataset.x])));
  on('#sim', async () => { if (await confirmBox('محاكاة', 'توليد 60 متسابقاً وهمياً؟')) { await act('sl_admin_simulate', {}, 'تم توليد بيانات التجربة'); setTest(true); } }, el);
  $('#view-test').onclick = () => setTest(!A.test);
  on('#del-test', async () => {
    if (!await confirmBox('حذف بيانات التجربة', `سيُحذف ${fmt(A.D.test_count)} متسابقاً تجريبياً مع دفعاتهم وسحوباتهم التجريبية.`, true)) return;
    if (!await confirmBox('تأكيد ثانٍ', 'هل أنت متأكد؟ البيانات الحقيقية لن تتأثر.', true, 'نعم، احذف')) return;
    await act('sl_admin_delete_test', {}, 'حُذفت بيانات التجربة'); if (A.test) setTest(false);
  }, el);
  calibTool();
}

function announceText() {
  const X = A.X, cfg = X.cfg, total = X.counted.reduce((s, c) => s + c.total, 0), today = X.counted.reduce((s, c) => s + c.today, 0);
  const b = busRows().filter(r => r.id !== null)[0], g = gstats(), goal = cfg.display.campaign_goal;
  return [`🌿 ${cfg.season.contest_name} — ${cfg.identity.campaign_name}`, '',
    `📿 مجموع الصلوات حتى الآن: ${fmt(total)}`, `☀️ صلوات اليوم: ${fmt(today)}`,
    b && b.total ? `🚌 الباص المتصدر: ${b.name} بـ ${fmt(b.total)} صلاة` : '',
    `👥 ${g.leadTotal === 'متعادلون' ? 'الرجال والنساء متعادلون' : g.leadTotal + ' في المقدمة'} (الرجال ${fmt(g.m.total)} · النساء ${fmt(g.f.total)})${g.leadAvg !== g.leadTotal ? ` — وبالمتوسط ${g.leadAvg === 'متعادلون' ? 'متعادلون' : 'يتقدم ' + g.leadAvg}` : ''}`,
    goal > 0 ? `🎯 تقدم هدف الحملة: ${pct(total, goal).toFixed(1)}% من ${fmt(goal)}` : '', '',
    `واصلوا بارك الله فيكم 🤍`, `${cfg.season.dhikr}`, '', new URL('index.html', location.href).href].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
}

// أداة معايرة السرعة
function calibTool() {
  const box = $('#calib'), C = A.calib;
  const stats = (g) => { const s = [...g].sort((a, b) => a - b), n = s.length; return { min: s[0], mean: s.reduce((a, b) => a + b, 0) / n, med: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, p10: s[Math.floor(0.1 * (n - 1))] }; };
  const all = C.trials.flatMap(t => t.gaps), agg = all.length ? stats(all) : null;
  const sug = agg ? Math.max(200, Math.round(agg.p10 * 0.8 / 50) * 50) : null;
  const TAPS = 15;
  box.innerHTML = `<h2>أداة معايرة السرعة</h2>
    <p class="small muted">ليجرّب كل مشرف الضغط بسرعته الطبيعية في الذكر (${TAPS} ضغطة، ذكر كامل مع كل ضغطة). نقترح الفاصل الأدنى = 80% من الشريحة الدنيا 10% لكل التجارب.</p>
    <div class="row" style="margin-bottom:10px"><input class="input" id="cal-name" placeholder="اسم المجرّب" style="max-width:240px;min-height:42px"></div>
    <div class="calib-pad" id="pad">${C.cur ? `${C.cur.taps.length} / ${TAPS}` : 'اضغط هنا مع كل ذكر'}</div>
    ${C.trials.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>المجرّب</th><th class="n">أقصر فاصل</th><th class="n">المتوسط</th><th class="n">الوسيط</th><th class="n">الشريحة الدنيا 10%</th><th></th></tr></thead>
      <tbody>${C.trials.map((t, i) => { const s = stats(t.gaps); return `<tr><td>${esc(t.name)}</td><td class="n">${Math.round(s.min)}</td><td class="n">${Math.round(s.mean)}</td><td class="n">${Math.round(s.med)}</td><td class="n">${Math.round(s.p10)}</td><td><button class="btn sm ghost" data-del="${i}">حذف</button></td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td>الإجمالي (${all.length} فاصل)</td><td class="n">${Math.round(agg.min)}</td><td class="n">${Math.round(agg.mean)}</td><td class="n">${Math.round(agg.med)}</td><td class="n">${Math.round(agg.p10)}</td><td></td></tr></tfoot></table></div>
      <div class="row" style="margin-top:12px"><span>القيمة المقترحة:</span><input class="input num" id="sug" type="number" step="50" value="${sug}" style="max-width:130px;min-height:42px"><span class="muted small">ms (الحالية ${A.cfg.speed.min_interval_ms})</span>
      <button class="btn sm" id="adopt">اعتمدها في الإعدادات</button></div>` : ''}`;
  const pad = $('#pad');
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!C.cur) C.cur = { name: ($('#cal-name').value || 'مجرّب ' + (C.trials.length + 1)).trim(), taps: [] };
    C.cur.taps.push(performance.now());
    pad.textContent = `${C.cur.taps.length} / ${TAPS}`;
    if (C.cur.taps.length >= TAPS) {
      const t = C.cur.taps, gaps = t.slice(1).map((x, i) => x - t[i]);
      C.trials.push({ name: C.cur.name, gaps }); C.cur = null; pad.classList.add('done'); setTimeout(calibTool, 400);
    }
  });
  $$('[data-del]', box).forEach(b => b.onclick = () => { C.trials.splice(Number(b.dataset.del), 1); calibTool(); });
  on('#adopt', async () => {
    const v = Math.round(Number($('#sug').value) / 50) * 50; if (!(v >= 50)) return toast('قيمة غير صحيحة', 'error');
    const cfg = fullConfig(A.D.config); cfg.speed.min_interval_ms = v;
    await act('sl_admin_save_config', { p_config: cfg }, `اعتُمد الفاصل الأدنى ${v} ms`);
  }, box);
}

// تصدير Excel
async function exportExcel(kinds, roundId = null) {
  const XLSX = await loadScript(XLSX_URL, 'XLSX'), X = A.X, wb = XLSX.utils.book_new();
  const add = (name, rows) => { const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '—': 'لا توجد بيانات' }]); ws['!cols'] = Object.keys(rows[0] || { a: 1 }).map(() => ({ wch: 16 })); XLSX.utils.book_append_sheet(wb, ws, name); };
  if (kinds.includes('people')) add('المتسابقون', [...X.cs].sort((a, b) => b.total - a.total).map(c => {
    const r = { 'الاسم': c.name, 'الجوال': displayPhone(c.phone), 'الجنس': GENDER[c.gender], 'الباص': c.bus, 'الحالة': CSTATUS[c.status], 'الإجمالي': c.total, 'ضغطات التطبيق': c.app_total,
      'المضاف يدوياً': c.manual_total, 'يدوي معلّق': c.manual_pending, 'تعديلات': c.adj_total, 'مرفوض': c.rejected_total, 'اليوم': c.today, 'أيام نشطة': c.activeDays, 'الأسهم': c.shares,
      'المراجعة': REVIEW[c.review_status] || '', 'العلامات': (c.flag_reasons || []).map(f => FLAG[f] || f).join('، '), 'تاريخ الالتحاق': fmtDT(c.joined_at), 'آخر نشاط': fmtDT(c.last_sync_at) };
    X.days.forEach(d => r[dayTitle(d) + ' ' + d.key] = X.val(c.dmap[d.key]));
    return r;
  }));
  if (kinds.includes('days')) add('الأيام', dayRows().map(d => { const L = dayLabel(d.key); return { 'اليوم': dayTitle(d), 'التاريخ': d.key, 'اسم اليوم': L.weekday, 'الهجري': L.hijri, 'النشطون': d.active, 'رجال': d.m, 'نساء': d.f, 'المجموع': d.total }; }));
  if (kinds.includes('buses')) add('الباصات', busRows().map((b, i) => ({ 'الترتيب': i + 1, 'الباص': b.name, 'الأعضاء': b.members, 'النشطون اليوم': b.active, 'المجموع': b.total, 'المتوسط': b.avg, 'رجال': b.men, 'نساء': b.women, 'اليوم': b.today })));
  if (kinds.includes('winners')) add('الفائزون', A.D.winners.filter(w => !roundId || w.round_id === roundId).map(w => {
    const r = A.D.rounds.find(x => x.id === w.round_id) || {};
    return { 'الجولة': r.name, 'حالة الجولة': r.status === 'cancelled' ? 'ملغاة' : 'منفذة', 'الترتيب': w.draw_order, 'الاسم': w.name, 'الباص': w.bus_name, 'الجنس': GENDER[w.gender], 'الأسهم': w.shares, 'الإجمالي': w.total,
      'الحالة': w.status === 'replaced' ? 'مُستبدل: ' + (w.replaced_reason || '') : 'فائز', 'تم التواصل': w.contacted ? 'نعم' : 'لا', 'تم التسليم': w.delivered ? 'نعم' : 'لا', 'وقت السحب': fmtDT(w.drawn_at) };
  }));
  if (roundId) {
    const ent = await call('sl_round_entries', { p_round: roundId });
    add('المؤهلون', ent.map(e => ({ 'الاسم': e.name, 'الباص': e.bus_name, 'الجنس': GENDER[e.gender], 'الإجمالي': e.total, 'أيام نشطة': e.active_days, 'الأسهم': e.shares, 'إدراج بالقوة': e.forced ? 'نعم' : '' })));
  }
  if (kinds.includes('manual')) add('الإضافات اليدوية', (A.D.manual || []).map(m => ({ 'الوقت': fmtDT(m.created_at), 'المتسابق': (X.byId[m.contestant_id] || {}).name, 'اليوم': m.day_date, 'العدد': m.count, 'الحالة': MSTATUS[m.status], 'بواسطة': m.decided_by || '' })));
  if (kinds.includes('audit')) add('السجل', A.D.audit.map(a => ({ 'الوقت': fmtDT(a.at), 'المنفذ': a.actor, 'الإجراء': ACTIONS[a.action] || a.action, 'الهدف': (X.byId[a.target] || {}).name || a.target || '', 'التفاصيل': a.details ? JSON.stringify(a.details) : '', 'السبب': a.reason || '' })));
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.writeFile(wb, `salawat-${kinds.length > 1 ? 'backup' : kinds[0]}${A.test ? '-test' : ''}-${X.today}.xlsx`);
}

// ================= الإعدادات =================
const CFIELDS = { total: 'إجمالي الصلوات', active_days: 'الأيام النشطة', gender: 'الجنس', bus: 'الباص', status: 'الحالة', manual: 'ما أُضيف يدوياً' };
const OPS = { eq: '=', ne: '≠', ge: '≥', le: '≤' };
const getP = (o, p) => p.split('.').reduce((a, k) => a == null ? a : a[k], o);
const setP = (o, p, v) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k] = a[k] || {}, o)[last] = v; };
function vSettings(el) {
  if (!A.draft) A.draft = fullConfig(A.D.config);
  const c = A.draft, g = (p) => getP(c, p);
  const T = (p, l, o = {}) => `<label class="field"><span>${l}</span><input class="input" data-p="${p}" value="${esc(g(p) ?? '')}" ${o.ph ? `placeholder="${esc(o.ph)}"` : ''}></label>`;
  const AR = (p, l, o = {}) => `<label class="field" style="grid-column:1/-1"><span>${l}</span><textarea class="input" data-p="${p}" ${o.ph ? `placeholder="${esc(o.ph)}"` : ''}>${esc(g(p) ?? '')}</textarea></label>`;
  const N = (p, l, o = {}) => `<label class="field"><span>${l}</span><input class="input num" type="number" data-p="${p}" data-t="num" value="${g(p) ?? ''}" min="${o.min ?? 0}" ${o.step ? `step="${o.step}"` : ''}></label>`;
  const B = (p, l) => `<label class="check"><input type="checkbox" data-p="${p}" data-t="bool" ${g(p) ? 'checked' : ''}> ${l}</label>`;
  const S = (p, l, opts) => `<label class="field"><span>${l}</span><select class="input" data-p="${p}">${opts.map(([v, t]) => `<option value="${v}" ${String(g(p)) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const DT = (p, l) => `<label class="field"><span>${l}</span><input class="input" type="datetime-local" data-p="${p}" data-t="dt" value="${isoToLocalInput(g(p))}"></label>`;
  const COL = (p, l) => `<label class="field"><span>${l}</span><input class="input" type="color" data-p="${p}" value="${g(p)}" style="padding:4px;height:48px"></label>`;
  const sec = (id, title, body) => `<div class="card" id="sec-${id}"><h2>${title}</h2>${body}</div>`;
  const seas = SEASON_TEXTS[c.season.type] || SEASON_TEXTS.custom;
  el.innerHTML = `
    <div class="settings-nav no-print">${[['identity', 'الهوية'], ['season', 'الموسم والنصوص'], ['schedule', 'الجدولة'], ['login', 'الدخول'], ['speed', 'السرعة'], ['review', 'المراجعة'], ['manual', 'الإضافة اليدوية'], ['display', 'العرض للمتسابقين'], ['draw', 'النتائج والسحب'], ['buses', 'الباصات'], ['danger', 'تصفير المسابقة']].map(([k, l]) => `<a href="#sec-${k}">${l}</a>`).join('')}</div>
    ${sec('identity', 'الهوية', `<div class="form-grid">${T('identity.campaign_name', 'اسم الحملة')}${COL('identity.primary_color', 'اللون الرئيسي')}${COL('identity.gold_color', 'اللون الذهبي')}</div>
      <div class="row"><img class="logo-prev" id="logo-prev" src="${$('#logo').src}" alt="الشعار"><div class="stack"><label class="btn sm">رفع شعار جديد<input type="file" accept="image/*" id="logo-file" hidden></label>
      <button class="btn sm ghost" id="logo-reset">استعادة الشعار الأصلي</button><span class="small muted">يُعرض الشعار كاملاً بلا قص، ويُضغط في المتصفح إلى 200KB كحد أقصى مع الحفاظ على الشفافية.</span></div></div>`)}
    ${sec('season', 'الموسم والنصوص', `<div class="form-grid">${S('season.type', 'الموسم', [['umrah', 'عمرة'], ['hajj', 'حج'], ['custom', 'مخصص']])}${T('season.contest_name', 'اسم المسابقة')}${T('season.dhikr', 'نص الذكر على الزر')}
      ${T('season.page_title', 'عنوان الصفحة (اتركه فارغاً للنص الافتراضي للموسم)', { ph: seas.page_title })}${AR('season.welcome', 'رسالة الترحيب (اتركها فارغة للنص الافتراضي)', { ph: seas.welcome })}</div>`)}
    ${sec('schedule', 'الجدولة (بتوقيت الرياض)', `<div class="form-grid">${DT('schedule.start_at', 'تاريخ ووقت الانطلاق')}${DT('schedule.end_at', 'تاريخ ووقت الإيقاف')}${N('schedule.day_start_hour', 'ساعة بداية اليوم (0 = منتصف الليل)', { min: 0 })}</div>
      <p class="small muted">أيام المسابقة تُحسب من يوم الانطلاق. أزرار «ابدأ الآن / إيقاف مؤقت / استئناف / إنهاء الآن» في «نظرة عامة».</p>${controlCard()}`)}
    ${sec('login', 'الدخول والتسجيل', `${B('login.self_register', 'السماح بالتسجيل الذاتي للأرقام غير المسجلة')}${B('login.pin_enabled', 'طلب رمز سري من 4 أرقام (يضعه المتسابق عند أول دخول)')}<div class="form-grid">${N('login.remember_days', 'مدة جلسة «تذكرني» بالأيام', { min: 1 })}</div>`)}
    ${sec('speed', 'السرعة ومنع التلاعب', `<label class="field"><span>الحد الأدنى للفاصل بين ضغطتين</span><div class="range-row"><input type="range" min="200" max="4000" step="50" data-p="speed.min_interval_ms" data-t="num" value="${g('speed.min_interval_ms')}" id="iv"><b class="num" id="iv-out"></b></div></label>
      <div class="form-grid">${N('speed.max_batch', 'سقف الدفعة الواحدة', { min: 1 })}${N('speed.max_offline_hours', 'أقصى مدة انقطاع مقبولة (ساعات)', { min: 1, step: 0.5 })}${N('speed.grace_minutes', 'مهلة المزامنة بعد الانتهاء/الإيقاف (دقائق)')}
      ${N('speed.batch_seconds', 'الإرسال كل (ثوانٍ)', { min: 5 })}${N('speed.public_refresh_seconds', 'تحديث مجموع الحملة كل (ثوانٍ)', { min: 10 })}${N('speed.daily_cap', 'السقف اليومي لكل متسابق')}</div>${B('speed.daily_cap_enabled', 'تفعيل السقف اليومي')}
      <p class="small muted">الخادم يقبل ضغطة واحدة لكل فاصل زمني فعلي (رصيد مشترك بين أجهزة الحساب)، ويتراكم الرصيد حتى «أقصى مدة انقطاع» ليتمكن من يعمل بلا إنترنت من المزامنة لاحقاً.</p>`)}
    ${sec('review', 'علامات المراجعة (للفحص فقط)', `${B('review.reject_ratio_enabled', 'وسم من تزيد نسبة ضغطاته المرفوضة عن الحد')}<div class="form-grid">${N('review.reject_ratio_pct', 'نسبة المرفوض %')}${N('review.reject_min_sample', 'بعد عدد ضغطات لا يقل عن')}</div>
      ${B('review.daily_rate_enabled', 'وسم من يتجاوز معدلاً يومياً')}<div class="form-grid">${N('review.daily_rate', 'المعدل اليومي')}</div>
      ${B('review.robotic_enabled', 'وسم النمط الآلي (فواصل متطابقة تقريباً)')}<div class="form-grid">${N('review.robotic_min_presses', 'لعدد ضغطات لا يقل عن')}${N('review.robotic_stdev_ms', 'إذا كان انحراف الفواصل أقل من (ms)')}</div>`)}
    ${sec('manual', 'إضافة العدد المنجز خارج التطبيق', `${B('manual.enabled', 'السماح بإضافة عدد منجز خارج التطبيق')}${B('manual.require_approval', 'تبقى «معلّقة» حتى يعتمدها المشرف')}${B('manual.include_in_totals', 'تدخل في الترتيب والمجاميع')}
      <div class="form-grid">${N('manual.max_per_entry', 'الحد الأقصى للإدخال الواحد', { min: 1 })}${N('manual.max_per_day', 'الحد الأقصى اليومي', { min: 1 })}</div><p class="small muted">احتسابها في السحب يُضبط من «النتائج والسحب».</p>`)}
    ${sec('display', 'ما يُعرض للمتسابقين', `${B('display.show_bus_ranking', 'ترتيب الباصات')}${B('display.show_gender', 'مقارنة الرجال بالنساء')}${B('display.show_shares', 'أسهم المتسابق في السحب')}${B('display.withdrawn_in_total', 'احتساب صلوات المنسحبين في المجموع العام')}
      <div class="form-grid">${N('display.campaign_goal', 'هدف الحملة (0 = بلا هدف)')}</div>${AR('display.announcement', 'إعلان المشرف (يظهر كبطاقة للجميع)', { ph: 'مثال: الباص 3 متصدر!' })}${AR('display.rules_text', 'شروط المسابقة والسحب')}
      <p class="small muted">لا يُعرض ترتيب الأفراد ولا أرقام الجوال لأي متسابق.</p>`)}
    ${sec('draw', 'النتائج وشروط السحب', `<div class="form-grid">${N('results.top_n', 'عدد الأكثر ذكراً المعلن (N)', { min: 1 })}${S('results.scope', 'نطاق الإعلان', [['overall', 'عموماً'], ['gender', 'لكل جنس'], ['both', 'الاثنين معاً']])}</div><hr style="border:none;border-top:1px solid var(--line)">
      ${B('draw.shares_enabled', 'نظام الأسهم (إن أوقفته فلكل مؤهل فرصة واحدة)')}<div class="form-grid">${N('draw.share_value', 'قيمة السهم (صلاة)', { min: 1 })}${N('draw.max_shares', 'أقصى عدد أسهم للفرد (0 = بلا سقف)')}</div>
      ${B('draw.min_total.on', '1. حد أدنى للإجمالي')}<div class="form-grid">${N('draw.min_total.value', 'الحد الأدنى')}</div>
      ${B('draw.active_days.on', '2. حد أدنى لعدد الأيام النشطة')}<div class="form-grid">${N('draw.active_days.days', 'عدد الأيام', { min: 1 })}${N('draw.active_days.day_min', 'اليوم النشط = أنجز فيه على الأقل', { min: 1 })}</div>
      ${B('draw.exclude_flagged', '3. استبعاد الموسومين للمراجعة حتى تُحسم حالتهم')}${B('draw.exclude_inactive', '4. استبعاد المنسحبين والمستبعدين')}${B('draw.exclude_prev_winners', '5. استبعاد من فاز في جولة سابقة')}
      ${B('draw.exclude_top.on', '6. استبعاد أصحاب المراكز الأولى (المعلنين في «الأكثر ذكراً»)')}${B('draw.include_manual', '7. احتساب الإضافات اليدوية في السحب')}
      <h3 style="margin-top:12px">8. شروط مخصصة</h3><div id="conds"></div><button type="button" class="btn sm ghost" id="add-cond">+ إضافة شرط</button>
      <p class="small muted">9. الاستثناء اليدوي (إدراج بالقوة / استبعاد) من بطاقة المتسابق.</p>`)}
    <div class="savebar no-print"><span class="small muted">التغييرات لا تُحفظ حتى تضغط «حفظ الإعدادات».</span><div class="row"><button class="btn ghost sm" id="discard">تراجع</button><button class="btn" id="save">حفظ الإعدادات</button></div></div>
    ${sec('buses', 'الباصات', busManager())}
    ${resetCard()}`;
  // الفاصل الأدنى بالميلي ثانية والثواني
  const iv = $('#iv'), ivo = () => $('#iv-out').textContent = `${iv.value}ms = ${(iv.value / 1000).toFixed(2)} ثانية`; iv.oninput = ivo; ivo();
  $('[data-p="season.type"]').onchange = (e) => { const s = SEASON_TEXTS[e.target.value]; $('[data-p="season.page_title"]').placeholder = s.page_title; $('[data-p="season.welcome"]').placeholder = s.welcome; };
  renderConds();
  $('#add-cond').onclick = () => { collect(); c.draw.custom.push({ id: Date.now(), name: '', field: 'total', op: 'ge', value: '', on: true }); renderConds(); };
  $('#discard').onclick = () => { A.draft = null; vSettings(el); };
  on('#save', async () => {
    collect();
    if (c.schedule.start_at && c.schedule.end_at && Date.parse(c.schedule.end_at) <= Date.parse(c.schedule.start_at)) return toast('وقت الإيقاف يجب أن يكون بعد الانطلاق', 'error');
    for (const x of c.draw.custom) if (x.on && ['total', 'active_days', 'manual'].includes(x.field) && !/^-?\d+(\.\d+)?$/.test(String(x.value).trim())) return toast(`قيمة الشرط «${x.name || CFIELDS[x.field]}» يجب أن تكون رقماً`, 'error');
    await call('sl_admin_save_config', { p_config: c }); toast('حُفظت الإعدادات', 'ok'); A.draft = null; await load(true);
  }, el);
  $('#logo-file').onchange = (e) => logoUpload(e.target.files[0]);
  on('#logo-reset', async () => { if (await confirmBox('الشعار', 'استعادة الشعار الأصلي للحملة؟')) { await call('sl_admin_save_logo', { p_data: '' }); logoVer = null; toast('استُعيد الشعار', 'ok'); await load(true); } }, el);
  bindBuses(el); bindReset(el); bindControl($('#sec-schedule'));
}
function collect() {
  const c = A.draft;
  $$('[data-p]').forEach(i => {
    const t = i.dataset.t; let v;
    if (t === 'bool') v = i.checked; else if (t === 'num') v = i.value === '' ? 0 : Number(i.value); else if (t === 'dt') v = localInputToIso(i.value); else v = i.value;
    setP(c, i.dataset.p, v);
  });
  $$('[data-ci]').forEach(row => {
    const x = c.draw.custom[Number(row.dataset.ci)]; if (!x) return;
    x.name = $('[data-k=name]', row).value; x.field = $('[data-k=field]', row).value; x.op = $('[data-k=op]', row).value; x.value = $('[data-k=value]', row).value; x.on = $('[data-k=on]', row).checked;
  });
}
function renderConds() {
  const box = $('#conds'), list = A.draft.draw.custom;
  const valInput = (x) => x.field === 'gender' ? `<select class="input" data-k="value">${[['m', 'رجل'], ['f', 'امرأة']].map(([v, l]) => `<option value="${v}" ${x.value === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`
    : x.field === 'status' ? `<select class="input" data-k="value">${Object.entries(CSTATUS).map(([v, l]) => `<option value="${v}" ${x.value === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`
      : x.field === 'bus' ? `<select class="input" data-k="value">${Object.values(A.X.buses).map(b => `<option value="${esc(b.name)}" ${x.value === b.name ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`
        : `<input class="input num" type="number" data-k="value" value="${esc(x.value)}" placeholder="القيمة">`;
  box.innerHTML = list.length ? list.map((x, i) => `<div class="cond-row" data-ci="${i}">
    <input class="input" data-k="name" value="${esc(x.name)}" placeholder="اسم الشرط">
    <select class="input" data-k="field">${Object.entries(CFIELDS).map(([v, l]) => `<option value="${v}" ${x.field === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select class="input" data-k="op">${Object.entries(OPS).map(([v, l]) => `<option value="${v}" ${x.op === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${valInput(x)}<label class="check small"><input type="checkbox" data-k="on" ${x.on ? 'checked' : ''}> مفعّل</label><button type="button" class="btn sm ghost" data-rm="${i}">✕</button></div>`).join('') : '<p class="small muted">لا توجد شروط مخصصة.</p>';
  $$('[data-k=field]', box).forEach(s => s.onchange = () => { collect(); const x = list[Number(s.closest('[data-ci]').dataset.ci)]; x.value = x.field === 'gender' ? 'm' : x.field === 'status' ? 'active' : x.field === 'bus' ? ((Object.values(A.X.buses)[0] || {}).name || '') : ''; renderConds(); });
  $$('[data-rm]', box).forEach(b => b.onclick = () => { collect(); list.splice(Number(b.dataset.rm), 1); renderConds(); });
}

// رفع الشعار: تصغير وضغط في المتصفح مع الحفاظ على النسبة كاملة (بلا قص)
async function logoUpload(file) {
  if (!file) return;
  try {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
    let max = 600, data = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * r); cv.height = Math.round(img.naturalHeight * r);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      data = cv.toDataURL('image/webp', 0.9);
      if (!data.startsWith('data:image/webp')) data = cv.toDataURL('image/png');
      if (data.length * 0.75 <= 200 * 1024) break;
      max = Math.round(max * 0.8);
    }
    if (data.length * 0.75 > 200 * 1024) return toast('تعذر ضغط الشعار إلى 200KB، جرّب صورة أصغر', 'error');
    $('#logo-prev').src = data;
    await call('sl_admin_save_logo', { p_data: data }); logoVer = null;
    toast(`حُفظ الشعار (${Math.round(data.length * 0.75 / 1024)}KB)`, 'ok'); await load(true);
  } catch (e) { toast(errMsg(e), 'error'); }
}

function busManager() {
  const X = A.X;
  return `<ul class="list">${Object.values(X.buses).map(b => `<li><span><b>${esc(b.name)}</b> <span class="small muted">${X.cs.filter(c => c.bus_id === b.id).length} متسابق</span></span>
    <span class="row"><button class="btn sm ghost" data-ren="${b.id}">إعادة تسمية</button><button class="btn sm ghost" data-delbus="${b.id}">حذف</button></span></li>`).join('') || '<li class="muted">لا توجد باصات</li>'}</ul>
    <div class="row" style="margin-top:10px"><input class="input" id="new-bus" placeholder="اسم أو رقم الباص" style="max-width:240px;min-height:42px"><button class="btn sm" id="add-bus">إضافة باص</button></div>`;
}
function bindBuses(el) {
  on('#add-bus', async () => { const n = $('#new-bus').value.trim(); if (!n) return; await act('sl_admin_bus', { p_action: 'add', p_id: null, p_name: n }, 'أُضيف الباص'); }, el);
  $$('[data-ren]', el).forEach(b => b.onclick = guard(b, async () => {
    const bus = A.X.buses[b.dataset.ren]; const v = await dialog({ title: 'إعادة تسمية', fields: [{ id: 'n', label: 'الاسم', value: bus.name, required: true }] });
    if (v) await act('sl_admin_bus', { p_action: 'rename', p_id: bus.id, p_name: v.n }, 'تم');
  }));
  $$('[data-delbus]', el).forEach(b => b.onclick = guard(b, async () => {
    const bus = A.X.buses[b.dataset.delbus], n = A.X.cs.filter(c => c.bus_id === bus.id).length;
    if (await confirmBox('حذف باص', `حذف «${esc(bus.name)}»؟ ${n ? `سيصبح ${n} متسابقاً بلا باص.` : ''}`, true)) await act('sl_admin_bus', { p_action: 'delete', p_id: bus.id, p_name: bus.name }, 'حُذف الباص');
  }));
}

// تصفير المسابقة وحذف بياناتها في النهاية لإعداد مسابقة جديدة
function resetCard() {
  const X = A.X;
  return `<div class="card danger-zone" id="sec-danger"><h2>⚠ تصفير المسابقة وحذف بياناتها (لإعداد مسابقة جديدة)</h2>
    <p>استخدمه بعد انتهاء المسابقة وتسليم الجوائز. يُحذف نهائياً: كل الضغطات والدفعات، الإضافات اليدوية، التعديلات، علامات المراجعة، السحوبات والفائزون، لقطات النتائج، الجلسات (يخرج الجميع)، بيانات التجربة، وسجل الإجراءات. وتعود المسابقة إلى «مسودة» بلا تواريخ.</p>
    <p class="small">الوضع الحالي: ${fmt(A.D.contestants.length)} متسابق${A.test ? ' (تجريبي)' : ''} · ${fmt(X.counted.reduce((s, c) => s + c.total, 0))} صلاة · ${A.D.rounds.length} جولة سحب.</p>
    <ol class="small"><li><b>نزّل نسخة احتياطية أولاً:</b> <button class="btn sm gold" id="rs-backup">تنزيل نسخة احتياطية كاملة (Excel)</button></li>
      <li>اختر ما تريد إبقاءه:</li></ol>
    ${A.test ? '<p class="err">انتقل إلى البيانات الحقيقية أولاً (أنت تعرض المحاكاة).</p>' : ''}
    <label class="check"><input type="checkbox" id="rs-people"> إبقاء قائمة المتسابقين (بأرقامهم وباصاتهم) مع تصفير أعدادهم</label>
    <label class="check"><input type="checkbox" id="rs-buses" checked> إبقاء الباصات</label>
    <label class="check"><input type="checkbox" id="rs-settings" checked> إبقاء الإعدادات (السرعة، النصوص، شروط السحب…) — وإلا تعود للافتراضي</label>
    <p class="small muted">اسم الحملة والشعار والألوان تبقى دائماً.</p>
    <label class="field"><span>للتأكيد اكتب: <b>حذف المسابقة</b></span><input class="input" id="rs-confirm" autocomplete="off"></label>
    <button class="btn danger" id="rs-go" disabled>تصفير المسابقة وحذف بياناتها</button></div>`;
}
function bindReset(el) {
  const inp = $('#rs-confirm', el), go = $('#rs-go', el), ppl = $('#rs-people', el), bus = $('#rs-buses', el);
  inp.oninput = () => { go.disabled = A.test || inp.value.trim() !== 'حذف المسابقة'; };
  ppl.onchange = () => { if (ppl.checked) { bus.checked = true; bus.disabled = true; } else bus.disabled = false; };
  on('#rs-backup', () => exportExcel(['people', 'days', 'buses', 'winners', 'manual', 'audit']), el);
  go.onclick = guard(go, async () => {
    const keep = { people: ppl.checked, buses: bus.checked, settings: $('#rs-settings', el).checked };
    if (!await confirmBox('تأكيد التصفير', `سيُحذف كل ما في المسابقة الحالية نهائياً${keep.people ? '، مع إبقاء قائمة المتسابقين بأعداد صفرية' : ' بما في ذلك قائمة المتسابقين'}. لا يمكن التراجع. هل نزّلت النسخة الاحتياطية؟`, true, 'نعم، تابع')) return;
    const v = await dialog({ title: 'التأكيد الأخير', html: '<p>هذه آخر خطوة. اكتب سبباً مختصراً (مثل: انتهاء موسم حج 1448).</p>', fields: [{ id: 'reason', label: 'السبب', required: true }], ok: 'تصفير الآن', danger: true });
    if (!v) return;
    const r = await call('sl_admin_reset', { p_opts: { confirm: inp.value.trim(), keep_contestants: keep.people, keep_buses: keep.buses, keep_settings: keep.settings, default_config: clone(DEFAULT_CONFIG), reason: v.reason } });
    toast(`صُفّرت المسابقة. حُذف ${fmt(r.summary.total_app)} ضغطة من ${fmt(r.summary.contestants)} متسابق.`, 'ok');
    A.draft = null; A.tab = 'settings'; await load(true);
  });
}

// ================= السجل =================
const ACTIONS = {
  save_config: 'حفظ الإعدادات', save_logo: 'تغيير الشعار', freeze_results: 'تجميد النتائج', state_start_now: 'بدء المسابقة الآن', state_pause: 'إيقاف مؤقت', state_resume: 'استئناف',
  state_end_now: 'إنهاء المسابقة', state_activate: 'اعتماد الجدولة', state_draft: 'إرجاع لمسودة', state_publish: 'نشر النتائج', state_unpublish: 'إخفاء النتائج',
  bus_add: 'إضافة باص', bus_rename: 'تسمية باص', bus_delete: 'حذف باص', add_contestant: 'إضافة متسابق', edit_contestant: 'تعديل متسابق', status_active: 'تفعيل متسابق',
  status_withdrawn: 'تسجيل انسحاب', status_excluded: 'استبعاد', reset_pin: 'إعادة تعيين رمز', delete_contestant: 'حذف متسابق نهائياً', adjust: 'تعديل عدد',
  review_approve: 'مراجعة: اعتماد', review_deduct: 'مراجعة: خصم', review_exclude: 'مراجعة: استبعاد', review_reset: 'مسح علامات', manual_approve: 'اعتماد إضافة يدوية',
  manual_reject: 'رفض إضافة يدوية', manual_revert: 'تراجع عن إضافة يدوية', override_include: 'إدراج بالقوة في السحب', override_exclude: 'استبعاد من السحب', override_remove: 'إزالة استثناء السحب',
  import: 'استيراد', run_draw: 'تنفيذ سحب', cancel_draw: 'إلغاء سحب', replace_winner: 'استبدال فائز', winner_contacted: 'تم التواصل', winner_delivered: 'تم التسليم',
  simulate: 'محاكاة', delete_test: 'حذف بيانات التجربة', reset_competition: 'تصفير المسابقة'
};
function vAudit(el) {
  const X = A.X;
  el.innerHTML = `<div class="card"><h2>سجل إجراءات المشرف (آخر 300)</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>المنفذ</th><th>الإجراء</th><th>الهدف</th><th>التفاصيل</th><th>السبب</th></tr></thead>
    <tbody>${A.D.audit.map(a => `<tr><td class="small">${fmtDT(a.at)}</td><td class="small">${esc(a.actor || '')}</td><td>${esc(ACTIONS[a.action] || a.action)}</td><td>${esc((X.byId[a.target] || {}).name || (a.target && a.target.length > 20 ? '' : a.target) || '')}</td>
      <td class="small" style="white-space:normal;max-width:340px">${esc(a.details ? Object.entries(a.details).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '')}</td><td class="small" style="white-space:normal">${esc(a.reason || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">لا يوجد</td></tr>'}</tbody></table></div></div>`;
}
