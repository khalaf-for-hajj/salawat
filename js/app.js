// ===== واجهة المتسابق =====
import { rpc, DEMO } from './rpc.js';
import {
  fullConfig, seasonText, normalizePhone, displayPhone, fmt, pct, esc, dayKey, competitionDays, dayName, dayLabel,
  computeStatus, contestantTotal, sharesFor, uuid, applyTheme, toast, errMsg, fmtDuration, STATUS_LABELS
} from './common.js';

const $ = (s, r = document) => r.querySelector(s);
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(k); } catch { } }
};
const SS = {
  get(k, d = null) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { } }
};

// ---------- الحالة ----------
const S = {
  pub: LS.get('sl_pub'),            // آخر حالة عامة (تعمل بلا إنترنت)
  cfg: null, status: 'draft',
  offset: LS.get('sl_offset', 0),   // فرق ساعة الخادم عن الجهاز
  online: navigator.onLine,
  me: null,                         // بيانات المتسابق النشط
  prefs: { anywhere: false, vibrate: true, sound: false, ...LS.get('sl_prefs', {}) },
  view: null, lastPress: -1e9, ignored: 0, wake: null, wakeWanted: false, lastDay: null, viewSig: ''
};
const nowS = () => Date.now() + S.offset;
const curDay = () => dayKey(nowS(), S.cfg.schedule.day_start_hour || 0);

// ---------- الحسابات على هذا الجهاز ----------
// remember=true → localStorage (طوال الرحلة) / false → sessionStorage (حتى إغلاق المتصفح)
function accounts() { return [...LS.get('sl_accounts', []), ...SS.get('sl_accounts_tmp', [])]; }
function saveAccount(a) {
  const keep = LS.get('sl_accounts', []).filter(x => x.cid !== a.cid), tmp = SS.get('sl_accounts_tmp', []).filter(x => x.cid !== a.cid);
  if (a.remember) keep.push(a); else tmp.push(a);
  LS.set('sl_accounts', keep); SS.set('sl_accounts_tmp', tmp);
}
function removeAccount(cid) {
  LS.set('sl_accounts', LS.get('sl_accounts', []).filter(x => x.cid !== cid));
  SS.set('sl_accounts_tmp', SS.get('sl_accounts_tmp', []).filter(x => x.cid !== cid));
}
const activeCid = () => SS.get('sl_active') || LS.get('sl_active');
function setActive(cid) { SS.set('sl_active', cid); LS.set('sl_active', cid); }
const activeAcc = () => accounts().find(a => a.cid === activeCid());

// ---------- طابور الضغطات (محفوظ محلياً فلا يضيع شيء) ----------
// pending: ضغطات لم تُرسل / inflight: دفعة أُرسلت ولم يصل تأكيدها (تُعاد بنفس batch_id)
const queues = {};
function Q(cid = activeCid()) {
  if (!cid) return { pending: 0, inflight: null };
  if (!queues[cid]) queues[cid] = LS.get('sl_q_' + cid) || { token: null, pending: 0, inflight: null, st: { n: 0, min: null, sum: 0, sq: 0 } };
  return queues[cid];
}
const saveQ = (cid = activeCid()) => LS.set('sl_q_' + cid, Q(cid));
// صيغة الجمع العربية لكلمة ضغطة
const presses = (n) => n === 1 ? 'ضغطة واحدة' : n === 2 ? 'ضغطتان' : (n % 100 >= 3 && n % 100 <= 10) ? `${fmt(n)} ضغطات` : `${fmt(n)} ضغطة`;
const unsent = (cid) => { const q = Q(cid); return q.pending + (q.inflight ? q.inflight.count : 0); };

// ---------- البداية ----------
init();
async function init() {
  if (DEMO) {
    const d = $('#demo'); d.classList.remove('hidden');
    d.innerHTML = 'وضع تجريبي — البيانات على هذا الجهاز فقط. جرّب الدخول بـ <b dir="ltr">0500000001</b> … <b dir="ltr">0500000008</b> · <a href="admin.html">لوحة المشرف</a>';
  }
  applyPub();
  loadLogo();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
  await refreshPublic();
  route();
  // المؤقتات
  setInterval(tick, 1000);
  scheduleSync(); schedulePublic();
  addEventListener('online', () => { S.online = true; flushAll(); refreshPublic(); });
  addEventListener('offline', () => { S.online = false; renderSync(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll({ keepalive: true });
    else { refreshPublic(); flushAll(); if (S.wakeWanted) requestWake(); }
  });
  addEventListener('pagehide', () => flushAll({ keepalive: true }));
}

function applyPub() {
  S.cfg = fullConfig(S.pub && S.pub.config);
  applyTheme(S.cfg);
  S.status = computeStatus(S.cfg, S.pub && S.pub.state, nowS());
  $('#campaign').textContent = S.cfg.identity.campaign_name;
  $('#contest').textContent = S.cfg.season.contest_name;
  document.title = seasonText(S.cfg, 'page_title');
}

async function loadLogo() {
  const v = S.pub && S.pub.logo_version, cached = LS.get('sl_logo');
  if (!v) { $('#logo').src = 'assets/logo.png'; return; }
  if (cached && cached.version === v) { $('#logo').src = cached.data; return; }
  try { const l = await rpc('sl_get_logo'); if (l && l.data) { LS.set('sl_logo', l); $('#logo').src = l.data; } } catch { if (cached) $('#logo').src = cached.data; }
}

async function refreshPublic() {
  try {
    const t0 = Date.now(); const p = await rpc('sl_public_state'); const t1 = Date.now();
    S.offset = Date.parse(p.server_now) - (t0 + t1) / 2; LS.set('sl_offset', S.offset);
    const logoChanged = !S.pub || S.pub.logo_version !== p.logo_version;
    S.pub = p; LS.set('sl_pub', p); S.online = true;
    applyPub(); if (logoChanged) loadLogo();
    if (S.view === 'main') renderMain();
  } catch (e) { if (e.network) { S.online = false; renderSync(); } }
}
function schedulePublic() {
  clearTimeout(S.pubTimer);
  S.pubTimer = setTimeout(async () => { if (document.visibilityState === 'visible') await refreshPublic(); schedulePublic(); }, Math.max(10, S.cfg.speed.public_refresh_seconds) * 1000);
}
function scheduleSync() {
  clearTimeout(S.syncTimer);
  S.syncTimer = setTimeout(async () => { await flushAll(); scheduleSync(); }, Math.max(5, S.cfg.speed.batch_seconds) * 1000);
}

function route() {
  const a = activeAcc();
  if (a && !a.needLogin) { showMain(); refreshMe(); }
  else loginView(a ? displayPhone(a.phone) : '');
  flushAll();
}

// كل ثانية: العد التنازلي وتغير الحالة واليوم
function tick() {
  const st = computeStatus(S.cfg, S.pub && S.pub.state, nowS());
  if (st !== S.status) { S.status = st; if (S.view === 'main') renderMain(); }
  if (S.view === 'main') {
    const cd = $('#countdown');
    if (cd && S.cfg.schedule.start_at) cd.textContent = fmtDuration(Date.parse(S.cfg.schedule.start_at) - nowS());
    const d = curDay();
    if (S.lastDay && d !== S.lastDay) { flushAll(); refreshMe(); renderMain(); }   // تغيّر اليوم: أرسل فوراً
    S.lastDay = d;
  }
}

// ================= شاشات الدخول =================
function loginView(prefill = '') {
  S.view = 'login';
  const app = $('#app');
  app.innerHTML = `
    <div class="card soft"><p style="margin:0">${esc(seasonText(S.cfg, 'welcome'))}</p></div>
    <div class="card">
      <h2>الدخول برقم الجوال</h2>
      <form id="f-phone">
        <label class="field"><span>رقم الجوال</span>
          <input class="input phone" id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="05xxxxxxxx" value="${esc(prefill)}" required></label>
        <div class="err" id="err"></div>
        <button class="btn block" id="go">متابعة</button>
      </form>
    </div>
    ${accounts().length ? `<div class="card"><h3>حسابات على هذا الجهاز</h3><ul class="list">${accounts().map(a => `<li><span>${esc(a.name)}<div class="sub">${esc(a.bus || '')}</div></span><button class="btn sm ghost" data-use="${a.cid}">${a.needLogin ? 'تسجيل الدخول' : 'فتح'}</button></li>`).join('')}</ul></div>` : ''}
    ${rulesCard()}`;
  app.querySelectorAll('[data-use]').forEach(b => b.onclick = () => {
    const a = accounts().find(x => x.cid === b.dataset.use);
    if (a.needLogin) $('#phone').value = displayPhone(a.phone); else { setActive(a.cid); route(); }
  });
  $('#f-phone').onsubmit = async (ev) => {
    ev.preventDefault();
    const ph = normalizePhone($('#phone').value);
    if (!ph) { $('#err').textContent = 'رقم الجوال غير صحيح، اكتبه مثل 05xxxxxxxx'; return; }
    const btn = $('#go'); btn.classList.add('busy'); $('#err').textContent = '';
    try {
      const r = await rpc('sl_lookup', { p_phone: ph });
      if (r.error) { $('#err').textContent = errMsg(r.error); return; }
      if (r.found) confirmView(r);
      else if (r.self_register) registerView(ph);
      else $('#err').textContent = 'رقمك غير مسجل، تواصل مع المشرف.';
    } catch (e) { $('#err').textContent = errMsg(e); } finally { btn.classList.remove('busy'); }
  };
}

function pinField(r) {
  if (!r.pin_enabled) return '';
  return `<label class="field"><span>${r.pin_set ? 'رمزك السري (4 أرقام)' : 'أنشئ رمزاً سرياً من 4 أرقام تتذكره'}</span>
    <input class="input phone" id="pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="off" required></label>`;
}
const rememberField = () => `<label class="check"><input type="checkbox" id="remember" checked> تذكرني على هذا الجهاز طوال الرحلة</label>`;

function confirmView(r) {
  $('#app').innerHTML = `
    <div class="card">
      <h2>هل هذه بياناتك؟</h2>
      <ul class="list"><li><span class="muted">الاسم</span><b>${esc(r.name)}</b></li><li><span class="muted">الباص</span><b>${esc(r.bus_name || '—')}</b></li><li><span class="muted">الجوال</span><b dir="ltr">${esc(displayPhone(r.phone))}</b></li></ul>
      <form id="f-login" class="stack" style="margin-top:12px">
        ${pinField(r)}${rememberField()}
        <div class="err" id="err"></div>
        <button class="btn block" id="go">نعم، متابعة</button>
        <button type="button" class="btn block ghost" id="back">ليست بياناتي</button>
      </form>
    </div>`;
  $('#back').onclick = () => loginView();
  $('#f-login').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#go'); btn.classList.add('busy'); $('#err').textContent = '';
    try {
      const res = await rpc('sl_login', { p_phone: r.phone, p_pin: $('#pin') ? $('#pin').value : null, p_remember: $('#remember').checked, p_ua: navigator.userAgent.slice(0, 150) });
      if (res.error) { $('#err').textContent = res.error === 'pin_setup' ? ERR_PIN_SETUP : errMsg(res.error); return; }
      onLoggedIn(res, r.phone, $('#remember').checked);
    } catch (e) { $('#err').textContent = errMsg(e); } finally { btn.classList.remove('busy'); }
  };
}
const ERR_PIN_SETUP = 'أنشئ رمزاً سرياً من 4 أرقام.';

function registerView(ph) {
  const buses = (S.pub && S.pub.buses) || [];
  const pinOn = S.cfg.login.pin_enabled;
  $('#app').innerHTML = `
    <div class="card">
      <h2>تسجيل جديد</h2>
      <p class="muted small" style="margin-top:-4px">رقمك غير مسجل بعد. أكمل بياناتك للانضمام إلى المسابقة.</p>
      <form id="f-reg">
        <label class="field"><span>الاسم</span><input class="input" id="name" required maxlength="80" autocomplete="name"></label>
        <label class="field"><span>رقم الجوال</span><input class="input phone" id="rphone" value="${esc(displayPhone(ph))}" inputmode="tel" required></label>
        <div class="field"><span>الجنس</span><div class="seg">
          <label><input type="radio" name="g" value="m"><span>رجل</span></label>
          <label><input type="radio" name="g" value="f"><span>امرأة</span></label></div></div>
        <label class="field"><span>الباص</span><select class="input" id="bus" required><option value="">اختر الباص</option>${buses.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>
        ${pinOn ? pinField({ pin_enabled: true, pin_set: false }) : ''}${rememberField()}
        <div class="err" id="err"></div>
        <button class="btn block" id="go">تسجيل والدخول</button>
        <button type="button" class="btn block ghost" id="back" style="margin-top:8px">رجوع</button>
      </form>
    </div>`;
  $('#back').onclick = () => loginView(displayPhone(ph));
  $('#f-reg').onsubmit = async (ev) => {
    ev.preventDefault();
    const phone = normalizePhone($('#rphone').value), g = (document.querySelector('input[name=g]:checked') || {}).value;
    if (!phone) return $('#err').textContent = 'رقم الجوال غير صحيح.';
    if (!g) return $('#err').textContent = 'اختر الجنس.';
    const btn = $('#go'); btn.classList.add('busy'); $('#err').textContent = '';
    try {
      const res = await rpc('sl_register', { p_name: $('#name').value.trim(), p_phone: phone, p_gender: g, p_bus_id: Number($('#bus').value), p_pin: $('#pin') ? $('#pin').value : null, p_remember: $('#remember').checked, p_ua: navigator.userAgent.slice(0, 150) });
      if (res.error) { $('#err').textContent = errMsg(res.error); return; }
      onLoggedIn(res, phone, $('#remember').checked);
    } catch (e) { $('#err').textContent = errMsg(e); } finally { btn.classList.remove('busy'); }
  };
}

function onLoggedIn(res, phone, remember) {
  const me = res.me;
  saveAccount({ cid: me.id, token: res.token, name: me.name, bus: me.bus_name, phone, remember });
  const q = Q(me.id); q.token = res.token; saveQ(me.id);   // الضغطات المحفوظة سابقاً تُرسل بالرمز الجديد
  setActive(me.id);
  S.me = me; LS.set('sl_me_' + me.id, me);
  toast('أهلاً ' + me.name.split(' ')[0] + ' 🌿', 'ok');
  showMain(); flushAll();
}

// ================= الشاشة الرئيسية =================
function showMain() {
  S.view = 'main';
  S.me = LS.get('sl_me_' + activeCid()) || S.me;
  S.lastDay = curDay();
  S.viewSig = '';
  renderMain();
}

async function refreshMe() {
  const a = activeAcc(); if (!a) return;
  try {
    const me = await rpc('sl_me', { p_token: Q(a.cid).token || a.token });
    S.me = me; LS.set('sl_me_' + a.cid, me);
    if (S.view === 'main') renderMain();
  } catch (e) { handleAuthError(e, a.cid); }
}

function handleAuthError(e, cid) {
  if (String(e && (e.code || e.message)).includes('bad_session')) {
    const a = accounts().find(x => x.cid === cid);
    if (a) { a.needLogin = true; saveAccount(a); }
    if (cid === activeCid()) { toast('انتهت الجلسة. سجّل الدخول للمتابعة — ضغطاتك محفوظة.', 'error'); loginView(a ? displayPhone(a.phone) : ''); }
  }
}

function renderMain() {
  const a = activeAcc(); if (!a) return loginView();
  const cfg = S.cfg, me = S.me || { name: a.name, bus_name: a.bus };
  // نعيد بناء الشاشة فقط إذا تغيرت الإعدادات أو الحالة، وإلا نحدّث الأرقام
  const sig = JSON.stringify([S.status, cfg, S.pub && S.pub.results, me.status, (me.days || []).length, (me.manual || []).map(m => m.status + m.count), S.prefs, curDay(), S.pub && S.pub.cache && S.pub.cache.buses]);
  if (sig !== S.viewSig) { S.viewSig = sig; buildMain(a, me); }
  updateNumbers();
}

function statusBanner() {
  const s = S.status;
  if (s === 'scheduled') return `<div class="banner wait">تبدأ المسابقة بعد<span class="count num" id="countdown">--:--:--</span></div>`;
  if (s === 'draft') return `<div class="banner wait">المسابقة لم تبدأ بعد، ترقّبوا الإعلان.</div>`;
  if (s === 'paused') return `<div class="banner wait">المسابقة متوقفة مؤقتاً، وضغطاتك المحفوظة ستُرسل تلقائياً.</div>`;
  if (s === 'ended') return `<div class="banner end">انتهت المسابقة، تقبّل الله منكم. ترقّبوا إعلان النتائج.</div>`;
  if (s === 'published') return `<div class="banner end">انتهت المسابقة وأُعلنت النتائج 🎉</div>`;
  return '';
}

function buildMain(a, me) {
  const cfg = S.cfg, d = cfg.display, running = S.status === 'running', inactive = me.status && me.status !== 'active';
  const dhikr = esc(cfg.season.dhikr);
  $('#app').innerHTML = `
    <div class="hello"><span>أهلاً <b>${esc(me.name)}</b> <span class="muted small">${esc(me.bus_name || '')}</span></span>
      <span class="status-chip ${S.status}">${STATUS_LABELS[S.status]}</span></div>
    ${statusBanner()}
    ${S.status === 'published' ? resultsCard() : ''}
    ${d.announcement ? `<div class="card gold announce"><span class="ic">📣</span><div class="pre">${esc(d.announcement)}</div></div>` : ''}
    ${inactive ? `<div class="banner end">${me.status === 'withdrawn' ? 'تم تسجيلك منسحباً من المسابقة.' : 'حسابك خارج المسابقة.'} تواصل مع المشرف.</div>` : ''}
    <div class="card counter">
      <div class="lbl">صلواتي</div>
      <div class="big num" id="n-total">0</div>
      <div class="mini-stats">
        <div><b class="num" id="n-today">0</b><span>اليوم</span></div>
        <div><b class="num" id="n-all">0</b><span>مجموع صلوات كل المتسابقين</span></div>
      </div>
      ${d.campaign_goal > 0 ? `<div class="goal"><div class="row between"><span>هدف الحملة</span><span class="num" id="n-goal"></span></div><div class="progress"><i id="p-goal"></i></div></div>` : ''}
      <div class="press-zone">
        <button class="press" id="press" ${running && !inactive ? '' : 'disabled'} aria-label="${dhikr}"><span class="dhikr">${dhikr}</span></button>
      </div>
      <div class="hint" id="hint"></div>
      <div class="sync" id="sync"></div>
      <div class="toggles">
        <button class="chip-toggle ${S.prefs.anywhere ? 'on' : ''}" data-pref="anywhere">👆 اضغط في أي مكان</button>
        <button class="chip-toggle ${S.wakeWanted ? 'on' : ''}" id="wake">☀️ إبقاء الشاشة مضاءة</button>
        <button class="chip-toggle ${S.prefs.vibrate ? 'on' : ''}" data-pref="vibrate">📳 اهتزاز</button>
        <button class="chip-toggle ${S.prefs.sound ? 'on' : ''}" data-pref="sound">🔔 صوت</button>
      </div>
      <div class="small muted" id="rejnote" style="margin-top:8px"></div>
    </div>
    ${d.show_shares && cfg.draw.shares_enabled ? `<div class="card"><h3>أسهمي في السحب</h3>
      <div class="row between"><span class="muted">عدد أسهمي</span><b class="num" style="font-size:1.6rem;color:var(--deep)" id="n-shares">0</b></div>
      <div class="progress" style="margin-top:8px"><i id="p-share"></i></div>
      <div class="small muted" id="n-next" style="margin-top:6px"></div></div>` : ''}
    ${cfg.manual.enabled ? manualCard(me) : ''}
    ${d.show_bus_ranking ? busCard(me) : ''}
    ${d.show_gender ? genderCard() : ''}
    ${historyCard()}
    ${rulesCard()}
    <div class="row" style="justify-content:center;margin-top:8px">
      <button class="btn ghost sm" id="switch">تبديل الحساب</button>
    </div>`;

  // الزر الكبير: pointerdown للاستجابة الفورية
  const btn = $('#press');
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(btn, e); });
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(btn); } });
  document.querySelectorAll('[data-pref]').forEach(b => b.onclick = () => {
    const k = b.dataset.pref; S.prefs[k] = !S.prefs[k]; LS.set('sl_prefs', S.prefs);
    b.classList.toggle('on', S.prefs[k]);
    if (k === 'anywhere' && S.prefs.anywhere) openFocus();
  });
  $('#wake').onclick = toggleWake;
  $('#switch').onclick = switchSheet;
  const mf = $('#f-manual'); if (mf) mf.onsubmit = submitManual;
  if (S.prefs.anywhere && running && !inactive && !$('#focus')) openFocus();
  renderSync();
}

function myNumbers() {
  const cfg = S.cfg, me = S.me || {}, u = unsent(activeCid());
  const base = { app_total: me.app_total || 0, adj_total: me.adj_total || 0, manual_total: me.manual_total || 0 };
  const t = me.today_key === curDay() ? (me.today || {}) : {};
  const inc = cfg.manual.include_in_totals;
  return {
    total: contestantTotal(base, cfg) + u,
    today: (t.app || 0) + (t.adj || 0) + (inc ? (t.man || 0) : 0) + u,
    drawTotal: contestantTotal(base, cfg, true) + u,
    all: ((S.pub && S.pub.cache && S.pub.cache.total) || 0) + u
  };
}

function updateNumbers() {
  if (S.view !== 'main') return;
  const n = myNumbers(), cfg = S.cfg, set = (id, v) => { const el = $('#' + id); if (el) el.textContent = v; };
  set('n-total', fmt(n.total)); set('n-today', fmt(n.today)); set('n-all', fmt(n.all));
  set('f-total', fmt(n.total)); set('f-today', fmt(n.today));
  if (cfg.display.campaign_goal > 0) {
    set('n-goal', `${fmt(n.all)} / ${fmt(cfg.display.campaign_goal)}`);
    const p = $('#p-goal'); if (p) p.style.width = pct(n.all, cfg.display.campaign_goal) + '%';
  }
  if ($('#n-shares')) {
    const sv = Math.max(1, cfg.draw.share_value), sh = sharesFor(n.drawTotal, cfg), capped = cfg.draw.max_shares > 0 && sh >= cfg.draw.max_shares;
    set('n-shares', fmt(sh));
    $('#p-share').style.width = (capped ? 100 : pct(n.drawTotal % sv, sv)) + '%';
    set('n-next', capped ? 'وصلت إلى الحد الأقصى من الأسهم 🌟' : `بقي ${fmt(sv - (n.drawTotal % sv))} صلاة للسهم التالي (كل ${fmt(sv)} صلاة = سهم)`);
  }
  const td = $('#h-today'); if (td) td.textContent = fmt(n.today);
}

function renderSync() {
  const q = Q(), u = unsent(activeCid());
  let cls, txt;
  if (!S.online) { cls = 'off'; txt = u ? `⚠ لا يوجد اتصال، ${presses(u)} محفوظة على جهازك` : '⚠ لا يوجد اتصال، ضغطاتك محفوظة'; }
  else if (u > 0) { cls = 'wait'; txt = `⏳ ${presses(u)} بانتظار الإرسال`; }
  else { cls = 'ok'; txt = '✓ تمت المزامنة'; }
  document.querySelectorAll('.sync').forEach(el => { el.className = 'sync ' + cls; el.textContent = txt; });
  const rn = $('#rejnote');
  if (rn) rn.textContent = q.lastRej ? `لم تُحتسب ${presses(q.lastRej)} في آخر مزامنة لأنها أسرع من المسموح.` : '';
}

// ---------- الضغط ----------
function onPress(btn, e) {
  if (S.status !== 'running') return;
  const cfg = S.cfg, t = performance.now(), gap = t - S.lastPress;
  const hint = $('#hint');
  if (gap < cfg.speed.min_interval_ms) {             // أسرع من الفاصل الأدنى: تُهمل
    if (++S.ignored >= 3 && hint) { hint.textContent = `على مهلك 🌿 تُحتسب صلاة كل ${(cfg.speed.min_interval_ms / 1000).toFixed(2)} ثانية`; clearTimeout(S.hintT); S.hintT = setTimeout(() => hint.textContent = '', 2600); }
    return;
  }
  if (cfg.speed.daily_cap_enabled && myNumbers().today >= cfg.speed.daily_cap) {
    if (hint) hint.textContent = 'بلغت الحد اليومي، بارك الله فيك. واصل غداً بإذن الله.'; return;
  }
  S.ignored = 0;
  const q = Q(), cid = activeCid();
  if (S.lastPress > 0 && gap < 60000) {               // إحصاء الفواصل (تحليلي فقط)
    q.st.n++; q.st.sum += gap; q.st.sq += gap * gap; q.st.min = q.st.min == null ? gap : Math.min(q.st.min, gap);
  }
  S.lastPress = t;
  q.pending++; saveQ(cid);
  updateNumbers(); renderSync();
  feedback(btn);
}

function feedback(btn) {
  if (S.prefs.vibrate && navigator.vibrate) navigator.vibrate(12);
  if (S.prefs.sound) beep();
  if (btn) {
    btn.classList.add('down'); setTimeout(() => btn.classList.remove('down'), 110);
    const zone = btn.parentElement, r = document.createElement('span');
    r.className = 'ripple'; const rc = btn.getBoundingClientRect(), zc = zone.getBoundingClientRect();
    Object.assign(r.style, { width: rc.width + 'px', height: rc.height + 'px', left: (rc.left - zc.left) + 'px', top: (rc.top - zc.top) + 'px' });
    zone.appendChild(r); setTimeout(() => r.remove(), 700);
    const p = document.createElement('span'); p.className = 'plus'; p.textContent = '+1'; zone.appendChild(p); setTimeout(() => p.remove(), 800);
  }
}
let actx;
function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 620; g.gain.value = 0.035; o.connect(g); g.connect(actx.destination);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.09); o.start(); o.stop(actx.currentTime + 0.1);
  } catch { }
}

// وضع "اضغط في أي مكان" (شاشة كاملة للكبار)
function openFocus() {
  if ($('#focus')) return;
  const el = document.createElement('div');
  el.className = 'focus-mode'; el.id = 'focus';
  el.innerHTML = `<button class="btn sm exit" id="f-exit">✕ خروج</button>
    <div class="tapnote">صلواتي</div><div class="big num" id="f-total">0</div>
    <div class="tapnote">اليوم: <span class="num" id="f-today">0</span></div>
    <div class="dhikr">${esc(S.cfg.season.dhikr)}</div>
    <div class="tapnote">اضغط في أي مكان من الشاشة</div>
    <div class="hint" id="f-hint" style="color:#ffe3a3"></div>
    <div class="sync" id="f-sync"></div>`;
  document.body.appendChild(el);
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#f-exit')) return;
    e.preventDefault();
    const before = Q().pending;
    onPress(null, e);
    if (Q().pending > before) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 120); }
    else if (S.ignored >= 3) { const h = $('#f-hint'); h.textContent = 'على مهلك 🌿'; clearTimeout(S.fh); S.fh = setTimeout(() => h.textContent = '', 1800); }
  });
  $('#f-exit').onclick = () => { el.remove(); S.prefs.anywhere = false; LS.set('sl_prefs', S.prefs); const b = document.querySelector('[data-pref=anywhere]'); if (b) b.classList.remove('on'); };
  updateNumbers(); renderSync();
}

// ---------- منع انطفاء الشاشة ----------
async function requestWake() {
  try { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); }
  catch { }
}
async function toggleWake() {
  if (!('wakeLock' in navigator)) { toast('جهازك لا يدعم منع انطفاء الشاشة. يمكنك إطالة مدة القفل من إعدادات الجوال.'); return; }
  S.wakeWanted = !S.wakeWanted;
  if (S.wakeWanted) { await requestWake(); toast(S.wake ? 'ستبقى الشاشة مضاءة أثناء فتح الصفحة' : 'تعذر تفعيل الخاصية الآن'); }
  else if (S.wake) { S.wake.release(); S.wake = null; }
  $('#wake').classList.toggle('on', S.wakeWanted);
}

// ---------- الإرسال على دفعات ----------
const flushing = {};
async function flushAll(opts = {}) {
  // كل الطوابير المحفوظة على الجهاز (حتى لحسابات أخرى)
  const cids = new Set(accounts().map(a => a.cid));
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('sl_q_')) cids.add(k.slice(5)); } } catch { }
  for (const cid of cids) await flushQueue(cid, opts);
  renderSync();
}
async function flushQueue(cid, { keepalive = false } = {}) {
  if (flushing[cid] && !keepalive) return;
  const q = Q(cid);
  if (!q.token) { const a = accounts().find(x => x.cid === cid); if (a) q.token = a.token; }
  if (!q.token || (!q.pending && !q.inflight)) return;
  flushing[cid] = true;
  try {
    for (let guard = 0; guard < 50; guard++) {
      if (!q.inflight) {
        if (q.pending <= 0) break;
        const n = Math.min(q.pending, Math.max(1, S.cfg.speed.max_batch));
        const st = q.st;
        const avg = st.n ? st.sum / st.n : null, sd = st.n > 1 ? Math.sqrt(Math.max(0, st.sq / st.n - avg * avg)) : null;
        q.inflight = { id: uuid(), count: n, stats: { n: st.n, min: st.min == null ? null : Math.round(st.min), avg: avg == null ? null : Math.round(avg), sd: sd == null ? null : Math.round(sd * 10) / 10 } };
        q.pending -= n; q.st = { n: 0, min: null, sum: 0, sq: 0 };
        saveQ(cid);
      }
      const sent = q.inflight;
      const res = await rpc('sl_submit_batch', { p_token: q.token, p_batch_id: sent.id, p_count: sent.count, p_stats: sent.stats }, { keepalive });
      if (q.inflight && q.inflight.id === sent.id) q.inflight = null;   // لا نمسح دفعة أحدث
      q.lastRej = res.reason === 'speed' ? res.rejected : 0; saveQ(cid);
      if (res.me) {
        const old = LS.get('sl_me_' + cid) || {};
        const me = { ...old, ...res.me }; LS.set('sl_me_' + cid, me);
        if (cid === activeCid()) S.me = me;
      }
      if (res.reason === 'closed' && res.rejected) q.lastRej = 0;
      S.online = true;
      if (keepalive) break;
    }
    // حذف طابور حساب غير موجود على الجهاز بعد إفراغه
    if (!q.pending && !q.inflight && !accounts().find(a => a.cid === cid)) { LS.del('sl_q_' + cid); delete queues[cid]; }
  } catch (e) {
    if (e.network) S.online = false; else handleAuthError(e, cid);
  } finally {
    flushing[cid] = false;
    if (cid === activeCid()) { updateNumbers(); renderSync(); }
  }
}

// ---------- البطاقات ----------
function manualCard(me) {
  const m = S.cfg.manual;
  const items = (me.manual || []).slice(0, 6);
  const lbl = { pending: 'بانتظار الاعتماد', approved: 'معتمدة', rejected: 'مرفوضة', reverted: 'ملغاة' };
  return `<details class="card"><summary>أضف ما أنجزته خارج التطبيق</summary>
    <form id="f-manual" style="margin-top:12px">
      <label class="field"><span>العدد (حتى ${fmt(m.max_per_entry)} في المرة، و${fmt(m.max_per_day)} في اليوم)</span>
        <input class="input num" id="m-count" type="number" inputmode="numeric" min="1" max="${m.max_per_entry}" required></label>
      <button class="btn block gold" id="m-go">أضف</button>
      <p class="small muted">${m.require_approval ? 'تُحتسب بعد اعتماد المشرف.' : 'تُحتسب مباشرة.'} تُعرض منفصلة عن ضغطات التطبيق.</p>
    </form>
    ${items.length ? `<ul class="list">${items.map(x => `<li><span class="num">${fmt(x.count)}</span><span class="sub">${lbl[x.status] || x.status}</span></li>`).join('')}</ul>` : ''}
  </details>`;
}
async function submitManual(ev) {
  ev.preventDefault();
  const n = Math.floor(Number($('#m-count').value));
  if (!(n >= 1)) return toast('اكتب عدداً صحيحاً', 'error');
  if (!confirm(`تأكيد إضافة ${fmt(n)} صلاة أنجزتها خارج التطبيق؟`)) return;
  const btn = $('#m-go'); btn.classList.add('busy');
  try {
    const r = await rpc('sl_add_manual', { p_token: Q().token || activeAcc().token, p_count: n });
    if (r.error) return toast(errMsg(r.error), 'error');
    S.me = r.me; LS.set('sl_me_' + activeCid(), r.me);
    toast(r.pending ? 'أُرسلت الإضافة وهي بانتظار اعتماد المشرف' : 'أُضيفت إلى رصيدك', 'ok');
    renderMain();
  } catch (e) { toast(e.network ? 'الإضافة تحتاج اتصالاً بالإنترنت' : errMsg(e), 'error'); }
  finally { btn.classList.remove('busy'); }
}

function busCard(me) {
  const buses = (S.pub && S.pub.cache && S.pub.cache.buses) || [];
  if (!buses.length) return '';
  const max = Math.max(1, ...buses.map(b => b.total));
  return `<div class="card"><h3>ترتيب الباصات</h3>${buses.map((b, i) => `
    <div class="bar-row"><span>${i + 1}. ${esc(b.name)} ${b.id === me.bus_id ? '<span class="status-chip">باصك</span>' : ''}</span><b class="num">${fmt(b.total)}</b>
    <div class="progress"><i style="width:${pct(b.total, max)}%"></i></div>
    <span class="small muted">${fmt(b.members)} مشارك · المتوسط ${fmt(b.avg)}</span></div>`).join('')}</div>`;
}
function genderCard() {
  const g = (S.pub && S.pub.cache && S.pub.cache.gender) || {};
  const m = g.m || { total: 0, members: 0, avg: 0 }, f = g.f || { total: 0, members: 0, avg: 0 };
  const lead = (a, b) => a > b ? 'الرجال' : b > a ? 'النساء' : 'متعادلون';
  return `<div class="card"><h3>الرجال والنساء</h3>
    <div class="mini-stats"><div><b class="num">${fmt(m.total)}</b><span>الرجال (${fmt(m.members)}) · متوسط ${fmt(m.avg)}</span></div>
    <div><b class="num">${fmt(f.total)}</b><span>النساء (${fmt(f.members)}) · متوسط ${fmt(f.avg)}</span></div></div>
    <p class="small muted center" style="margin:10px 0 0">المتصدر بالمجموع: <b>${lead(m.total, f.total)}</b> · بالمتوسط: <b>${lead(m.avg, f.avg)}</b></p></div>`;
}
function historyCard() {
  const days = competitionDays(S.cfg, nowS());
  if (!days.length) return '';
  const me = S.me || {}, map = {}, inc = S.cfg.manual.include_in_totals, today = curDay();
  for (const d of me.days || []) map[d.d] = d.app + d.adj + (inc ? d.man : 0);
  return `<details class="card" ${days.some(d => d.key === today) ? 'open' : ''}><summary>سجلي اليومي</summary><ul class="list" style="margin-top:8px">${days.map(d => {
    const L = dayLabel(d.key), isT = d.key === today, future = d.key > today;
    return `<li class="${isT ? 'today' : ''}"><span><b>${dayName(d.no)}</b><div class="sub">${L.weekday} ${L.greg} · ${L.hijri}</div></span>
      <b class="num" ${isT ? 'id="h-today"' : ''}>${future ? '—' : fmt(map[d.key] || 0)}</b></li>`;
  }).join('')}</ul></details>`;
}
function rulesCard() {
  const t = S.cfg && S.cfg.display.rules_text;
  return t ? `<details class="card"><summary>شروط المسابقة والسحب</summary><div class="pre small" style="margin-top:10px">${esc(t)}</div></details>` : '';
}
function resultsCard() {
  const r = S.pub && S.pub.results; if (!r) return '';
  const titles = { overall: 'الأكثر ذكراً', m: 'الأكثر ذكراً من الرجال', f: 'الأكثر ذكراً من النساء' };
  const lists = Object.entries(r.top || {}).filter(([, l]) => l.length).map(([k, l]) => `<h3>${titles[k] || k}</h3><ul class="list winners-list">${l.map(e => `<li><span class="medal">${e.rank}</span><span>${esc(e.name)}<div class="sub">${esc(e.bus || '')}</div></span></li>`).join('')}</ul>`).join('');
  const rounds = (r.rounds || []).map(x => `<h3>🎁 ${esc(x.name)}</h3><ul class="list winners-list">${x.winners.map((w, i) => `<li><span class="medal">${i + 1}</span><span>${esc(w.name)}<div class="sub">${esc(w.bus || '')}</div></span></li>`).join('')}</ul>`).join('');
  return `<div class="card gold"><h2>🏆 النتائج</h2>${lists}${rounds}</div>`;
}

// تبديل الحساب
function switchSheet() {
  const bg = document.createElement('div'); bg.className = 'sheet-bg';
  const cur = activeCid();
  bg.innerHTML = `<div class="sheet"><h3>الحسابات على هذا الجهاز</h3>
    <ul class="list">${accounts().map(a => `<li><span>${esc(a.name)}<div class="sub">${esc(a.bus || '')}${unsent(a.cid) ? ' · ' + presses(unsent(a.cid)) + ' بانتظار الإرسال' : ''}</div></span>
      ${a.cid === cur ? '<span class="status-chip">الحالي</span>' : `<button class="btn sm" data-sw="${a.cid}">فتح</button>`}</li>`).join('')}</ul>
    <div class="stack" style="margin-top:14px">
      <button class="btn block" id="add-acc">دخول بحساب آخر (لأحد أفراد الأسرة)</button>
      <button class="btn block ghost" id="logout">تسجيل خروج هذا الحساب من الجهاز</button>
      <button class="btn block ghost" id="close">إغلاق</button>
    </div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.onclick = (e) => { if (e.target === bg) close(); };
  $('#close', bg).onclick = close;
  bg.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => { close(); flushAll(); setActive(b.dataset.sw); S.me = null; route(); });
  $('#add-acc', bg).onclick = () => { close(); flushAll(); SS.set('sl_active', null); LS.set('sl_active', null); loginView(); };
  $('#logout', bg).onclick = async () => {
    const u = unsent(cur);
    if (u && !confirm(`لديك ${presses(u)} لم تُرسل بعد. ستبقى محفوظة وتُرسل تلقائياً عند الاتصال. متابعة الخروج؟`)) return;
    close();
    await flushQueue(cur);
    const a = activeAcc();
    if (!unsent(cur)) { try { await rpc('sl_logout', { p_token: a.token }); } catch { } }
    removeAccount(cur); LS.del('sl_me_' + cur);
    SS.set('sl_active', null); LS.set('sl_active', null);
    const next = accounts()[0]; if (next) setActive(next.cid);
    S.me = null; route();
  };
}
