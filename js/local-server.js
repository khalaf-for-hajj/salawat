// ===== الخادم المحلي للوضع التجريبي =====
// يحاكي دوال Supabase (نفس الأسماء والمدخلات والمخرجات) ويحفظ في localStorage
// يُستخدم فقط إذا لم تُضبط بيانات Supabase في config.js
import { DEFAULT_CONFIG, DEFAULT_STATE, fullConfig, deepMerge, clone, normalizePhone, dayKey, keyToMs, DAY_MS, computeStatus, uuid } from './common.js';

const KEY = 'sl_demo_db_v1';
const ADMIN = 'مشرف تجريبي';
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const fail = (code) => { const e = new Error('sl:' + code); e.code = 'sl:' + code; throw e; };

// ---------- التخزين ----------
function load() {
  try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s); } catch { }
  const db = seed(); save(db); return db;
}
function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { console.warn('demo storage full'); }
}
export function resetDemo() { localStorage.removeItem(KEY); }

// ---------- بيانات البداية: 3 باصات و8 متسابقين ومسابقة 4 أيام تبدأ اليوم ----------
function seed() {
  const t = now();
  const todayKey = dayKey(t, 0);
  const startMs = keyToMs(todayKey) - 3 * 3600000;          // منتصف ليل اليوم بتوقيت الرياض
  const config = deepMerge(DEFAULT_CONFIG, {
    schedule: { start_at: iso(startMs), end_at: iso(startMs + 4 * DAY_MS), day_start_hour: 0 },
    display: { show_bus_ranking: true, show_gender: true, show_shares: true, campaign_goal: 100000,
      announcement: 'الباص 2 متصدر حتى الآن! استمروا 🌿',
      rules_text: 'كل صلاة تُضغط بعد ذكرها كاملة.\nكل 5000 صلاة = سهم في السحب.\nيُعلن الأكثر ذكراً في نهاية الرحلة، ويُجرى السحب أمام الجميع.' },
    manual: { enabled: true }
  });
  const db = {
    seq: { bus: 3, manual: 0, adj: 0, audit: 0, snap: 0, round: 0, winner: 0 },
    settings: { config, state: { ...DEFAULT_STATE }, logo: null },
    buses: [1, 2, 3].map(i => ({ id: i, name: 'باص ' + i, sort: i, is_test: false, created_at: iso(t) })),
    contestants: [], sessions: {}, batches: [], manual: [], adjustments: [], daily: {},
    cache: { data: {}, at: 0 }, rate: {}, audit: [], overrides: {}, snapshots: [], rounds: [], entries: [], winners: []
  };
  const people = [['عيسى الخلف', 'm', 1, 3200], ['حسن الموسى', 'm', 1, 1800], ['محمد العلي', 'm', 2, 5400], ['جعفر الصالح', 'm', 3, 900],
    ['زينب الحسن', 'f', 1, 2600], ['فاطمة الأحمد', 'f', 2, 6100], ['مريم الناصر', 'f', 2, 4300], ['زهراء البقشي', 'f', 3, 1500]];
  people.forEach(([name, g, bus, n], i) => {
    const c = newContestant({ name, phone: '96650000000' + (i + 1), gender: g, bus_id: bus, created_by: 'seed' });
    db.contestants.push(c);
    db.batches.push({ batch_id: uuid(), contestant_id: c.id, received_at: iso(t - 3600000), day_date: todayKey, requested: n, accepted: n, rejected: 0, reason: 'ok', client_stats: null });
    recompute(db, c.id);
    c.reached_at = iso(t - 3600000 + i * 60000); c.last_active_at = c.last_sync_at = iso(t - 3600000);
  });
  return db;
}

function newContestant(p) {
  return {
    id: uuid(), name: p.name, phone: p.phone, gender: p.gender, bus_id: p.bus_id ?? null, status: 'active',
    is_test: !!p.is_test, joined_at: iso(now()), created_by: p.created_by || 'admin', pin_hash: null,
    app_total: 0, manual_total: 0, manual_pending: 0, adj_total: 0, rejected_total: 0,
    reached_at: null, last_active_at: null, last_sync_at: null, bucket_tokens: 0, bucket_at: null,
    review_status: 'none', flag_reasons: [], review_note: null, stats: {}
  };
}

// ---------- أدوات ----------
const cfgOf = (db) => fullConfig(db.settings.config);
const dayOf = (db, ms) => dayKey(ms, cfgOf(db).schedule.day_start_hour || 0);
const statusOf = (db, ms = now()) => computeStatus(cfgOf(db), db.settings.state, ms);
function accepting(db, ms) {
  const cfg = cfgOf(db), st = db.settings.state, s = statusOf(db, ms), g = cfg.speed.grace_minutes * 60000;
  if (s === 'running') return true;
  if (s === 'paused') return ms < (st.paused_at ? Date.parse(st.paused_at) : ms) + g;
  if (s === 'ended' || s === 'published') return !!cfg.schedule.end_at && ms < Date.parse(cfg.schedule.end_at) + g;
  return false;
}
const byId = (db, id) => db.contestants.find(c => c.id === id);
const busName = (db, id) => (db.buses.find(b => b.id === id) || {}).name || null;
const dKey = (cid, d) => cid + '|' + d;
function audit(db, action, target, details, reason) {
  db.audit.push({ id: ++db.seq.audit, at: iso(now()), actor: ADMIN, action, target: target ?? null, details: details ?? null, reason: reason ?? null });
  if (db.audit.length > 2000) db.audit.splice(0, db.audit.length - 2000);
}
function rateOk(db, key, max, windowMs) {
  const r = db.rate[key], t = now();
  if (!r || r.start < t - windowMs) db.rate[key] = { start: t, hits: 1 }; else r.hits++;
  return db.rate[key].hits <= max;
}
async function sha(s) {
  if (crypto.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return 'h' + h;
}
function randBelow(n) {               // رقم منتظم في [0,n) مع rejection sampling
  const lim = Math.floor(2 ** 48 / n) * n;
  for (; ;) {
    const b = crypto.getRandomValues(new Uint32Array(2));
    const r = (b[0] & 0xffff) * 2 ** 32 + b[1];
    if (r < lim) return r % n;
  }
}

function recompute(db, cid) {
  for (const k of Object.keys(db.daily)) if (k.startsWith(cid + '|')) delete db.daily[k];
  const add = (d, f, v) => { const k = dKey(cid, d); const o = db.daily[k] || (db.daily[k] = { app: 0, man: 0, adj: 0 }); o[f] += v; };
  const c = byId(db, cid); if (!c) return;
  let app = 0, rej = 0, man = 0, pend = 0, adj = 0;
  for (const b of db.batches) if (b.contestant_id === cid) { app += b.accepted; if (b.reason === 'speed') rej += b.rejected; add(b.day_date, 'app', b.accepted); }
  for (const m of db.manual) if (m.contestant_id === cid) { if (m.status === 'approved') { man += m.count; add(m.day_date, 'man', m.count); } else if (m.status === 'pending') pend += m.count; }
  for (const a of db.adjustments) if (a.contestant_id === cid) { adj += a.delta; add(a.day_date, 'adj', a.delta); }
  Object.assign(c, { app_total: app, rejected_total: rej, manual_total: man, manual_pending: pend, adj_total: adj });
  db.cache.at = 0;
}

function refreshCache(db, force = false) {
  if (!force && db.cache.at > now() - 10000) return db.cache.data;
  const cfg = cfgOf(db), inc = cfg.manual.include_in_totals, wd = cfg.display.withdrawn_in_total, td = dayOf(db, now());
  const tot = (c) => c.app_total + c.adj_total + (inc ? c.manual_total : 0);
  const cs = db.contestants.filter(c => !c.is_test && (c.status === 'active' || (c.status === 'withdrawn' && wd)));
  const ids = new Set(cs.map(c => c.id));
  let today = 0;
  for (const [k, v] of Object.entries(db.daily)) { const [cid, d] = k.split('|'); if (d === td && ids.has(cid)) today += v.app + v.adj + (inc ? v.man : 0); }
  const act = cs.filter(c => c.status === 'active');
  const buses = db.buses.filter(b => !b.is_test).map(b => {
    const m = act.filter(c => c.bus_id === b.id), s = m.reduce((a, c) => a + tot(c), 0);
    return { id: b.id, name: b.name, members: m.length, total: s, avg: m.length ? Math.round(s / m.length) : 0 };
  }).sort((a, b) => b.total - a.total);
  const gender = {};
  for (const g of ['m', 'f']) { const m = act.filter(c => c.gender === g), s = m.reduce((a, c) => a + tot(c), 0); gender[g] = { members: m.length, total: s, avg: m.length ? Math.round(s / m.length) : 0 }; }
  db.cache = { data: { total: cs.reduce((a, c) => a + tot(c), 0), today, participants: act.length, buses, gender }, at: now() };
  return db.cache.data;
}

async function session(db, token) {
  const s = db.sessions[await sha(token || '')];
  if (!s || s.exp < now() || !byId(db, s.cid)) fail('bad_session');
  return s.cid;
}
async function newSession(db, cid, remember) {
  const tok = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
  db.sessions[await sha(tok)] = { cid, exp: now() + (remember !== false ? cfgOf(db).login.remember_days * DAY_MS : 12 * 3600000) };
  return tok;
}

function meJson(db, cid, full = true) {
  const c = byId(db, cid), td = dayOf(db, now()), t = db.daily[dKey(cid, td)] || { app: 0, man: 0, adj: 0 };
  const res = {
    id: c.id, name: c.name, gender: c.gender, bus_id: c.bus_id, bus_name: busName(db, c.bus_id), status: c.status,
    app_total: c.app_total, manual_total: c.manual_total, manual_pending: c.manual_pending, adj_total: c.adj_total,
    rejected_total: c.rejected_total, today_key: td, today: { ...t }
  };
  if (full) {
    res.days = Object.entries(db.daily).filter(([k]) => k.startsWith(cid + '|')).map(([k, v]) => ({ d: k.split('|')[1], ...v })).sort((a, b) => a.d < b.d ? -1 : 1);
    res.manual = db.manual.filter(m => m.contestant_id === cid).sort((a, b) => a.created_at < b.created_at ? 1 : -1).slice(0, 30)
      .map(m => ({ id: m.id, at: m.created_at, count: m.count, status: m.status }));
  }
  return res;
}

function makeSnapshot(db, test) {
  const cfg = cfgOf(db), n = Math.max(1, cfg.results.top_n), inc = cfg.manual.include_in_totals;
  const rows = db.contestants.filter(c => c.is_test === test && c.status === 'active')
    .map(c => ({ id: c.id, name: c.name, gender: c.gender, bus: busName(db, c.bus_id), total: c.app_total + c.adj_total + (inc ? c.manual_total : 0), reached_at: c.reached_at }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total || (a.reached_at || '9') .localeCompare(b.reached_at || '9') || a.name.localeCompare(b.name));
  const top = (arr) => arr.slice(0, n).map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, bus: r.bus, gender: r.gender, total: r.total }));
  let lists = { overall: top(rows), m: top(rows.filter(r => r.gender === 'm')), f: top(rows.filter(r => r.gender === 'f')) };
  if (cfg.results.scope === 'overall') lists = { overall: lists.overall };
  else if (cfg.results.scope === 'gender') lists = { m: lists.m, f: lists.f };
  const snap = { id: ++db.seq.snap, created_at: iso(now()), created_by: ADMIN, is_test: test, data: { top_n: n, lists, at: iso(now()) } };
  db.snapshots.push(snap);
  return { id: snap.id, lists };
}

function customOk(conds, v) {
  for (const c of conds || []) {
    if (!c.on) continue;
    if (!['eq', 'ne', 'ge', 'le'].includes(c.op)) fail('bad_condition');
    let val = String(c.value ?? '').trim(), ok;
    if (['total', 'active_days', 'manual'].includes(c.field)) {
      if (!/^-?\d+(\.\d+)?$/.test(val)) fail('bad_condition');
      const l = v[c.field] || 0, r = Number(val);
      ok = c.op === 'eq' ? l === r : c.op === 'ne' ? l !== r : c.op === 'ge' ? l >= r : l <= r;
    } else if (['gender', 'bus', 'status'].includes(c.field)) {
      if (c.field === 'bus' && /^\d+$/.test(val)) val = 'باص ' + val;
      const l = String(v[c.field] ?? '');
      if ((c.op === 'ge' || c.op === 'le') && /\d/.test(l) && /\d/.test(val)) {
        const a = Number(l.replace(/\D/g, '')), b = Number(val.replace(/\D/g, ''));
        ok = c.op === 'ge' ? a >= b : a <= b;
      } else ok = c.op === 'eq' ? l === val : c.op === 'ne' ? l !== val : c.op === 'ge' ? l >= val : l <= val;
    } else fail('bad_condition');
    if (!ok) return false;
  }
  return true;
}

function eligible(db, gender, test) {
  const cfg = cfgOf(db), d = cfg.draw, inc = d.include_manual, sv = Math.max(1, d.share_value), dmin = d.active_days.day_min;
  let topIds = new Set();
  if (d.exclude_top.on) {
    const snap = [...db.snapshots].reverse().find(s => s.is_test === test);
    if (snap) Object.values(snap.data.lists).forEach(l => l.forEach(e => topIds.add(e.id)));
    else {
      const incT = cfg.manual.include_in_totals;
      db.contestants.filter(c => c.is_test === test && c.status === 'active')
        .sort((a, b) => (b.app_total + b.adj_total + (incT ? b.manual_total : 0)) - (a.app_total + a.adj_total + (incT ? a.manual_total : 0)))
        .slice(0, cfg.results.top_n).forEach(c => topIds.add(c.id));
    }
  }
  const prev = new Set(db.winners.filter(w => w.status === 'active' && db.rounds.find(r => r.id === w.round_id && r.status === 'done' && r.is_test === test)).map(w => w.contestant_id));
  const out = [];
  for (const c of db.contestants) {
    if (c.is_test !== test || (gender !== 'all' && c.gender !== gender)) continue;
    const tot = c.app_total + c.adj_total + (inc ? c.manual_total : 0);
    let adays = 0;
    for (const [k, v] of Object.entries(db.daily)) if (k.startsWith(c.id + '|') && v.app + v.adj + (inc ? v.man : 0) >= dmin) adays++;
    let sh = !d.shares_enabled ? (tot > 0 ? 1 : 0) : Math.floor(Math.max(tot, 0) / sv);
    if (d.shares_enabled && d.max_shares > 0) sh = Math.min(sh, d.max_shares);
    const om = (db.overrides[c.id] || {}).mode;
    if (om === 'exclude') continue;
    const bname = busName(db, c.bus_id);
    const pass = om === 'include' || (sh > 0
      && (!d.min_total.on || tot >= d.min_total.value)
      && (!d.active_days.on || adays >= d.active_days.days)
      && (!d.exclude_flagged || c.review_status !== 'pending')
      && (!d.exclude_inactive || c.status === 'active')
      && (!d.exclude_prev_winners || !prev.has(c.id))
      && !topIds.has(c.id)
      && customOk(d.custom, { total: tot, active_days: adays, gender: c.gender, bus: bname || '', status: c.status, manual: c.manual_total }));
    if (pass) out.push({ contestant_id: c.id, name: c.name, gender: c.gender, bus_name: bname, total: tot, active_days: adays, shares: om === 'include' ? Math.max(sh, 1) : sh, forced: om === 'include' });
  }
  return out;
}

function pickWeighted(db, rid, exclude) {
  const list = db.entries.filter(e => e.round_id === rid && !exclude.includes(e.contestant_id))
    .sort((a, b) => a.contestant_id < b.contestant_id ? -1 : 1);
  const tot = list.reduce((a, e) => a + e.shares, 0);
  if (tot <= 0) return null;
  const ticket = randBelow(tot) + 1;
  let cum = 0;
  for (const e of list) { cum += e.shares; if (cum >= ticket) return e; }
  return null;
}

// ========== الدوال (بنفس أسماء دوال Supabase) ==========
const fns = {
  // ----- عامة -----
  sl_public_state(db) {
    const cfg = clone(db.settings.config); delete cfg.review;
    const status = statusOf(db);
    const res = {
      server_now: iso(now()), status, config: cfg, state: db.settings.state,
      logo_version: db.settings.logo ? db.settings.logo.version : '',
      cache: refreshCache(db),
      buses: cfgOf(db).login.self_register ? db.buses.filter(b => !b.is_test).sort((a, b) => a.sort - b.sort).map(b => ({ id: b.id, name: b.name })) : []
    };
    if (status === 'published') {
      const snap = [...db.snapshots].reverse().find(s => !s.is_test);
      const top = {};
      if (snap) for (const [k, l] of Object.entries(snap.data.lists)) top[k] = l.map(e => ({ rank: e.rank, name: e.name, bus: e.bus }));
      res.results = {
        top, rounds: db.rounds.filter(r => r.status === 'done' && !r.is_test).map(r => ({
          name: r.name, winners: db.winners.filter(w => w.round_id === r.id && w.status === 'active').sort((a, b) => a.draw_order - b.draw_order).map(w => ({ name: w.name, bus: w.bus_name }))
        }))
      };
    }
    return res;
  },
  sl_get_logo(db) { return db.settings.logo || {}; },
  sl_lookup(db, { p_phone }) {
    const ph = normalizePhone(p_phone);
    if (!ph) return { error: 'invalid_phone' };
    if (!rateOk(db, 'lk:' + ph, 20, 600000)) return { error: 'rate_limited' };
    const c = db.contestants.find(x => x.phone === ph), cfg = cfgOf(db);
    if (!c) return { found: false, phone: ph, self_register: cfg.login.self_register };
    return { found: true, phone: ph, name: c.name, bus_name: busName(db, c.bus_id), status: c.status, pin_enabled: cfg.login.pin_enabled, pin_set: !!c.pin_hash };
  },
  async sl_login(db, { p_phone, p_pin, p_remember }) {
    const ph = normalizePhone(p_phone); if (!ph) return { error: 'invalid_phone' };
    const c = db.contestants.find(x => x.phone === ph); if (!c) return { error: 'not_found' };
    if (cfgOf(db).login.pin_enabled) {
      if (!c.pin_hash) { if (!/^\d{4}$/.test(p_pin || '')) return { error: 'pin_setup' }; c.pin_hash = await sha('pin:' + p_pin); }
      else {
        if (!rateOk(db, 'pin:' + c.id, 6, 900000)) return { error: 'rate_limited' };
        if (!p_pin) return { error: 'pin_required' };
        if (await sha('pin:' + p_pin) !== c.pin_hash) return { error: 'pin_wrong' };
      }
    }
    return { token: await newSession(db, c.id, p_remember), me: meJson(db, c.id) };
  },
  async sl_register(db, { p_name, p_phone, p_gender, p_bus_id, p_pin, p_remember }) {
    const cfg = cfgOf(db), ph = normalizePhone(p_phone);
    if (!cfg.login.self_register) return { error: 'registration_closed' };
    if (!ph) return { error: 'invalid_phone' };
    if ((p_name || '').trim().length < 2) return { error: 'name_required' };
    if (!['m', 'f'].includes(p_gender)) return { error: 'gender_required' };
    if (!db.buses.find(b => b.id === Number(p_bus_id) && !b.is_test)) return { error: 'bus_required' };
    if (db.contestants.find(x => x.phone === ph)) return { error: 'phone_exists' };
    if (cfg.login.pin_enabled && !/^\d{4}$/.test(p_pin || '')) return { error: 'pin_invalid' };
    const c = newContestant({ name: p_name.trim().slice(0, 80), phone: ph, gender: p_gender, bus_id: Number(p_bus_id), created_by: 'self' });
    if (cfg.login.pin_enabled) c.pin_hash = await sha('pin:' + p_pin);
    db.contestants.push(c); db.cache.at = 0;
    return { token: await newSession(db, c.id, p_remember), me: meJson(db, c.id) };
  },
  async sl_me(db, { p_token }) { return meJson(db, await session(db, p_token)); },
  async sl_logout(db, { p_token }) { delete db.sessions[await sha(p_token || '')]; return { ok: true }; },

  async sl_submit_batch(db, { p_token, p_batch_id, p_count, p_stats }) {
    const ex = db.batches.find(b => b.batch_id === p_batch_id);
    if (ex) return { duplicate: true, accepted: ex.accepted, rejected: ex.rejected, reason: ex.reason, me: meJson(db, ex.contestant_id, false) };
    const cid = await session(db, p_token), c = byId(db, cid), cfg = cfgOf(db), st = db.settings.state, t = now();
    const count = Math.max(0, Math.floor(Number(p_count) || 0));
    const iv = Math.max(50, cfg.speed.min_interval_ms), cap = cfg.speed.max_offline_hours * 3600000 / iv;
    const req = Math.min(count, cfg.speed.max_batch);
    const s = cfg.schedule.start_at ? Date.parse(cfg.schedule.start_at) : null, e = cfg.schedule.end_at ? Date.parse(cfg.schedule.end_at) : null;
    let acc = 0, reason = 'ok', tokens = c.bucket_tokens;
    if (!s || !accepting(db, t)) reason = 'closed';
    else {
      let winEnd = t;
      if (e && e < winEnd) winEnd = e;
      if (st.paused && st.paused_at) winEnd = Math.min(winEnd, Date.parse(st.paused_at));
      const from = Math.max(c.bucket_at ? Date.parse(c.bucket_at) : s, s);
      tokens = Math.min(cap, tokens + Math.max(0, (winEnd - from) / iv));
      acc = Math.min(req, Math.floor(tokens));
      if (acc < count) reason = req < count && acc === req ? 'batch_cap' : 'speed';
      if (cfg.speed.daily_cap_enabled) {
        const ta = (db.daily[dKey(cid, dayOf(db, t))] || { app: 0 }).app;
        if (ta + acc > cfg.speed.daily_cap) { acc = Math.max(0, cfg.speed.daily_cap - ta); reason = 'daily_cap'; }
      }
      tokens -= acc; c.bucket_at = iso(Math.max(from, winEnd));
    }
    let d = dayOf(db, t);
    if (s) { const sd = dayOf(db, s); if (d < sd) d = sd; }
    if (e) { const ed = dayOf(db, e - 1); if (d > ed) d = ed; }
    db.batches.push({ batch_id: p_batch_id, contestant_id: cid, received_at: iso(t), day_date: d, requested: count, accepted: acc, rejected: count - acc, reason, client_stats: p_stats || null });
    if (acc > 0) { const k = dKey(cid, d); (db.daily[k] = db.daily[k] || { app: 0, man: 0, adj: 0 }).app += acc; }
    c.app_total += acc; if (reason === 'speed') c.rejected_total += count - acc;
    // علامات المراجعة
    const rv = cfg.review, newr = [];
    if (rv.reject_ratio_enabled && c.app_total + c.rejected_total >= rv.reject_min_sample && c.rejected_total * 100 > rv.reject_ratio_pct * (c.app_total + c.rejected_total)) newr.push('reject_ratio');
    if (rv.daily_rate_enabled && (db.daily[dKey(cid, d)] || { app: 0 }).app > rv.daily_rate) newr.push('daily_rate');
    if (rv.robotic_enabled && p_stats && p_stats.n >= rv.robotic_min_presses && typeof p_stats.sd === 'number' && p_stats.sd < rv.robotic_stdev_ms) newr.push('robotic');
    for (const r of newr) if (!c.flag_reasons.includes(r)) { c.flag_reasons.push(r); if (c.review_status !== 'excluded') c.review_status = 'pending'; }
    if (p_stats && typeof p_stats.min === 'number' && (c.stats.min_gap == null || p_stats.min < c.stats.min_gap)) c.stats.min_gap = p_stats.min;
    if (p_stats && typeof p_stats.avg === 'number') Object.assign(c.stats, { last_avg: p_stats.avg, last_sd: p_stats.sd });
    c.bucket_tokens = tokens; c.last_sync_at = iso(t);
    if (acc > 0) c.last_active_at = c.reached_at = iso(t);
    db.cache.at = Math.min(db.cache.at, t - 9000);   // يتحدث الكاش قريباً
    return { accepted: acc, rejected: count - acc, reason, me: meJson(db, cid, false) };
  },

  async sl_add_manual(db, { p_token, p_count }) {
    const cid = await session(db, p_token), cfg = cfgOf(db), d = dayOf(db, now());
    if (!cfg.manual.enabled) return { error: 'manual_disabled' };
    if (!accepting(db, now())) return { error: 'not_running' };
    const n = Math.floor(Number(p_count) || 0);
    if (n < 1) return { error: 'bad_count' };
    if (n > cfg.manual.max_per_entry) return { error: 'manual_too_big' };
    const used = db.manual.filter(m => m.contestant_id === cid && m.day_date === d && ['pending', 'approved'].includes(m.status)).reduce((a, m) => a + m.count, 0);
    if (used + n > cfg.manual.max_per_day) return { error: 'manual_daily_limit' };
    const appr = !cfg.manual.require_approval;
    db.manual.push({ id: ++db.seq.manual, contestant_id: cid, created_at: iso(now()), day_date: d, count: n, status: appr ? 'approved' : 'pending', decided_by: appr ? 'auto' : null, decided_at: appr ? iso(now()) : null, note: null });
    recompute(db, cid);
    if (appr) { const c = byId(db, cid); c.reached_at = c.last_active_at = iso(now()); }
    return { ok: true, pending: !appr, me: meJson(db, cid) };
  },

  // ----- المشرف -----
  sl_admin_whoami() { return { email: ADMIN, is_admin: true }; },
  sl_admin_dump(db, { p_test = false }) {
    const test = !!p_test;
    const daily = [];
    const ids = new Set(db.contestants.filter(c => c.is_test === test).map(c => c.id));
    for (const [k, v] of Object.entries(db.daily)) { const [cid, d] = k.split('|'); if (ids.has(cid)) daily.push([cid, d, v.app, v.man, v.adj]); }
    const roundIds = new Set(db.rounds.filter(r => r.is_test === test).map(r => r.id));
    return {
      server_now: iso(now()), status: statusOf(db), config: db.settings.config, state: db.settings.state,
      logo_version: db.settings.logo ? db.settings.logo.version : null,
      buses: db.buses.filter(b => b.is_test === test),
      contestants: db.contestants.filter(c => c.is_test === test).map(c => { const o = { ...c, pin_set: !!c.pin_hash }; delete o.pin_hash; delete o.bucket_tokens; delete o.bucket_at; return o; }),
      daily,
      manual: db.manual.filter(m => ids.has(m.contestant_id)).sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || (a.created_at < b.created_at ? 1 : -1)).slice(0, 500),
      overrides: Object.entries(db.overrides).filter(([id]) => ids.has(id)).map(([id, o]) => ({ contestant_id: id, ...o })),
      rounds: db.rounds.filter(r => r.is_test === test),
      winners: db.winners.filter(w => roundIds.has(w.round_id)).sort((a, b) => a.round_id - b.round_id || a.draw_order - b.draw_order),
      snapshot: [...db.snapshots].reverse().find(s => s.is_test === test) || null,
      audit: [...db.audit].reverse().slice(0, 300),
      test_count: db.contestants.filter(c => c.is_test).length
    };
  },
  sl_admin_contestant(db, { p_id }) {
    return {
      batches: db.batches.filter(b => b.contestant_id === p_id).sort((a, b) => a.received_at < b.received_at ? 1 : -1).slice(0, 400),
      manual: db.manual.filter(m => m.contestant_id === p_id).reverse(),
      adjustments: db.adjustments.filter(a => a.contestant_id === p_id).reverse(),
      audit: db.audit.filter(a => a.target === p_id).reverse(),
      sessions: Object.values(db.sessions).filter(s => s.cid === p_id && s.exp > now()).length,
      batch_count: db.batches.filter(b => b.contestant_id === p_id).length
    };
  },
  sl_admin_save_config(db, { p_config }) {
    const old = db.settings.config || {};
    const ch = [...new Set([...Object.keys(old), ...Object.keys(p_config)])].filter(k => JSON.stringify(old[k]) !== JSON.stringify(p_config[k]));
    db.settings.config = clone(p_config); db.cache.at = 0;
    audit(db, 'save_config', null, { sections: ch });
    return { ok: true };
  },
  sl_admin_save_logo(db, { p_data }) {
    if (p_data && (p_data.length > 290000 || !p_data.startsWith('data:image/'))) fail('logo_too_big');
    db.settings.logo = p_data ? { data: p_data, version: String(Math.floor(now() / 1000)) } : null;
    audit(db, 'save_logo', null, { size: (p_data || '').length });
    return { ok: true };
  },
  sl_admin_freeze(db, { p_test = false }) {
    const r = makeSnapshot(db, !!p_test);
    if (!p_test) db.settings.state.frozen_at = iso(now());
    audit(db, 'freeze_results', null, { snapshot: r.id, test: !!p_test });
    return r;
  },
  sl_admin_state(db, { p_action }) {
    const cfg = db.settings.config, st = db.settings.state;
    cfg.schedule = cfg.schedule || {};
    switch (p_action) {
      case 'start_now':
        cfg.schedule.start_at = iso(now());
        if (cfg.schedule.end_at && Date.parse(cfg.schedule.end_at) <= now()) cfg.schedule.end_at = null;
        Object.assign(st, { mode: 'auto', paused: false, paused_at: null }); break;
      case 'pause': Object.assign(st, { paused: true, paused_at: iso(now()) }); break;
      case 'resume': Object.assign(st, { paused: false, paused_at: null }); break;
      case 'end_now': cfg.schedule.end_at = iso(now()); st.paused = false; break;
      case 'activate': st.mode = 'auto'; break;
      case 'draft': st.mode = 'draft'; break;
      case 'publish':
        if (!st.frozen_at) { makeSnapshot(db, false); st.frozen_at = iso(now()); }
        Object.assign(st, { published: true, published_at: iso(now()) }); break;
      case 'unpublish': st.published = false; break;
      default: fail('bad_action');
    }
    db.cache.at = 0; audit(db, 'state_' + p_action);
    return { ok: true, status: statusOf(db) };
  },
  sl_admin_bus(db, { p_action, p_id, p_name }) {
    if (p_action === 'add') busId(db, p_name, false);
    else if (p_action === 'rename') { const b = db.buses.find(x => x.id === p_id); if (b) b.name = (p_name || '').trim(); }
    else if (p_action === 'delete') { db.buses = db.buses.filter(x => x.id !== p_id); db.contestants.forEach(c => { if (c.bus_id === p_id) c.bus_id = null; }); }
    else fail('bad_action');
    db.cache.at = 0; audit(db, 'bus_' + p_action, String(p_id ?? ''), { name: p_name });
    return { ok: true };
  },
  sl_admin_upsert_contestant(db, { p }) {
    const ph = normalizePhone(p.phone);
    if (!ph) fail('invalid_phone');
    if ((p.name || '').trim().length < 2) fail('name_required');
    if (!['m', 'f'].includes(p.gender)) fail('gender_required');
    const bid = p.bus_id ? Number(p.bus_id) : busId(db, p.bus_name, false);
    const other = db.contestants.find(c => c.phone === ph);
    if (other && other.id !== p.id) fail('phone_exists');
    let id = p.id;
    if (!id) {
      const c = newContestant({ name: p.name.trim(), phone: ph, gender: p.gender, bus_id: bid, created_by: 'admin' });
      if (p.joined_at) c.joined_at = p.joined_at;
      db.contestants.push(c); id = c.id; audit(db, 'add_contestant', id, p);
    } else {
      Object.assign(byId(db, id), { name: p.name.trim(), phone: ph, gender: p.gender, bus_id: bid }); audit(db, 'edit_contestant', id, p);
    }
    db.cache.at = 0; return { ok: true, id };
  },
  sl_admin_set_status(db, { p_id, p_status, p_reason }) {
    if (!(p_reason || '').trim()) fail('reason_required');
    const c = byId(db, p_id); c.status = p_status;
    if (p_status === 'active' && c.review_status === 'excluded') c.review_status = 'approved';
    db.cache.at = 0; audit(db, 'status_' + p_status, p_id, null, p_reason); return { ok: true };
  },
  sl_admin_reset_pin(db, { p_id }) {
    byId(db, p_id).pin_hash = null;
    for (const [k, s] of Object.entries(db.sessions)) if (s.cid === p_id) delete db.sessions[k];
    audit(db, 'reset_pin', p_id); return { ok: true };
  },
  sl_admin_delete_contestant(db, { p_id, p_reason }) {
    if (!(p_reason || '').trim()) fail('reason_required');
    const c = byId(db, p_id);
    db.contestants = db.contestants.filter(x => x.id !== p_id);
    for (const t of ['batches', 'manual', 'adjustments']) db[t] = db[t].filter(x => x.contestant_id !== p_id);
    for (const k of Object.keys(db.daily)) if (k.startsWith(p_id + '|')) delete db.daily[k];
    for (const [k, s] of Object.entries(db.sessions)) if (s.cid === p_id) delete db.sessions[k];
    delete db.overrides[p_id];
    db.cache.at = 0;
    audit(db, 'delete_contestant', p_id, { name: c.name, phone: c.phone, app_total: c.app_total, manual_total: c.manual_total, adj_total: c.adj_total }, p_reason);
    return { ok: true };
  },
  sl_admin_adjust(db, { p_id, p_delta, p_reason }) {
    if (!(p_reason || '').trim()) fail('reason_required');
    if (!p_delta) fail('bad_count');
    db.adjustments.push({ id: ++db.seq.adj, contestant_id: p_id, created_at: iso(now()), day_date: dayOf(db, now()), delta: p_delta, kind: 'adjust', reason: p_reason, admin_email: ADMIN });
    recompute(db, p_id); if (p_delta > 0) byId(db, p_id).reached_at = iso(now());
    audit(db, 'adjust', p_id, { delta: p_delta }, p_reason); return { ok: true };
  },
  sl_admin_review(db, { p_id, p_decision, p_delta, p_reason }) {
    if (!(p_reason || '').trim()) fail('reason_required');
    const c = byId(db, p_id);
    if (p_decision === 'approve') Object.assign(c, { review_status: 'approved', review_note: p_reason });
    else if (p_decision === 'deduct') {
      if (!p_delta) fail('bad_count');
      db.adjustments.push({ id: ++db.seq.adj, contestant_id: p_id, created_at: iso(now()), day_date: dayOf(db, now()), delta: -Math.abs(p_delta), kind: 'review_deduct', reason: p_reason, admin_email: ADMIN });
      Object.assign(c, { review_status: 'deducted', review_note: p_reason }); recompute(db, p_id);
    } else if (p_decision === 'exclude') Object.assign(c, { review_status: 'excluded', status: 'excluded', review_note: p_reason });
    else if (p_decision === 'reset') Object.assign(c, { review_status: 'none', flag_reasons: [], review_note: p_reason });
    else fail('bad_action');
    db.cache.at = 0; audit(db, 'review_' + p_decision, p_id, { delta: p_delta }, p_reason); return { ok: true };
  },
  sl_admin_manual(db, { p_id, p_action, p_reason }) {
    const m = db.manual.find(x => x.id === p_id); if (!m) fail('not_found');
    m.status = { approve: 'approved', reject: 'rejected', revert: 'reverted' }[p_action] || m.status;
    Object.assign(m, { decided_by: ADMIN, decided_at: iso(now()), note: p_reason || m.note });
    recompute(db, m.contestant_id); if (p_action === 'approve') byId(db, m.contestant_id).reached_at = iso(now());
    audit(db, 'manual_' + p_action, m.contestant_id, { entry: p_id, count: m.count }, p_reason); return { ok: true };
  },
  sl_admin_override(db, { p_id, p_mode, p_reason }) {
    if (!p_mode) delete db.overrides[p_id];
    else { if (!(p_reason || '').trim()) fail('reason_required'); db.overrides[p_id] = { mode: p_mode, reason: p_reason, by_email: ADMIN, at: iso(now()) }; }
    audit(db, 'override_' + (p_mode || 'remove'), p_id, null, p_reason); return { ok: true };
  },
  sl_admin_import(db, { p_rows, p_on_dup }) {
    let ins = 0, upd = 0, skp = 0, bad = 0; const b0 = db.buses.filter(b => !b.is_test).length;
    for (const r of p_rows) {
      const ph = normalizePhone(r.phone);
      if (!ph || !['m', 'f'].includes(r.gender) || (r.name || '').trim().length < 2) { bad++; continue; }
      const c = db.contestants.find(x => x.phone === ph);
      if (c) { if (p_on_dup === 'update') { Object.assign(c, { name: r.name.trim(), gender: r.gender, bus_id: busId(db, r.bus, false) ?? c.bus_id }); upd++; } else skp++; }
      else { db.contestants.push(newContestant({ name: r.name.trim(), phone: ph, gender: r.gender, bus_id: busId(db, r.bus, false), created_by: 'import' })); ins++; }
    }
    const res = { inserted: ins, updated: upd, skipped: skp, invalid: bad, buses_created: db.buses.filter(b => !b.is_test).length - b0 };
    db.cache.at = 0; audit(db, 'import', null, res); return res;
  },
  sl_draw_preview(db, { p_gender = 'all', p_test = false }) {
    const e = eligible(db, p_gender, !!p_test).sort((a, b) => b.shares - a.shares || b.total - a.total);
    return { count: e.length, total_shares: e.reduce((a, x) => a + x.shares, 0), entries: e };
  },
  sl_run_draw(db, { p_name, p_count, p_gender = 'all', p_test = false }) {
    if (!(p_name || '').trim()) fail('name_required');
    if (!(p_count >= 1)) fail('bad_count');
    const el = eligible(db, p_gender, !!p_test);
    if (!el.length) fail('draw_no_eligible');
    const rid = ++db.seq.round;
    const tot = el.reduce((a, x) => a + x.shares, 0);
    db.rounds.push({ id: rid, name: p_name.trim(), winners_count: p_count, gender: p_gender, status: 'done', is_test: !!p_test, executed_at: iso(now()), executed_by: ADMIN,
      rules: { draw: clone(cfgOf(db).draw), gender: p_gender, count: p_count }, eligible_count: el.length, total_shares: tot });
    el.forEach(x => db.entries.push({ round_id: rid, ...x }));
    const picked = [];
    for (let i = 1; i <= Math.min(p_count, el.length); i++) {
      const e = pickWeighted(db, rid, picked); if (!e) break;
      db.winners.push({ id: ++db.seq.winner, round_id: rid, contestant_id: e.contestant_id, draw_order: i, name: e.name, gender: e.gender, bus_name: e.bus_name, shares: e.shares, total: e.total,
        status: 'active', replacement_of: null, replaced_reason: null, replaced_at: null, contacted: false, delivered: false, drawn_at: iso(now()) });
      picked.push(e.contestant_id);
    }
    audit(db, 'run_draw', String(rid), { name: p_name, count: p_count, gender: p_gender, eligible: el.length, total_shares: tot, winners: picked.length, test: !!p_test });
    return { round_id: rid, eligible: el.length, total_shares: tot, winners: picked.length };
  },
  sl_round_entries(db, { p_round }) { return db.entries.filter(e => e.round_id === p_round); },
  sl_cancel_draw(db, { p_round, p_reason }) {
    if (!(p_reason || '').trim()) fail('reason_required');
    const r = db.rounds.find(x => x.id === p_round && x.status === 'done');
    if (r) Object.assign(r, { status: 'cancelled', cancelled_at: iso(now()), cancelled_by: ADMIN, cancel_reason: p_reason });
    audit(db, 'cancel_draw', String(p_round), null, p_reason); return { ok: true };
  },
  sl_replace_winner(db, { p_winner, p_reason }) {
    if (!(p_reason || '').trim()) fail('reason_required');
    const w = db.winners.find(x => x.id === p_winner && x.status === 'active'); if (!w) fail('not_found');
    const r = db.rounds.find(x => x.id === w.round_id); if (r.status !== 'done') fail('draw_cancelled');
    let ex = db.winners.filter(x => x.round_id === r.id).map(x => x.contestant_id);
    if (r.rules.draw.exclude_prev_winners !== false)
      ex = ex.concat(db.winners.filter(x => x.round_id !== r.id && x.status === 'active' && db.rounds.find(q => q.id === x.round_id && q.status === 'done' && q.is_test === r.is_test)).map(x => x.contestant_id));
    ex = ex.concat(Object.entries(db.overrides).filter(([, o]) => o.mode === 'exclude').map(([id]) => id));
    const e = pickWeighted(db, r.id, ex); if (!e) fail('no_candidates');
    Object.assign(w, { status: 'replaced', replaced_reason: p_reason, replaced_at: iso(now()) });
    const nid = ++db.seq.winner;
    db.winners.push({ id: nid, round_id: r.id, contestant_id: e.contestant_id, draw_order: Math.max(...db.winners.filter(x => x.round_id === r.id).map(x => x.draw_order)) + 1,
      name: e.name, gender: e.gender, bus_name: e.bus_name, shares: e.shares, total: e.total, status: 'active', replacement_of: w.id, replaced_reason: null, replaced_at: null, contacted: false, delivered: false, drawn_at: iso(now()) });
    audit(db, 'replace_winner', String(r.id), { old: w.name, new: e.name, winner_id: nid }, p_reason);
    return { ok: true, winner_id: nid, name: e.name, bus: e.bus_name, shares: e.shares };
  },
  sl_admin_winner_mark(db, { p_winner, p_field, p_value }) {
    const w = db.winners.find(x => x.id === p_winner); if (!w || !['contacted', 'delivered'].includes(p_field)) fail('bad_action');
    w[p_field] = !!p_value; audit(db, 'winner_' + p_field, String(p_winner), { value: !!p_value }); return { ok: true };
  },
  sl_admin_simulate(db) {
    const cfg = cfgOf(db), mn = ['محمد', 'علي', 'حسن', 'حسين', 'أحمد', 'جعفر', 'عباس', 'مهدي', 'رضا', 'صادق', 'باقر', 'كاظم', 'سلمان', 'عيسى', 'موسى'],
      fn = ['زينب', 'فاطمة', 'مريم', 'زهراء', 'نرجس', 'سكينة', 'رقية', 'خديجة', 'معصومة', 'بتول', 'حوراء', 'آمنة', 'ليلى', 'كوثر', 'هدى'],
      fam = ['الخلف', 'الحسن', 'الموسى', 'العلي', 'الصالح', 'الأحمد', 'الناصر', 'الحمد', 'البقشي', 'العيسى'];
    const bids = [1, 2, 3, 4].map(i => busId(db, 'باص تجريبي ' + i, true));
    const td = dayOf(db, now());
    const day0 = cfg.schedule.start_at ? dayOf(db, Date.parse(cfg.schedule.start_at)) : new Date(keyToMs(td) - 3 * DAY_MS).toISOString().slice(0, 10);
    let nd = cfg.schedule.end_at ? Math.round((keyToMs(dayOf(db, Date.parse(cfg.schedule.end_at) - 1)) - keyToMs(day0)) / DAY_MS) + 1 : Math.round((keyToMs(td) - keyToMs(day0)) / DAY_MS) + 1;
    nd = Math.max(1, Math.min(15, nd));
    for (let i = 1; i <= 60; i++) {
      const g = i % 2 === 0 ? 'f' : 'm', ph = '99900' + String(i).padStart(5, '0');
      if (db.contestants.find(c => c.phone === ph)) continue;
      const c = newContestant({ name: (g === 'm' ? mn : fn)[i % 15] + ' ' + fam[(i * 7) % 10] + ' (' + i + ')', phone: ph, gender: g, bus_id: bids[i % 4], is_test: true, created_by: 'sim' });
      db.contestants.push(c);
      const lvl = 800 + Math.random() * 5000;
      for (let k = 0; k < nd; k++) {
        if (Math.random() < 0.15) continue;
        const v = Math.round(lvl * (0.4 + Math.random())), rj = Math.random() < 0.08 ? Math.round(v * 0.6) : 0;
        const d = new Date(keyToMs(day0) + k * DAY_MS).toISOString().slice(0, 10);
        db.batches.push({ batch_id: uuid(), contestant_id: c.id, received_at: iso(Math.min(now(), keyToMs(d) + 12 * 3600000)), day_date: d, requested: v + rj, accepted: v, rejected: rj, reason: 'speed', client_stats: {} });
      }
      if (Math.random() < 0.15) db.manual.push({ id: ++db.seq.manual, contestant_id: c.id, created_at: iso(now()), day_date: td, count: 100 + Math.round(Math.random() * 400), status: Math.random() < 0.5 ? 'pending' : 'approved', decided_by: null, decided_at: null, note: null });
      recompute(db, c.id);
      Object.assign(c, { reached_at: iso(now() - Math.random() * 3000 * 60000), last_sync_at: iso(now() - Math.random() * 600 * 60000), last_active_at: iso(now() - Math.random() * 600 * 60000) });
      if (Math.random() < 0.06) Object.assign(c, { review_status: 'pending', flag_reasons: [Math.random() < 0.5 ? 'reject_ratio' : 'robotic'] });
    }
    audit(db, 'simulate', null, { count: 60 }); return { ok: true };
  },
  sl_admin_delete_test(db) {
    const ids = new Set(db.contestants.filter(c => c.is_test).map(c => c.id));
    db.contestants = db.contestants.filter(c => !c.is_test);
    for (const t of ['batches', 'manual', 'adjustments']) db[t] = db[t].filter(x => !ids.has(x.contestant_id));
    for (const k of Object.keys(db.daily)) if (ids.has(k.split('|')[0])) delete db.daily[k];
    for (const id of ids) delete db.overrides[id];
    const rids = new Set(db.rounds.filter(r => r.is_test).map(r => r.id));
    db.rounds = db.rounds.filter(r => !r.is_test); db.entries = db.entries.filter(e => !rids.has(e.round_id)); db.winners = db.winners.filter(w => !rids.has(w.round_id));
    db.snapshots = db.snapshots.filter(s => !s.is_test); db.buses = db.buses.filter(b => !b.is_test);
    audit(db, 'delete_test', null, { contestants: ids.size }); return { ok: true, deleted: ids.size };
  },
  sl_admin_reset(db, { p_opts }) {
    if ((p_opts.confirm || '') !== 'حذف المسابقة') fail('confirm_mismatch');
    const kc = !!p_opts.keep_contestants, kb = kc || p_opts.keep_buses !== false, ks = p_opts.keep_settings !== false;
    const real = db.contestants.filter(c => !c.is_test);
    const summary = { contestants: real.length, total_app: real.reduce((a, c) => a + c.app_total, 0), total_manual: real.reduce((a, c) => a + c.manual_total, 0),
      batches: db.batches.length, rounds: db.rounds.filter(r => !r.is_test).length, keep_contestants: kc, keep_buses: kb, keep_settings: ks };
    Object.assign(db, { rounds: [], entries: [], winners: [], snapshots: [], overrides: {}, batches: [], manual: [], adjustments: [], daily: {}, sessions: {}, rate: {}, cache: { data: {}, at: 0 } });
    db.contestants = db.contestants.filter(c => !c.is_test); db.buses = db.buses.filter(b => !b.is_test);
    if (kc) db.contestants.forEach(c => Object.assign(c, newContestant(c), { id: c.id, created_by: c.created_by }));
    else db.contestants = [];
    if (!kb) db.buses = [];
    const cfg = db.settings.config || {};
    if (ks) { cfg.schedule = { ...(cfg.schedule || {}), start_at: null, end_at: null }; cfg.display = { ...(cfg.display || {}), announcement: '' }; db.settings.config = cfg; }
    else db.settings.config = { ...(p_opts.default_config || {}), identity: cfg.identity };
    db.settings.state = { ...DEFAULT_STATE, mode: 'draft' };
    db.audit = []; audit(db, 'reset_competition', null, summary, p_opts.reason);
    return { ok: true, summary };
  }
};

function busId(db, name, test) {
  let nm = String(name ?? '').trim(); if (!nm) return null;
  if (/^\d+$/.test(nm)) nm = 'باص ' + nm;
  let b = db.buses.find(x => x.name === nm && x.is_test === test);
  if (!b) { b = { id: ++db.seq.bus, name: nm, sort: db.seq.bus, is_test: test, created_at: iso(now()) }; db.buses.push(b); }
  return b.id;
}

// نقطة الدخول الموحدة: نفس شكل استدعاء Supabase RPC
export async function localRpc(name, params = {}) {
  const fn = fns[name];
  if (!fn) throw new Error('unknown rpc ' + name);
  const db = load();
  const res = await fn(db, params);
  save(db);
  return clone(res);
}
