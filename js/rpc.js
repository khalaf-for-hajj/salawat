// ===== طبقة الاتصال: Supabase (REST خفيف بلا مكتبات) أو الخادم المحلي التجريبي =====
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

export const DEMO = !SUPABASE_URL || !SUPABASE_ANON_KEY;
let local = null;

// المفتاح الجديد (sb_publishable_...) يُرسل في apikey فقط، والقديم (anon JWT) يقبل الاثنين
function authHeaders(jwt) {
  const h = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (jwt) h.Authorization = `Bearer ${jwt}`;
  else if (SUPABASE_ANON_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return h;
}

// استدعاء دالة: rpc('sl_me', { p_token })
// opts.keepalive: يكمل الطلب حتى بعد إغلاق الصفحة / opts.jwt: رمز المشرف
export async function rpc(name, params = {}, opts = {}) {
  if (DEMO) {
    local = local || await import('./local-server.js');
    return local.localRpc(name, params);
  }
  let res;
  try {
    const ctrl = !opts.keepalive && typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeout || 20000) : null;
    res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: authHeaders(opts.jwt),
      body: JSON.stringify(params),
      keepalive: !!opts.keepalive,
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
  } catch (e) {
    const err = new Error('network'); err.network = true; err.code = 'network'; throw err;
  }
  let body = null;
  try { body = await res.json(); } catch { }
  if (!res.ok) {
    const err = new Error((body && body.message) || res.statusText || 'error');
    err.code = (body && body.message) || String(res.status); err.status = res.status;
    if (res.status >= 500 && res.status !== 500) err.network = true;
    throw err;
  }
  return body;
}
