// ===== أدوات مشتركة بين واجهة المتسابق ولوحة المشرف =====

// الإعدادات الافتراضية (نفسها في schema.sql) — كل شيء قابل للتعديل من لوحة المشرف
export const DEFAULT_CONFIG = {
  identity: { campaign_name: 'حملة الخلف', primary_color: '#3d8f82', gold_color: '#c9a24b' },
  season: { type: 'hajj', contest_name: 'مسابقة الصلاة على محمد وآل محمد', page_title: '', welcome: '', dhikr: 'اللهم صل على محمد وآل محمد' },
  schedule: { start_at: null, end_at: null, day_start_hour: 0 },
  login: { self_register: true, pin_enabled: false, remember_days: 30 },
  speed: { min_interval_ms: 1500, daily_cap_enabled: false, daily_cap: 30000, max_batch: 2000, max_offline_hours: 6, grace_minutes: 60, batch_seconds: 20, public_refresh_seconds: 30 },
  review: { reject_ratio_enabled: true, reject_ratio_pct: 25, reject_min_sample: 100, daily_rate_enabled: false, daily_rate: 20000, robotic_enabled: true, robotic_min_presses: 200, robotic_stdev_ms: 15 },
  manual: { enabled: false, max_per_entry: 1000, max_per_day: 5000, require_approval: true, include_in_totals: true },
  display: { show_bus_ranking: false, show_gender: false, show_shares: false, campaign_goal: 0, announcement: '', rules_text: '', withdrawn_in_total: true },
  results: { top_n: 10, scope: 'both' },
  draw: {
    shares_enabled: true, share_value: 5000, max_shares: 0,
    min_total: { on: false, value: 5000 },
    active_days: { on: false, days: 2, day_min: 100 },
    exclude_flagged: true, exclude_inactive: true, exclude_prev_winners: true,
    exclude_top: { on: false }, include_manual: true, custom: []
  }
};

export const DEFAULT_STATE = { mode: 'auto', paused: false, paused_at: null, published: false, published_at: null, frozen_at: null };

export const SEASON_TEXTS = {
  umrah: { page_title: 'مسابقة الصلاة على محمد وآل محمد — رحلة العمرة', welcome: 'أهلاً بكم يا ضيوف الرحمن في رحلة العمرة. اجعلوا ألسنتكم رطبة بالصلاة على محمد وآل محمد، وكل صلاة تُحسب لكم ولحملتكم.' },
  hajj: { page_title: 'مسابقة الصلاة على محمد وآل محمد — رحلة الحج', welcome: 'أهلاً بكم يا حجاج بيت الله الحرام. في المشاعر والطريق، أكثروا من الصلاة على محمد وآل محمد، وكل صلاة تُحسب لكم ولحملتكم.' },
  custom: { page_title: 'مسابقة الصلاة على محمد وآل محمد', welcome: 'أهلاً بكم. أكثروا من الصلاة على محمد وآل محمد.' }
};

export const STATUS_LABELS = { draft: 'مسودة', scheduled: 'مجدولة', running: 'جارية', paused: 'متوقفة مؤقتاً', ended: 'منتهية', published: 'النتائج منشورة' };

// دمج عميق: القيم المخزنة فوق الافتراضية
export function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? clone(base) : clone(over);
  if (typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over || {})])) {
    const b = base[k], o = over ? over[k] : undefined;
    out[k] = (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o)) ? deepMerge(b, o) : (o === undefined ? clone(b) : clone(o));
  }
  return out;
}
export const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
export const fullConfig = (c) => deepMerge(DEFAULT_CONFIG, c || {});

// النص الفعلي: قيمة المشرف وإلا الافتراضي للموسم
export function seasonText(cfg, key) {
  const v = (cfg.season[key] || '').trim();
  return v || (SEASON_TEXTS[cfg.season.type] || SEASON_TEXTS.custom)[key];
}

// ===== الأرقام =====
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export function toLatinDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d)).replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d));
}

// تطبيع رقم الجوال إلى صيغة موحدة: 9665xxxxxxxx للسعودي، وأرقام دولية بدون + أو 00
export function normalizePhone(raw) {
  let s = toLatinDigits(raw).trim();
  const plus = s.startsWith('+');
  s = s.replace(/\D/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = s.slice(2);
  else if (!plus) {
    if (/^05\d{8}$/.test(s)) s = '966' + s.slice(1);
    else if (/^5\d{8}$/.test(s)) s = '966' + s;
  }
  if (s.startsWith('9660')) s = '966' + s.slice(4);
  if (s.startsWith('966')) return /^9665\d{8}$/.test(s) ? s : null;
  return /^\d{8,15}$/.test(s) ? s : null;
}
export function displayPhone(p) {
  if (!p) return '';
  return /^9665\d{8}$/.test(p) ? '0' + p.slice(3) : '+' + p;
}

export const fmt = (n) => Number(n || 0).toLocaleString('en-US');
export const pct = (a, b) => b > 0 ? Math.min(100, (a / b) * 100) : 0;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===== الوقت: الرياض UTC+3 ثابت بلا توقيت صيفي =====
export const RIYADH_MS = 3 * 3600 * 1000;
export const DAY_MS = 86400000;

// تاريخ "يوم المسابقة" (YYYY-MM-DD) لوقت معين مع ساعة بداية اليوم
export function dayKey(ms, startHour = 0) {
  return new Date(ms + RIYADH_MS - startHour * 3600000).toISOString().slice(0, 10);
}
export const keyToMs = (k) => Date.parse(k + 'T00:00:00Z');
export function dayNumber(cfg, key) {
  if (!cfg.schedule.start_at) return null;
  const s = dayKey(Date.parse(cfg.schedule.start_at), cfg.schedule.day_start_hour);
  return Math.round((keyToMs(key) - keyToMs(s)) / DAY_MS) + 1;
}
// قائمة أيام المسابقة [{no, key}]
export function competitionDays(cfg, nowMs = Date.now()) {
  const { start_at, end_at, day_start_hour } = cfg.schedule;
  if (!start_at) return [];
  const s = dayKey(Date.parse(start_at), day_start_hour);
  const endMs = end_at ? Date.parse(end_at) - 1 : nowMs;
  const e = dayKey(Math.max(Date.parse(start_at), endMs), day_start_hour);
  const out = [];
  for (let t = keyToMs(s), i = 1; t <= keyToMs(e) && i <= 120; t += DAY_MS, i++) out.push({ no: i, key: new Date(t).toISOString().slice(0, 10) });
  return out;
}
const ORDINALS = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر', 'الثالث عشر', 'الرابع عشر', 'الخامس عشر'];
export const dayName = (no) => no >= 1 && no <= ORDINALS.length ? 'اليوم ' + ORDINALS[no - 1] : 'اليوم ' + no;

const fWeek = new Intl.DateTimeFormat('ar-SA-u-nu-latn', { weekday: 'long', timeZone: 'UTC' });
const fGreg = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long', timeZone: 'UTC' });
let fHijri;
try { fHijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch { fHijri = null; }
export function dayLabel(key) {
  const d = new Date(keyToMs(key));
  return { weekday: fWeek.format(d), greg: fGreg.format(d), hijri: fHijri ? fHijri.format(d) : '' };
}
// وقت بتوقيت الرياض للعرض
const fDT = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const fmtDT = (v) => v ? fDT.format(new Date(v)) : '—';
// تحويل بين حقل datetime-local (بتوقيت الرياض) وISO
export const isoToLocalInput = (iso) => iso ? new Date(Date.parse(iso) + RIYADH_MS).toISOString().slice(0, 16) : '';
export const localInputToIso = (v) => v ? new Date(Date.parse(v + ':00Z') - RIYADH_MS).toISOString() : null;
export function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return (d ? d + ' يوم و ' : '') + `${p(h)}:${p(m)}:${p(x)}`;
}

// ===== حالة المسابقة (نفس منطق sl_status في الخادم) =====
export function computeStatus(cfg, state, nowMs) {
  state = { ...DEFAULT_STATE, ...(state || {}) };
  if (state.published) return 'published';
  if (state.mode === 'draft' || !cfg.schedule.start_at) return 'draft';
  const s = Date.parse(cfg.schedule.start_at), e = cfg.schedule.end_at ? Date.parse(cfg.schedule.end_at) : null;
  if (e && nowMs >= e) return 'ended';
  if (nowMs < s) return 'scheduled';
  if (state.paused) return 'paused';
  return 'running';
}

// ===== الإجماليات والأسهم =====
export function contestantTotal(c, cfg, forDraw = false) {
  const incManual = forDraw ? cfg.draw.include_manual : cfg.manual.include_in_totals;
  return (c.app_total || 0) + (c.adj_total || 0) + (incManual ? (c.manual_total || 0) : 0);
}
export function sharesFor(total, cfg) {
  const d = cfg.draw;
  if (!d.shares_enabled) return total > 0 ? 1 : 0;
  let s = Math.floor(total / Math.max(1, d.share_value));
  if (d.max_shares > 0) s = Math.min(s, d.max_shares);
  return s;
}

// ===== متفرقات =====
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// تطبيق ألوان الهوية
export function applyTheme(cfg) {
  const r = document.documentElement.style;
  if (cfg.identity.primary_color) r.setProperty('--primary', cfg.identity.primary_color);
  if (cfg.identity.gold_color) r.setProperty('--gold', cfg.identity.gold_color);
}

// إشعار صغير أسفل الشاشة
export function toast(msg, type = '') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

// ترجمة أخطاء الخادم إلى رسائل عربية
export const ERRORS = {
  rate_limited: 'محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً.',
  not_found: 'رقمك غير مسجل، تواصل مع المشرف.',
  invalid_phone: 'رقم الجوال غير صحيح.',
  bad_session: 'انتهت الجلسة، سجّل الدخول من جديد.',
  pin_required: 'أدخل الرمز السري.',
  pin_wrong: 'الرمز السري غير صحيح.',
  pin_invalid: 'الرمز السري يجب أن يكون 4 أرقام.',
  registration_closed: 'التسجيل الذاتي مغلق، تواصل مع المشرف.',
  phone_exists: 'هذا الرقم مسجل مسبقاً.',
  name_required: 'الاسم مطلوب.',
  gender_required: 'اختر الجنس.',
  bus_required: 'اختر الباص.',
  inactive: 'حسابك غير نشط في المسابقة، تواصل مع المشرف.',
  manual_disabled: 'الإضافة اليدوية مغلقة حالياً.',
  manual_too_big: 'العدد أكبر من الحد المسموح للإدخال الواحد.',
  manual_daily_limit: 'تجاوزت الحد اليومي للإضافة اليدوية.',
  bad_count: 'العدد غير صحيح.',
  not_running: 'المسابقة ليست جارية الآن.',
  not_admin: 'هذا الحساب ليس مشرفاً على المسابقة.',
  reason_required: 'السبب مطلوب.',
  confirm_mismatch: 'عبارة التأكيد غير مطابقة.',
  draw_no_eligible: 'لا يوجد مؤهلون للسحب.',
  draw_done: 'هذا السحب منفذ ومقفل.',
  no_candidates: 'لا يوجد بديل مؤهل.',
  network: 'تعذر الاتصال بالخادم. تحقق من الإنترنت.'
};
export function errMsg(e) {
  const code = typeof e === 'string' ? e : [e?.error, e?.message, e?.code, e?.details].filter(Boolean).join(' ');
  for (const k of Object.keys(ERRORS)) if (String(code).includes(k)) return ERRORS[k];
  return 'حدث خطأ: ' + (e && e.message ? e.message : code);
}
