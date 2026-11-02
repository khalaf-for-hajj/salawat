-- =====================================================================
--  مسابقة الصلاة على محمد وآل محمد — قاعدة البيانات (Supabase / PostgreSQL)
--  شغّل هذا الملف كاملاً في: Supabase → SQL Editor → New query → Run
--  كل الجداول والدوال تبدأ بـ sl_ حتى لا تتعارض مع أي تطبيق آخر.
--  يمكن تشغيله أكثر من مرة بأمان (لا يحذف بياناتك).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ===================== الجداول =====================

-- المشرفون (البريد المسجّل في Supabase Auth)
create table if not exists sl_admins (email text primary key);

-- ⬇⬇ عدّل هذا السطر ببريد المشرف (نفس البريد الذي تنشئه في Authentication → Users)
insert into sl_admins(email) values ('alkhalafforhajj@gmail.com') on conflict do nothing;

-- الإعدادات: config (كل الإعدادات) / state (حالة المسابقة) / logo (الشعار)
create table if not exists sl_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists sl_buses (
  id bigserial primary key,
  name text not null,
  sort int not null default 0,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  unique (name, is_test)
);

create table if not exists sl_contestants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null unique,                 -- موحّد: 9665xxxxxxxx أو دولي بلا +
  gender char(1) not null check (gender in ('m','f')),
  bus_id bigint references sl_buses(id) on delete set null,
  status text not null default 'active' check (status in ('active','withdrawn','excluded')),
  is_test boolean not null default false,
  joined_at timestamptz not null default now(),
  created_by text not null default 'admin',   -- admin / self / import / sim
  pin_hash text,
  -- مجاميع مخزنة مؤقتاً (تُحسب من سجل الحركات)
  app_total bigint not null default 0,
  manual_total bigint not null default 0,     -- المعتمد فقط
  manual_pending bigint not null default 0,
  adj_total bigint not null default 0,
  rejected_total bigint not null default 0,
  reached_at timestamptz,                     -- وقت آخر زيادة (لحسم التعادل)
  last_active_at timestamptz,
  last_sync_at timestamptz,
  -- رصيد الضغطات المسموحة
  bucket_tokens double precision not null default 0,
  bucket_at timestamptz,
  -- المراجعة
  review_status text not null default 'none' check (review_status in ('none','pending','approved','deducted','excluded')),
  flag_reasons jsonb not null default '[]'::jsonb,
  review_note text,
  stats jsonb not null default '{}'::jsonb
);
create index if not exists sl_contestants_bus on sl_contestants(bus_id);

create table if not exists sl_sessions (
  token_hash text primary key,
  contestant_id uuid not null references sl_contestants(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index if not exists sl_sessions_c on sl_sessions(contestant_id);

-- سجل الحركات (ledger): دفعات الضغط
create table if not exists sl_batches (
  batch_id uuid primary key,
  contestant_id uuid not null references sl_contestants(id) on delete cascade,
  received_at timestamptz not null default now(),
  day_date date not null,
  requested int not null,
  accepted int not null,
  rejected int not null,
  reason text,                                -- ok / speed / closed / daily_cap / batch_cap
  client_stats jsonb
);
create index if not exists sl_batches_c on sl_batches(contestant_id, received_at desc);

-- الإضافات اليدوية (خارج التطبيق)
create table if not exists sl_manual_entries (
  id bigserial primary key,
  contestant_id uuid not null references sl_contestants(id) on delete cascade,
  created_at timestamptz not null default now(),
  day_date date not null,
  count int not null check (count > 0),
  status text not null check (status in ('pending','approved','rejected','reverted')),
  decided_by text, decided_at timestamptz, note text
);
create index if not exists sl_manual_c on sl_manual_entries(contestant_id);

-- تعديلات المشرف
create table if not exists sl_adjustments (
  id bigserial primary key,
  contestant_id uuid not null references sl_contestants(id) on delete cascade,
  created_at timestamptz not null default now(),
  day_date date not null,
  delta int not null,
  kind text not null default 'adjust',        -- adjust / review_deduct
  reason text not null,
  admin_email text
);
create index if not exists sl_adj_c on sl_adjustments(contestant_id);

-- كاش يومي لكل متسابق
create table if not exists sl_daily (
  contestant_id uuid not null references sl_contestants(id) on delete cascade,
  day_date date not null,
  app_count bigint not null default 0,
  manual_count bigint not null default 0,
  adj_count bigint not null default 0,
  primary key (contestant_id, day_date)
);

-- كاش المجاميع العامة (يتحدث مرة كل 10 ثوانٍ كحد أقصى)
create table if not exists sl_public_cache (
  id int primary key check (id = 1),
  data jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default '-infinity'
);

create table if not exists sl_rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);

create table if not exists sl_audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text,
  action text not null,
  target text,
  details jsonb,
  reason text
);

-- استثناء يدوي من السحب: include = إدراج بالقوة / exclude = استبعاد
create table if not exists sl_overrides (
  contestant_id uuid primary key references sl_contestants(id) on delete cascade,
  mode text not null check (mode in ('include','exclude')),
  reason text not null,
  by_email text,
  at timestamptz not null default now()
);

-- تجميد النتائج (لقطة)
create table if not exists sl_results_snapshot (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by text,
  is_test boolean not null default false,
  data jsonb not null
);

create table if not exists sl_draw_rounds (
  id bigserial primary key,
  name text not null,
  winners_count int not null,
  gender text not null default 'all' check (gender in ('all','m','f')),
  status text not null default 'done' check (status in ('done','cancelled')),
  is_test boolean not null default false,
  executed_at timestamptz not null default now(),
  executed_by text,
  rules jsonb,
  eligible_count int,
  total_shares bigint,
  cancelled_at timestamptz, cancelled_by text, cancel_reason text
);

-- لقطة المؤهلين وأسهمهم وقت السحب (للتدقيق)
create table if not exists sl_draw_entries (
  round_id bigint not null references sl_draw_rounds(id) on delete cascade,
  contestant_id uuid not null,
  name text, gender text, bus_name text,
  total bigint, active_days int, shares int not null, forced boolean not null default false,
  primary key (round_id, contestant_id)
);

create table if not exists sl_draw_winners (
  id bigserial primary key,
  round_id bigint not null references sl_draw_rounds(id) on delete cascade,
  contestant_id uuid not null,
  draw_order int not null,
  name text, gender text, bus_name text,
  shares int, total bigint,
  status text not null default 'active' check (status in ('active','replaced')),
  replacement_of bigint,
  replaced_reason text, replaced_at timestamptz,
  contacted boolean not null default false,
  delivered boolean not null default false,
  drawn_at timestamptz not null default now()
);

-- القيم الأولية
insert into sl_settings(key, value) values
('config', '{
  "identity": {"campaign_name": "حملة الخلف", "primary_color": "#3d8f82", "gold_color": "#c9a24b"},
  "season": {"type": "hajj", "contest_name": "مسابقة الصلاة على محمد وآل محمد", "page_title": "", "welcome": "", "dhikr": "اللهم صل على محمد وآل محمد"},
  "schedule": {"start_at": null, "end_at": null, "day_start_hour": 0},
  "login": {"self_register": true, "pin_enabled": false, "remember_days": 30},
  "speed": {"min_interval_ms": 1500, "daily_cap_enabled": false, "daily_cap": 30000, "max_batch": 2000, "max_offline_hours": 6, "grace_minutes": 60, "batch_seconds": 20, "public_refresh_seconds": 30},
  "review": {"reject_ratio_enabled": true, "reject_ratio_pct": 25, "reject_min_sample": 100, "daily_rate_enabled": false, "daily_rate": 20000, "robotic_enabled": true, "robotic_min_presses": 200, "robotic_stdev_ms": 15},
  "manual": {"enabled": false, "max_per_entry": 1000, "max_per_day": 5000, "require_approval": true, "include_in_totals": true},
  "display": {"show_bus_ranking": false, "show_gender": false, "show_shares": false, "campaign_goal": 0, "announcement": "", "rules_text": "", "withdrawn_in_total": true},
  "results": {"top_n": 10, "scope": "both"},
  "draw": {"shares_enabled": true, "share_value": 5000, "max_shares": 0, "min_total": {"on": false, "value": 5000}, "active_days": {"on": false, "days": 2, "day_min": 100}, "exclude_flagged": true, "exclude_inactive": true, "exclude_prev_winners": true, "exclude_top": {"on": false}, "include_manual": true, "custom": []}
}'::jsonb),
('state', '{"mode": "draft", "paused": false, "paused_at": null, "published": false, "published_at": null, "frozen_at": null}'::jsonb)
on conflict (key) do nothing;
insert into sl_public_cache(id) values (1) on conflict do nothing;

-- ===================== أدوات داخلية =====================

create or replace function sl_is_admin() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from sl_admins a where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function sl_admin_email() returns text
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not sl_is_admin() then raise exception 'sl:not_admin'; end if;
  return auth.jwt() ->> 'email';
end $$;

create or replace function sl_cfg() returns jsonb language sql stable set search_path = public as $$
  select coalesce((select value from sl_settings where key = 'config'), '{}'::jsonb);
$$;
create or replace function sl_st() returns jsonb language sql stable set search_path = public as $$
  select coalesce((select value from sl_settings where key = 'state'), '{}'::jsonb);
$$;
create or replace function sl_num(j jsonb, p text[], def numeric) returns numeric language sql immutable as $$
  select coalesce(nullif(j #>> p, '')::numeric, def);
$$;
create or replace function sl_bool(j jsonb, p text[], def boolean) returns boolean language sql immutable as $$
  select coalesce(nullif(j #>> p, '')::boolean, def);
$$;
-- رقم من بيانات المتصفح التحليلية بأمان
create or replace function sl_jn(j jsonb, k text) returns numeric language sql immutable as $$
  select case when jsonb_typeof(j -> k) = 'number' then (j ->> k)::numeric end;
$$;
create or replace function sl_ts(cfg jsonb, k text) returns timestamptz language sql immutable as $$
  select nullif(cfg #>> array['schedule', k], '')::timestamptz;
$$;

-- يوم المسابقة لوقت معين (بتوقيت الرياض مع ساعة بداية اليوم)
create or replace function sl_day(t timestamptz, cfg jsonb) returns date language sql stable as $$
  select ((t at time zone 'Asia/Riyadh') - make_interval(hours => sl_num(cfg, '{schedule,day_start_hour}', 0)::int))::date;
$$;

create or replace function sl_status(cfg jsonb, st jsonb, t timestamptz) returns text language plpgsql stable as $$
declare s timestamptz := sl_ts(cfg, 'start_at'); e timestamptz := sl_ts(cfg, 'end_at');
begin
  if sl_bool(st, '{published}', false) then return 'published'; end if;
  if coalesce(st ->> 'mode', 'auto') = 'draft' or s is null then return 'draft'; end if;
  if e is not null and t >= e then return 'ended'; end if;
  if t < s then return 'scheduled'; end if;
  if sl_bool(st, '{paused}', false) then return 'paused'; end if;
  return 'running';
end $$;

-- هل تُقبل الدفعات الآن؟ (جارية، أو ضمن مهلة المزامنة بعد الإيقاف/الانتهاء)
create or replace function sl_accepting(cfg jsonb, st jsonb, t timestamptz) returns boolean language plpgsql stable as $$
declare s text := sl_status(cfg, st, t);
        g interval := make_interval(mins => sl_num(cfg, '{speed,grace_minutes}', 60)::int);
        e timestamptz := sl_ts(cfg, 'end_at');
begin
  if s = 'running' then return true; end if;
  if s = 'paused' then return t < coalesce(nullif(st ->> 'paused_at', '')::timestamptz, t) + g; end if;
  if s in ('ended', 'published') then return e is not null and t < e + g; end if;
  return false;
end $$;

create or replace function sl_norm_phone(p text) returns text language plpgsql immutable as $$
declare s text; plus boolean;
begin
  s := btrim(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'));
  plus := left(s, 1) = '+';
  s := regexp_replace(s, '\D', '', 'g');
  if s = '' then return null; end if;
  if left(s, 2) = '00' then s := substr(s, 3);
  elsif not plus then
    if s ~ '^05\d{8}$' then s := '966' || substr(s, 2);
    elsif s ~ '^5\d{8}$' then s := '966' || s; end if;
  end if;
  if left(s, 4) = '9660' then s := '966' || substr(s, 5); end if;
  if left(s, 3) = '966' then return case when s ~ '^9665\d{8}$' then s end; end if;
  return case when s ~ '^\d{8,15}$' then s end;
end $$;

create or replace function sl_hash(t text) returns text language sql immutable set search_path = public, extensions as $$
  select encode(digest(t, 'sha256'), 'hex');
$$;

create or replace function sl_client_ip() returns text language plpgsql stable as $$
declare h json;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  return coalesce(nullif(btrim(split_part(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-forwarded-for', h ->> 'x-real-ip', ''), ',', 1)), ''), 'noip');
end $$;

-- محدد المعدل: يعيد false إذا تجاوز العدد المسموح في النافذة
create or replace function sl_rate_ok(p_key text, p_max int, p_window interval) returns boolean
language plpgsql security definer set search_path = public as $$
declare h int;
begin
  insert into sl_rate_limits as r(key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start < now() - p_window then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning hits into h;
  if random() < 0.01 then delete from sl_rate_limits where window_start < now() - interval '1 day'; end if;
  return h <= p_max;
end $$;

create or replace function sl_audit(p_action text, p_target text, p_details jsonb, p_reason text default null) returns void
language sql security definer set search_path = public as $$
  insert into sl_audit_log(actor, action, target, details, reason)
  values (coalesce(auth.jwt() ->> 'email', 'system'), p_action, p_target, p_details, p_reason);
$$;

create or replace function sl_invalidate_cache() returns void language sql security definer set search_path = public as $$
  update sl_public_cache set computed_at = '-infinity' where id = 1;
$$;

-- رقم عشوائي منتظم في [0, n) من مصدر آمن تشفيرياً مع rejection sampling (بلا انحياز)
create or replace function sl_rand_below(n bigint) returns bigint
language plpgsql volatile set search_path = public, extensions as $$
declare lim bigint; r bigint;
begin
  if n is null or n <= 0 then raise exception 'sl:bad_range'; end if;
  lim := (4611686018427387904 / n) * n;   -- 2^62 مقطوعاً لأقرب مضاعف لـ n
  loop
    r := ('x' || encode(gen_random_bytes(8), 'hex'))::bit(64)::bigint & 4611686018427387903;
    if r < lim then return r % n; end if;
  end loop;
end $$;

-- إعادة حساب كاش متسابق من سجل الحركات بالكامل
create or replace function sl_recompute(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from sl_daily where contestant_id = p_id;
  insert into sl_daily(contestant_id, day_date, app_count, manual_count, adj_count)
  select p_id, d, sum(a), sum(m), sum(j) from (
    select day_date d, accepted::bigint a, 0::bigint m, 0::bigint j from sl_batches where contestant_id = p_id
    union all select day_date, 0, count, 0 from sl_manual_entries where contestant_id = p_id and status = 'approved'
    union all select day_date, 0, 0, delta from sl_adjustments where contestant_id = p_id
  ) x group by d;
  update sl_contestants c set
    app_total = coalesce((select sum(accepted) from sl_batches where contestant_id = p_id), 0),
    rejected_total = coalesce((select sum(rejected) from sl_batches where contestant_id = p_id and reason = 'speed'), 0),
    manual_total = coalesce((select sum(count) from sl_manual_entries where contestant_id = p_id and status = 'approved'), 0),
    manual_pending = coalesce((select sum(count) from sl_manual_entries where contestant_id = p_id and status = 'pending'), 0),
    adj_total = coalesce((select sum(delta) from sl_adjustments where contestant_id = p_id), 0)
  where c.id = p_id;
  perform sl_invalidate_cache();
end $$;

-- المجاميع العامة (كاش يتحدث مرة كل 10 ثوانٍ كحد أقصى)
create or replace function sl_refresh_cache(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := sl_cfg(); r record; inc boolean; wd boolean; td date; res jsonb;
begin
  select data, computed_at into r from sl_public_cache where id = 1;
  if not p_force and r.computed_at > now() - interval '10 seconds' then return r.data; end if;
  if not pg_try_advisory_xact_lock(7700112) then return coalesce(r.data, '{}'::jsonb); end if;
  inc := sl_bool(cfg, '{manual,include_in_totals}', true);
  wd := sl_bool(cfg, '{display,withdrawn_in_total}', true);
  td := sl_day(now(), cfg);
  with c as (
    select c.id, c.gender, c.bus_id, c.status,
           c.app_total + c.adj_total + case when inc then c.manual_total else 0 end as total
    from sl_contestants c
    where not c.is_test and (c.status = 'active' or (c.status = 'withdrawn' and wd))
  ), t as (
    select d.contestant_id, d.app_count + d.adj_count + case when inc then d.manual_count else 0 end as v
    from sl_daily d where d.day_date = td
  )
  select jsonb_build_object(
    'total', coalesce((select sum(total) from c), 0),
    'today', coalesce((select sum(v) from t join c on c.id = t.contestant_id), 0),
    'participants', (select count(*) from c where status = 'active'),
    'buses', coalesce((select jsonb_agg(x order by x.total desc) from (
        select b.id, b.name, count(c.id) as members, coalesce(sum(c.total), 0) as total,
               case when count(c.id) > 0 then round(coalesce(sum(c.total), 0)::numeric / count(c.id)) else 0 end as avg
        from sl_buses b left join c on c.bus_id = b.id and c.status = 'active'
        where not b.is_test group by b.id, b.name) x), '[]'::jsonb),
    'gender', (select jsonb_object_agg(g, jsonb_build_object('members', n, 'total', s, 'avg', case when n > 0 then round(s::numeric / n) else 0 end))
               from (select g, count(c.id) n, coalesce(sum(c.total), 0) s
                     from (values ('m'), ('f')) v(g) left join c on c.gender = v.g and c.status = 'active' group by g) y)
  ) into res;
  update sl_public_cache set data = res, computed_at = now() where id = 1;
  return res;
end $$;

-- جلسة المتسابق من الرمز
create or replace function sl_session(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select s.contestant_id into cid from sl_sessions s
  where s.token_hash = sl_hash(coalesce(p_token, '')) and s.expires_at > now();
  if cid is null then raise exception 'sl:bad_session'; end if;
  return cid;
end $$;

create or replace function sl_new_session(p_id uuid, p_remember boolean, p_ua text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare tok text := encode(gen_random_bytes(32), 'hex');
begin
  insert into sl_sessions(token_hash, contestant_id, expires_at, user_agent)
  values (sl_hash(tok), p_id,
          now() + case when coalesce(p_remember, true) then make_interval(days => sl_num(sl_cfg(), '{login,remember_days}', 30)::int) else interval '12 hours' end,
          left(p_ua, 200));
  delete from sl_sessions where expires_at < now() - interval '1 day' and contestant_id = p_id;
  return tok;
end $$;

-- بيانات المتسابق لنفسه
create or replace function sl_me_json(p_id uuid, p_full boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c sl_contestants; cfg jsonb := sl_cfg(); td date := sl_day(now(), cfg); res jsonb; bname text;
begin
  select * into c from sl_contestants where id = p_id;
  select name into bname from sl_buses where id = c.bus_id;
  res := jsonb_build_object(
    'id', c.id, 'name', c.name, 'gender', c.gender, 'bus_id', c.bus_id, 'bus_name', bname, 'status', c.status,
    'app_total', c.app_total, 'manual_total', c.manual_total, 'manual_pending', c.manual_pending,
    'adj_total', c.adj_total, 'rejected_total', c.rejected_total, 'today_key', td,
    'today', coalesce((select jsonb_build_object('app', app_count, 'man', manual_count, 'adj', adj_count)
                       from sl_daily where contestant_id = p_id and day_date = td), '{"app":0,"man":0,"adj":0}'::jsonb));
  if p_full then
    res := res || jsonb_build_object(
      'days', coalesce((select jsonb_agg(jsonb_build_object('d', day_date, 'app', app_count, 'man', manual_count, 'adj', adj_count) order by day_date)
                        from sl_daily where contestant_id = p_id), '[]'::jsonb),
      'manual', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'count', count, 'status', status) order by created_at desc)
                          from (select * from sl_manual_entries where contestant_id = p_id order by created_at desc limit 30) m), '[]'::jsonb));
  end if;
  return res;
end $$;

-- ===================== دوال المتسابق (anon) =====================

-- الحالة العامة: الإعدادات العامة + المجاميع + الباصات + النتائج المنشورة
create or replace function sl_public_state() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := sl_cfg(); st jsonb := sl_st(); status text; res jsonb; lv text; snap jsonb;
begin
  status := sl_status(cfg, st, now());
  select coalesce(value ->> 'version', '') into lv from sl_settings where key = 'logo';
  res := jsonb_build_object(
    'server_now', now(), 'status', status, 'config', cfg - 'review', 'state', st,
    'logo_version', coalesce(lv, ''),
    'cache', sl_refresh_cache(false),
    'buses', case when sl_bool(cfg, '{login,self_register}', true)
                  then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort, name) from sl_buses where not is_test), '[]'::jsonb)
                  else '[]'::jsonb end);
  if status = 'published' then
    select data into snap from sl_results_snapshot where not is_test order by id desc limit 1;
    res := res || jsonb_build_object('results', jsonb_build_object(
      -- الأسماء والباصات فقط (بلا أرقام جوال ولا أعداد)
      'top', coalesce((select jsonb_object_agg(k, (select coalesce(jsonb_agg(jsonb_build_object('rank', e ->> 'rank', 'name', e ->> 'name', 'bus', e ->> 'bus')), '[]'::jsonb)
                                                    from jsonb_array_elements(v) e))
                       from jsonb_each(coalesce(snap -> 'lists', '{}'::jsonb)) as l(k, v)), '{}'::jsonb),
      'rounds', coalesce((select jsonb_agg(jsonb_build_object('name', r.name,
                  'winners', (select coalesce(jsonb_agg(jsonb_build_object('name', w.name, 'bus', w.bus_name) order by w.draw_order), '[]'::jsonb)
                              from sl_draw_winners w where w.round_id = r.id and w.status = 'active')) order by r.id)
                  from sl_draw_rounds r where r.status = 'done' and not r.is_test), '[]'::jsonb)));
  end if;
  return res;
end $$;

create or replace function sl_get_logo() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select value from sl_settings where key = 'logo'), '{}'::jsonb);
$$;

-- البحث عن رقم (مع محدد معدل)
create or replace function sl_lookup(p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ph text := sl_norm_phone(p_phone); c sl_contestants; cfg jsonb := sl_cfg(); bname text;
begin
  if ph is null then return jsonb_build_object('error', 'invalid_phone'); end if;
  if not sl_rate_ok('lk:ip:' || sl_client_ip(), 40, interval '10 minutes')
     or not sl_rate_ok('lk:ph:' || ph, 20, interval '10 minutes') then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select * into c from sl_contestants where phone = ph;
  if not found then
    return jsonb_build_object('found', false, 'phone', ph, 'self_register', sl_bool(cfg, '{login,self_register}', true));
  end if;
  select name into bname from sl_buses where id = c.bus_id;
  return jsonb_build_object('found', true, 'phone', ph, 'name', c.name, 'bus_name', bname, 'status', c.status,
    'pin_enabled', sl_bool(cfg, '{login,pin_enabled}', false), 'pin_set', c.pin_hash is not null);
end $$;

create or replace function sl_login(p_phone text, p_pin text default null, p_remember boolean default true, p_ua text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ph text := sl_norm_phone(p_phone); c sl_contestants; cfg jsonb := sl_cfg();
begin
  if ph is null then return jsonb_build_object('error', 'invalid_phone'); end if;
  if not sl_rate_ok('lg:ip:' || sl_client_ip(), 40, interval '10 minutes') then return jsonb_build_object('error', 'rate_limited'); end if;
  select * into c from sl_contestants where phone = ph;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if sl_bool(cfg, '{login,pin_enabled}', false) then
    if c.pin_hash is null then
      if coalesce(p_pin, '') !~ '^\d{4}$' then return jsonb_build_object('error', 'pin_setup'); end if;
      update sl_contestants set pin_hash = crypt(p_pin, gen_salt('bf', 8)) where id = c.id;
    else
      if not sl_rate_ok('pin:' || c.id, 6, interval '15 minutes') then return jsonb_build_object('error', 'rate_limited'); end if;
      if coalesce(p_pin, '') = '' then return jsonb_build_object('error', 'pin_required'); end if;
      if crypt(p_pin, c.pin_hash) <> c.pin_hash then return jsonb_build_object('error', 'pin_wrong'); end if;
    end if;
  end if;
  return jsonb_build_object('token', sl_new_session(c.id, p_remember, p_ua), 'me', sl_me_json(c.id));
end $$;

create or replace function sl_register(p_name text, p_phone text, p_gender text, p_bus_id bigint, p_pin text default null,
                                       p_remember boolean default true, p_ua text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ph text := sl_norm_phone(p_phone); cfg jsonb := sl_cfg(); cid uuid;
begin
  if not sl_bool(cfg, '{login,self_register}', true) then return jsonb_build_object('error', 'registration_closed'); end if;
  if ph is null then return jsonb_build_object('error', 'invalid_phone'); end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then return jsonb_build_object('error', 'name_required'); end if;
  if p_gender not in ('m', 'f') then return jsonb_build_object('error', 'gender_required'); end if;
  if not exists (select 1 from sl_buses where id = p_bus_id and not is_test) then return jsonb_build_object('error', 'bus_required'); end if;
  if not sl_rate_ok('rg:ip:' || sl_client_ip(), 15, interval '1 hour') then return jsonb_build_object('error', 'rate_limited'); end if;
  if exists (select 1 from sl_contestants where phone = ph) then return jsonb_build_object('error', 'phone_exists'); end if;
  if sl_bool(cfg, '{login,pin_enabled}', false) and coalesce(p_pin, '') !~ '^\d{4}$' then return jsonb_build_object('error', 'pin_invalid'); end if;
  insert into sl_contestants(name, phone, gender, bus_id, created_by, pin_hash)
  values (left(btrim(p_name), 80), ph, p_gender, p_bus_id, 'self',
          case when sl_bool(cfg, '{login,pin_enabled}', false) then crypt(p_pin, gen_salt('bf', 8)) end)
  returning id into cid;
  perform sl_invalidate_cache();
  return jsonb_build_object('token', sl_new_session(cid, p_remember, p_ua), 'me', sl_me_json(cid));
end $$;

create or replace function sl_me(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return sl_me_json(sl_session(p_token));
end $$;

create or replace function sl_logout(p_token text) returns jsonb
language sql security definer set search_path = public as $$
  delete from sl_sessions where token_hash = sl_hash(coalesce(p_token, '')) returning jsonb_build_object('ok', true);
$$;

-- استلام دفعة ضغطات: التحقق على الخادم برصيد زمني مشترك بين أجهزة الحساب
create or replace function sl_submit_batch(p_token text, p_batch_id uuid, p_count int, p_stats jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ex sl_batches; c sl_contestants; cid uuid; cfg jsonb := sl_cfg(); st jsonb := sl_st(); t timestamptz := now();
  iv numeric; cap numeric; req int; acc int := 0; reason text := 'ok'; tokens double precision;
  s_at timestamptz; e_at timestamptz; win_end timestamptz; from_t timestamptz;
  d date; sd date; ed date; today_app bigint; reasons jsonb; newr text[] := '{}'; r text; vstats jsonb;
  n numeric; sdv numeric; mn numeric;
begin
  -- إعادة إرسال دفعة سابقة: نعيد نتيجتها كما هي (لا تُحسب مرتين)
  select * into ex from sl_batches where batch_id = p_batch_id;
  if found then
    return jsonb_build_object('duplicate', true, 'accepted', ex.accepted, 'rejected', ex.rejected, 'reason', ex.reason, 'me', sl_me_json(ex.contestant_id, false));
  end if;
  cid := sl_session(p_token);
  select * into c from sl_contestants where id = cid for update;   -- قفل الصف: الرصيد مشترك بين الأجهزة
  select * into ex from sl_batches where batch_id = p_batch_id;
  if found then
    return jsonb_build_object('duplicate', true, 'accepted', ex.accepted, 'rejected', ex.rejected, 'reason', ex.reason, 'me', sl_me_json(cid, false));
  end if;

  p_count := greatest(0, coalesce(p_count, 0));
  iv := greatest(50, sl_num(cfg, '{speed,min_interval_ms}', 1500));
  cap := sl_num(cfg, '{speed,max_offline_hours}', 6) * 3600000 / iv;
  req := least(p_count, sl_num(cfg, '{speed,max_batch}', 2000)::int);
  s_at := sl_ts(cfg, 'start_at'); e_at := sl_ts(cfg, 'end_at');
  tokens := c.bucket_tokens;

  if s_at is null or not sl_accepting(cfg, st, t) then
    reason := 'closed';
  else
    -- تجديد الرصيد بالزمن الفعلي على الخادم (لا يتجدد قبل البداية ولا بعد الإيقاف/الانتهاء)
    win_end := t;
    if e_at is not null and e_at < win_end then win_end := e_at; end if;
    if sl_bool(st, '{paused}', false) and nullif(st ->> 'paused_at', '') is not null then
      win_end := least(win_end, (st ->> 'paused_at')::timestamptz);
    end if;
    from_t := greatest(coalesce(c.bucket_at, s_at), s_at);
    tokens := least(cap, tokens + greatest(0, extract(epoch from (win_end - from_t)) * 1000 / iv));
    acc := least(req, floor(tokens)::int);
    if acc < p_count then reason := case when req < p_count and acc = req then 'batch_cap' else 'speed' end; end if;
    if sl_bool(cfg, '{speed,daily_cap_enabled}', false) then
      select coalesce(sum(app_count), 0) into today_app from sl_daily where contestant_id = cid and day_date = sl_day(t, cfg);
      if today_app + acc > sl_num(cfg, '{speed,daily_cap}', 30000) then
        acc := greatest(0, sl_num(cfg, '{speed,daily_cap}', 30000)::int - today_app::int);
        reason := 'daily_cap';
      end if;
    end if;
    tokens := tokens - acc;
    c.bucket_at := greatest(from_t, win_end);
  end if;

  -- يوم الاستلام (محصوراً ضمن أيام المسابقة)
  d := sl_day(t, cfg);
  if s_at is not null then sd := sl_day(s_at, cfg); if d < sd then d := sd; end if; end if;
  if e_at is not null then ed := sl_day(e_at - interval '1 millisecond', cfg); if d > ed then d := ed; end if; end if;

  insert into sl_batches(batch_id, contestant_id, received_at, day_date, requested, accepted, rejected, reason, client_stats)
  values (p_batch_id, cid, t, d, p_count, acc, p_count - acc, reason, case when jsonb_typeof(p_stats) = 'object' then p_stats end);

  if acc > 0 then
    insert into sl_daily as x(contestant_id, day_date, app_count) values (cid, d, acc)
    on conflict (contestant_id, day_date) do update set app_count = x.app_count + excluded.app_count;
  end if;

  -- علامات المراجعة (للفحص وليست عقوبة)
  c.app_total := c.app_total + acc;
  if reason = 'speed' then c.rejected_total := c.rejected_total + (p_count - acc); end if;
  reasons := c.flag_reasons;
  if sl_bool(cfg, '{review,reject_ratio_enabled}', true)
     and c.app_total + c.rejected_total >= sl_num(cfg, '{review,reject_min_sample}', 100)
     and c.rejected_total * 100 > sl_num(cfg, '{review,reject_ratio_pct}', 25) * (c.app_total + c.rejected_total) then
    newr := newr || 'reject_ratio'::text;
  end if;
  if sl_bool(cfg, '{review,daily_rate_enabled}', false) then
    select coalesce(sum(app_count), 0) into today_app from sl_daily where contestant_id = cid and day_date = d;
    if today_app > sl_num(cfg, '{review,daily_rate}', 20000) then newr := newr || 'daily_rate'::text; end if;
  end if;
  n := sl_jn(p_stats, 'n'); sdv := sl_jn(p_stats, 'sd'); mn := sl_jn(p_stats, 'min');
  if sl_bool(cfg, '{review,robotic_enabled}', true) and n >= sl_num(cfg, '{review,robotic_min_presses}', 200)
     and sdv is not null and sdv < sl_num(cfg, '{review,robotic_stdev_ms}', 15) then
    newr := newr || 'robotic'::text;
  end if;
  foreach r in array newr loop
    if not reasons ? r then
      reasons := reasons || to_jsonb(r);
      if c.review_status <> 'excluded' then c.review_status := 'pending'; end if;
    end if;
  end loop;
  vstats := c.stats;
  if mn is not null and (vstats ->> 'min_gap' is null or mn < (vstats ->> 'min_gap')::numeric) then
    vstats := vstats || jsonb_build_object('min_gap', mn);
  end if;
  if sl_jn(p_stats, 'avg') is not null then vstats := vstats || jsonb_build_object('last_avg', sl_jn(p_stats, 'avg'), 'last_sd', sdv); end if;

  update sl_contestants set
    app_total = c.app_total, rejected_total = c.rejected_total,
    bucket_tokens = tokens, bucket_at = c.bucket_at,
    last_sync_at = t, last_active_at = case when acc > 0 then t else last_active_at end,
    reached_at = case when acc > 0 then t else reached_at end,
    flag_reasons = reasons, review_status = c.review_status, stats = vstats
  where id = cid;

  return jsonb_build_object('accepted', acc, 'rejected', p_count - acc, 'reason', reason, 'me', sl_me_json(cid, false));
end $$;

-- إضافة عدد منجز خارج التطبيق
create or replace function sl_add_manual(p_token text, p_count int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := sl_session(p_token); cfg jsonb := sl_cfg(); d date := sl_day(now(), cfg); used bigint; appr boolean;
begin
  if not sl_bool(cfg, '{manual,enabled}', false) then return jsonb_build_object('error', 'manual_disabled'); end if;
  if not sl_accepting(cfg, sl_st(), now()) then return jsonb_build_object('error', 'not_running'); end if;
  if p_count is null or p_count < 1 then return jsonb_build_object('error', 'bad_count'); end if;
  if p_count > sl_num(cfg, '{manual,max_per_entry}', 1000) then return jsonb_build_object('error', 'manual_too_big'); end if;
  perform 1 from sl_contestants where id = cid for update;
  select coalesce(sum(count), 0) into used from sl_manual_entries where contestant_id = cid and day_date = d and status in ('pending', 'approved');
  if used + p_count > sl_num(cfg, '{manual,max_per_day}', 5000) then return jsonb_build_object('error', 'manual_daily_limit'); end if;
  appr := not sl_bool(cfg, '{manual,require_approval}', true);
  insert into sl_manual_entries(contestant_id, day_date, count, status, decided_by, decided_at)
  values (cid, d, p_count, case when appr then 'approved' else 'pending' end, case when appr then 'auto' end, case when appr then now() end);
  perform sl_recompute(cid);
  if appr then update sl_contestants set reached_at = now(), last_active_at = now() where id = cid; end if;
  return jsonb_build_object('ok', true, 'pending', not appr, 'me', sl_me_json(cid));
end $$;

-- ===================== دوال المشرف =====================

create or replace function sl_admin_whoami() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', auth.jwt() ->> 'email', 'is_admin', sl_is_admin());
$$;

-- كل ما تحتاجه لوحة المشرف في طلب واحد (p_test = عرض بيانات المحاكاة)
create or replace function sl_admin_dump(p_test boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := sl_cfg(); st jsonb := sl_st();
begin
  perform sl_admin_email();
  return jsonb_build_object(
    'server_now', now(), 'status', sl_status(cfg, st, now()), 'config', cfg, 'state', st,
    'logo_version', (select value ->> 'version' from sl_settings where key = 'logo'),
    'buses', coalesce((select jsonb_agg(to_jsonb(b) order by b.sort, b.name) from sl_buses b where b.is_test = p_test), '[]'::jsonb),
    'contestants', coalesce((select jsonb_agg(to_jsonb(c) - 'pin_hash' - 'bucket_tokens' - 'bucket_at' || jsonb_build_object('pin_set', c.pin_hash is not null))
                             from sl_contestants c where c.is_test = p_test), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_array(d.contestant_id, d.day_date, d.app_count, d.manual_count, d.adj_count))
                       from sl_daily d join sl_contestants c on c.id = d.contestant_id where c.is_test = p_test), '[]'::jsonb),
    'manual', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc) from (
                          select m.* from sl_manual_entries m join sl_contestants c on c.id = m.contestant_id
                          where c.is_test = p_test order by (m.status = 'pending') desc, m.created_at desc limit 500) m), '[]'::jsonb),
    'overrides', coalesce((select jsonb_agg(to_jsonb(o)) from sl_overrides o join sl_contestants c on c.id = o.contestant_id where c.is_test = p_test), '[]'::jsonb),
    'rounds', coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from sl_draw_rounds r where r.is_test = p_test), '[]'::jsonb),
    'winners', coalesce((select jsonb_agg(to_jsonb(w) order by w.round_id, w.draw_order) from sl_draw_winners w join sl_draw_rounds r on r.id = w.round_id where r.is_test = p_test), '[]'::jsonb),
    'snapshot', (select to_jsonb(s) from sl_results_snapshot s where s.is_test = p_test order by id desc limit 1),
    'audit', coalesce((select jsonb_agg(to_jsonb(a) order by a.id desc) from (select * from sl_audit_log order by id desc limit 300) a), '[]'::jsonb),
    'test_count', (select count(*) from sl_contestants where is_test)
  );
end $$;

-- بطاقة متسابق كاملة
create or replace function sl_admin_contestant(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  return jsonb_build_object(
    'batches', coalesce((select jsonb_agg(to_jsonb(b) order by b.received_at desc) from (select * from sl_batches where contestant_id = p_id order by received_at desc limit 400) b), '[]'::jsonb),
    'manual', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc) from sl_manual_entries m where m.contestant_id = p_id), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from sl_adjustments a where a.contestant_id = p_id), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(to_jsonb(a) order by a.id desc) from sl_audit_log a where a.target = p_id::text), '[]'::jsonb),
    'sessions', (select count(*) from sl_sessions where contestant_id = p_id and expires_at > now()),
    'batch_count', (select count(*) from sl_batches where contestant_id = p_id)
  );
end $$;

create or replace function sl_admin_save_config(p_config jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old jsonb := sl_cfg(); ch text[];
begin
  perform sl_admin_email();
  if jsonb_typeof(p_config) <> 'object' then raise exception 'sl:bad_config'; end if;
  select array_agg(k) into ch from (select key k from jsonb_each(p_config) union select key from jsonb_each(old)) x
  where (old -> k) is distinct from (p_config -> k);
  update sl_settings set value = p_config, updated_at = now() where key = 'config';
  perform sl_invalidate_cache();
  perform sl_audit('save_config', null, jsonb_build_object('sections', ch), null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function sl_admin_save_logo(p_data text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  if p_data is null or p_data = '' then
    delete from sl_settings where key = 'logo';
  else
    if length(p_data) > 290000 or p_data !~ '^data:image/' then raise exception 'sl:logo_too_big'; end if;
    insert into sl_settings(key, value) values ('logo', jsonb_build_object('data', p_data, 'version', extract(epoch from now())::bigint::text))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  perform sl_audit('save_logo', null, jsonb_build_object('size', length(coalesce(p_data, ''))), null);
  return jsonb_build_object('ok', true);
end $$;

-- لقطة النتائج (الأعلى) — داخلية
create or replace function sl_make_snapshot(p_test boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := sl_cfg(); n int := greatest(1, sl_num(cfg, '{results,top_n}', 10)::int);
        inc boolean := sl_bool(cfg, '{manual,include_in_totals}', true); lists jsonb; sid bigint;
begin
  with r as (
    select c.id, c.name, c.gender, b.name bus, c.app_total + c.adj_total + case when inc then c.manual_total else 0 end total, c.reached_at
    from sl_contestants c left join sl_buses b on b.id = c.bus_id
    where c.is_test = p_test and c.status = 'active'
  ), o as (select *, row_number() over (order by total desc, reached_at asc nulls last, name) rk from r where total > 0),
     m as (select *, row_number() over (order by total desc, reached_at asc nulls last, name) rk from r where total > 0 and gender = 'm'),
     f as (select *, row_number() over (order by total desc, reached_at asc nulls last, name) rk from r where total > 0 and gender = 'f')
  select jsonb_build_object(
    'overall', coalesce((select jsonb_agg(jsonb_build_object('rank', rk, 'id', id, 'name', name, 'bus', bus, 'gender', gender, 'total', total) order by rk) from o where rk <= n), '[]'::jsonb),
    'm', coalesce((select jsonb_agg(jsonb_build_object('rank', rk, 'id', id, 'name', name, 'bus', bus, 'gender', gender, 'total', total) order by rk) from m where rk <= n), '[]'::jsonb),
    'f', coalesce((select jsonb_agg(jsonb_build_object('rank', rk, 'id', id, 'name', name, 'bus', bus, 'gender', gender, 'total', total) order by rk) from f where rk <= n), '[]'::jsonb)
  ) into lists;
  -- نحتفظ فقط بالقوائم المطلوبة حسب نطاق الإعلان
  lists := case coalesce(cfg #>> '{results,scope}', 'both')
             when 'overall' then jsonb_build_object('overall', lists -> 'overall')
             when 'gender' then jsonb_build_object('m', lists -> 'm', 'f', lists -> 'f')
             else lists end;
  insert into sl_results_snapshot(created_by, is_test, data)
  values (coalesce(auth.jwt() ->> 'email', 'system'), p_test, jsonb_build_object('top_n', n, 'lists', lists, 'at', now()))
  returning id into sid;
  return jsonb_build_object('id', sid, 'lists', lists);
end $$;

create or replace function sl_admin_freeze(p_test boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  perform sl_admin_email();
  res := sl_make_snapshot(p_test);
  if not p_test then
    update sl_settings set value = value || jsonb_build_object('frozen_at', now()) where key = 'state';
  end if;
  perform sl_audit('freeze_results', null, jsonb_build_object('snapshot', res -> 'id', 'test', p_test), null);
  return res;
end $$;

-- أزرار حالة المسابقة
create or replace function sl_admin_state(p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := sl_cfg(); st jsonb := sl_st();
begin
  perform sl_admin_email();
  case p_action
    when 'start_now' then
      cfg := jsonb_set(cfg, '{schedule}', coalesce(cfg -> 'schedule', '{}'::jsonb) || jsonb_build_object('start_at', now()));
      if sl_ts(cfg, 'end_at') is not null and sl_ts(cfg, 'end_at') <= now() then cfg := jsonb_set(cfg, '{schedule,end_at}', 'null'); end if;
      st := st || '{"mode":"auto","paused":false,"paused_at":null}'::jsonb;
    when 'pause' then st := st || jsonb_build_object('paused', true, 'paused_at', now());
    when 'resume' then st := st || '{"paused":false,"paused_at":null}'::jsonb;
    when 'end_now' then cfg := jsonb_set(cfg, '{schedule}', coalesce(cfg -> 'schedule', '{}'::jsonb) || jsonb_build_object('end_at', now())); st := st || '{"paused":false}'::jsonb;
    when 'activate' then st := st || '{"mode":"auto"}'::jsonb;
    when 'draft' then st := st || '{"mode":"draft"}'::jsonb;
    when 'publish' then
      if st ->> 'frozen_at' is null then perform sl_make_snapshot(false); st := st || jsonb_build_object('frozen_at', now()); end if;
      st := st || jsonb_build_object('published', true, 'published_at', now());
    when 'unpublish' then st := st || '{"published":false}'::jsonb;
    else raise exception 'sl:bad_action';
  end case;
  update sl_settings set value = cfg, updated_at = now() where key = 'config';
  update sl_settings set value = st, updated_at = now() where key = 'state';
  perform sl_invalidate_cache();
  perform sl_audit('state_' || p_action, null, null, null);
  return jsonb_build_object('ok', true, 'status', sl_status(cfg, st, now()));
end $$;

-- الحصول على باص بالاسم أو إنشاؤه
create or replace function sl_bus_id(p_name text, p_test boolean) returns bigint
language plpgsql security definer set search_path = public as $$
declare bid bigint; nm text := btrim(coalesce(p_name, ''));
begin
  if nm = '' then return null; end if;
  if nm ~ '^\d+$' then nm := 'باص ' || nm; end if;
  select id into bid from sl_buses where name = nm and is_test = p_test;
  if bid is null then
    insert into sl_buses(name, is_test, sort) values (nm, p_test, coalesce((select max(sort) + 1 from sl_buses), 1)) returning id into bid;
  end if;
  return bid;
end $$;

create or replace function sl_admin_bus(p_action text, p_id bigint, p_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  if p_action = 'add' then perform sl_bus_id(p_name, false);
  elsif p_action = 'rename' then update sl_buses set name = btrim(p_name) where id = p_id;
  elsif p_action = 'delete' then delete from sl_buses where id = p_id;
  else raise exception 'sl:bad_action'; end if;
  perform sl_invalidate_cache();
  perform sl_audit('bus_' || p_action, p_id::text, jsonb_build_object('name', p_name), null);
  return jsonb_build_object('ok', true);
end $$;

-- إضافة/تعديل متسابق
create or replace function sl_admin_upsert_contestant(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ph text := sl_norm_phone(p ->> 'phone'); cid uuid := nullif(p ->> 'id', '')::uuid; bid bigint; other uuid;
begin
  perform sl_admin_email();
  if ph is null then raise exception 'sl:invalid_phone'; end if;
  if length(btrim(coalesce(p ->> 'name', ''))) < 2 then raise exception 'sl:name_required'; end if;
  if coalesce(p ->> 'gender', '') not in ('m', 'f') then raise exception 'sl:gender_required'; end if;
  bid := coalesce(nullif(p ->> 'bus_id', '')::bigint, sl_bus_id(p ->> 'bus_name', false));
  select id into other from sl_contestants where phone = ph;
  if other is not null and other is distinct from cid then raise exception 'sl:phone_exists'; end if;
  if cid is null then
    insert into sl_contestants(name, phone, gender, bus_id, created_by, joined_at)
    values (btrim(p ->> 'name'), ph, p ->> 'gender', bid, 'admin', coalesce(nullif(p ->> 'joined_at', '')::timestamptz, now()))
    returning id into cid;
    perform sl_audit('add_contestant', cid::text, p, null);
  else
    update sl_contestants set name = btrim(p ->> 'name'), phone = ph, gender = p ->> 'gender', bus_id = bid where id = cid;
    perform sl_audit('edit_contestant', cid::text, p, null);
  end if;
  perform sl_invalidate_cache();
  return jsonb_build_object('ok', true, 'id', cid);
end $$;

create or replace function sl_admin_set_status(p_id uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'sl:reason_required'; end if;
  update sl_contestants set status = p_status,
    review_status = case when p_status = 'active' and review_status = 'excluded' then 'approved' else review_status end
  where id = p_id;
  perform sl_invalidate_cache();
  perform sl_audit('status_' || p_status, p_id::text, null, p_reason);
  return jsonb_build_object('ok', true);
end $$;

create or replace function sl_admin_reset_pin(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  update sl_contestants set pin_hash = null where id = p_id;
  delete from sl_sessions where contestant_id = p_id;
  perform sl_audit('reset_pin', p_id::text, null, null);
  return jsonb_build_object('ok', true);
end $$;

-- حذف نهائي لمتسابق
create or replace function sl_admin_delete_contestant(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c sl_contestants;
begin
  perform sl_admin_email();
  if coalesce(btrim(p_reason), '') = '' then raise exception 'sl:reason_required'; end if;
  select * into c from sl_contestants where id = p_id;
  delete from sl_contestants where id = p_id;
  perform sl_invalidate_cache();
  perform sl_audit('delete_contestant', p_id::text, jsonb_build_object('name', c.name, 'phone', c.phone, 'app_total', c.app_total, 'manual_total', c.manual_total, 'adj_total', c.adj_total), p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- تعديل العدد بالزيادة أو النقص (سبب إجباري)
create or replace function sl_admin_adjust(p_id uuid, p_delta int, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email();
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'sl:reason_required'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception 'sl:bad_count'; end if;
  insert into sl_adjustments(contestant_id, day_date, delta, kind, reason, admin_email)
  values (p_id, sl_day(now(), sl_cfg()), p_delta, 'adjust', p_reason, em);
  perform sl_recompute(p_id);
  if p_delta > 0 then update sl_contestants set reached_at = now() where id = p_id; end if;
  perform sl_audit('adjust', p_id::text, jsonb_build_object('delta', p_delta), p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- قرار المراجعة: approve / deduct / exclude / reset
create or replace function sl_admin_review(p_id uuid, p_decision text, p_delta int, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email();
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'sl:reason_required'; end if;
  if p_decision = 'approve' then
    update sl_contestants set review_status = 'approved', review_note = p_reason where id = p_id;
  elsif p_decision = 'deduct' then
    if coalesce(p_delta, 0) = 0 then raise exception 'sl:bad_count'; end if;
    insert into sl_adjustments(contestant_id, day_date, delta, kind, reason, admin_email)
    values (p_id, sl_day(now(), sl_cfg()), -abs(p_delta), 'review_deduct', p_reason, em);
    update sl_contestants set review_status = 'deducted', review_note = p_reason where id = p_id;
    perform sl_recompute(p_id);
  elsif p_decision = 'exclude' then
    update sl_contestants set review_status = 'excluded', status = 'excluded', review_note = p_reason where id = p_id;
  elsif p_decision = 'reset' then
    update sl_contestants set review_status = 'none', flag_reasons = '[]'::jsonb, review_note = p_reason where id = p_id;
  else raise exception 'sl:bad_action'; end if;
  perform sl_invalidate_cache();
  perform sl_audit('review_' || p_decision, p_id::text, jsonb_build_object('delta', p_delta), p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- اعتماد/رفض/تراجع عن إضافة يدوية
create or replace function sl_admin_manual(p_id bigint, p_action text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email(); m sl_manual_entries;
begin
  select * into m from sl_manual_entries where id = p_id;
  if not found then raise exception 'sl:not_found'; end if;
  update sl_manual_entries set
    status = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' when 'revert' then 'reverted' else status end,
    decided_by = em, decided_at = now(), note = coalesce(p_reason, note)
  where id = p_id;
  perform sl_recompute(m.contestant_id);
  if p_action = 'approve' then update sl_contestants set reached_at = now() where id = m.contestant_id; end if;
  perform sl_audit('manual_' || p_action, m.contestant_id::text, jsonb_build_object('entry', p_id, 'count', m.count), p_reason);
  return jsonb_build_object('ok', true);
end $$;

create or replace function sl_admin_override(p_id uuid, p_mode text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email();
begin
  if p_mode is null or p_mode = '' then
    delete from sl_overrides where contestant_id = p_id;
  else
    if coalesce(btrim(p_reason), '') = '' then raise exception 'sl:reason_required'; end if;
    insert into sl_overrides(contestant_id, mode, reason, by_email) values (p_id, p_mode, p_reason, em)
    on conflict (contestant_id) do update set mode = excluded.mode, reason = excluded.reason, by_email = excluded.by_email, at = now();
  end if;
  perform sl_audit('override_' || coalesce(nullif(p_mode, ''), 'remove'), p_id::text, null, p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- استيراد قائمة متسابقين [{name, phone, gender, bus}] — on_dup: update / skip
create or replace function sl_admin_import(p_rows jsonb, p_on_dup text default 'skip') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; ph text; g text; ins int := 0; upd int := 0; skp int := 0; bad int := 0; cid uuid; nb int; b0 int;
begin
  perform sl_admin_email();
  select count(*) into b0 from sl_buses where not is_test;
  for r in select * from jsonb_array_elements(p_rows) loop
    ph := sl_norm_phone(r ->> 'phone');
    g := r ->> 'gender';
    if ph is null or g not in ('m', 'f') or length(btrim(coalesce(r ->> 'name', ''))) < 2 then bad := bad + 1; continue; end if;
    select id into cid from sl_contestants where phone = ph;
    if cid is not null then
      if p_on_dup = 'update' then
        update sl_contestants set name = btrim(r ->> 'name'), gender = g, bus_id = coalesce(sl_bus_id(r ->> 'bus', false), bus_id) where id = cid;
        upd := upd + 1;
      else skp := skp + 1; end if;
    else
      insert into sl_contestants(name, phone, gender, bus_id, created_by) values (btrim(r ->> 'name'), ph, g, sl_bus_id(r ->> 'bus', false), 'import');
      ins := ins + 1;
    end if;
  end loop;
  select count(*) - b0 into nb from sl_buses where not is_test;
  perform sl_invalidate_cache();
  perform sl_audit('import', null, jsonb_build_object('inserted', ins, 'updated', upd, 'skipped', skp, 'invalid', bad, 'buses_created', nb), null);
  return jsonb_build_object('inserted', ins, 'updated', upd, 'skipped', skp, 'invalid', bad, 'buses_created', nb);
end $$;

-- ===================== السحب =====================

-- فحص الشروط المخصصة (حقول ومعاملات من قائمة مسموحة فقط — لا يُنفذ أي نص حر)
create or replace function sl_custom_ok(p_conds jsonb, p_total bigint, p_days int, p_gender text, p_bus text, p_status text, p_manual bigint)
returns boolean language plpgsql immutable as $$
declare c jsonb; f text; op text; v text; num numeric; lhs_n numeric; lhs_t text; ok boolean;
begin
  if p_conds is null or jsonb_typeof(p_conds) <> 'array' then return true; end if;
  for c in select * from jsonb_array_elements(p_conds) loop
    if not coalesce((c ->> 'on')::boolean, false) then continue; end if;
    f := c ->> 'field'; op := c ->> 'op'; v := btrim(coalesce(c ->> 'value', ''));
    if op not in ('eq', 'ne', 'ge', 'le') then raise exception 'sl:bad_condition'; end if;
    lhs_n := null; lhs_t := null;
    case f
      when 'total' then lhs_n := p_total;
      when 'active_days' then lhs_n := p_days;
      when 'manual' then lhs_n := p_manual;
      when 'gender' then lhs_t := p_gender;
      when 'bus' then lhs_t := coalesce(p_bus, '');
      when 'status' then lhs_t := p_status;
      else raise exception 'sl:bad_condition';
    end case;
    if lhs_n is not null or f in ('total', 'active_days', 'manual') then
      if v !~ '^-?\d+(\.\d+)?$' then raise exception 'sl:bad_condition'; end if;
      num := v::numeric; lhs_n := coalesce(lhs_n, 0);
      ok := case op when 'eq' then lhs_n = num when 'ne' then lhs_n <> num when 'ge' then lhs_n >= num else lhs_n <= num end;
    else
      if f = 'bus' and v ~ '^\d+$' then v := 'باص ' || v; end if;
      if op in ('ge', 'le') and lhs_t ~ '\d' and v ~ '\d' then
        lhs_n := nullif(regexp_replace(lhs_t, '\D', '', 'g'), '')::numeric; num := nullif(regexp_replace(v, '\D', '', 'g'), '')::numeric;
        ok := case op when 'ge' then lhs_n >= num else lhs_n <= num end;
      else
        ok := case op when 'eq' then lhs_t = v when 'ne' then lhs_t <> v when 'ge' then lhs_t >= v else lhs_t <= v end;
      end if;
    end if;
    if not coalesce(ok, false) then return false; end if;
  end loop;
  return true;
end $$;

-- قائمة المؤهلين للسحب مع أسهمهم (نفس الدالة للمعاينة والتنفيذ)
create or replace function sl_draw_eligible(p_gender text, p_test boolean)
returns table(contestant_id uuid, name text, gender text, bus_name text, total bigint, active_days int, shares int, forced boolean)
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := sl_cfg(); d jsonb := coalesce(sl_cfg() -> 'draw', '{}'::jsonb);
  inc boolean; sh_on boolean; sv bigint; mx int; dmin bigint; top_ids uuid[] := '{}'; snap jsonb; n int;
begin
  inc := sl_bool(d, '{include_manual}', true);
  sh_on := sl_bool(d, '{shares_enabled}', true);
  sv := greatest(1, sl_num(d, '{share_value}', 5000)::bigint);
  mx := sl_num(d, '{max_shares}', 0)::int;
  dmin := sl_num(d, '{active_days,day_min}', 1)::bigint;
  if sl_bool(d, '{exclude_top,on}', false) then
    select data into snap from sl_results_snapshot s where s.is_test = p_test order by id desc limit 1;
    if snap is not null then
      select coalesce(array_agg(distinct (e ->> 'id')::uuid), '{}') into top_ids
      from jsonb_each(snap -> 'lists') l, jsonb_array_elements(l.value) e;
    else
      n := greatest(1, sl_num(cfg, '{results,top_n}', 10)::int);
      select coalesce(array_agg(x.id), '{}') into top_ids from (
        select c.id from sl_contestants c where c.is_test = p_test and c.status = 'active'
        order by c.app_total + c.adj_total + case when sl_bool(cfg, '{manual,include_in_totals}', true) then c.manual_total else 0 end desc, c.reached_at asc nulls last
        limit n) x;
    end if;
  end if;

  return query
  with base as (
    select c.id, c.name, c.gender::text g, b.name bname, c.status, c.review_status, c.manual_total,
           (c.app_total + c.adj_total + case when inc then c.manual_total else 0 end)::bigint tot,
           (select count(*) from sl_daily dd where dd.contestant_id = c.id
              and dd.app_count + dd.adj_count + case when inc then dd.manual_count else 0 end >= dmin)::int adays,
           o.mode omode
    from sl_contestants c
    left join sl_buses b on b.id = c.bus_id
    left join sl_overrides o on o.contestant_id = c.id
    where c.is_test = p_test and (p_gender = 'all' or c.gender = p_gender)
  ), calc as (
    select base.*, (case when not sh_on then (case when tot > 0 then 1 else 0 end)
                        when mx > 0 then least(mx, floor(greatest(tot, 0) / sv)) else floor(greatest(tot, 0) / sv) end)::int sh
    from base
  )
  select calc.id, calc.name, calc.g, calc.bname, calc.tot, calc.adays,
         case when calc.omode = 'include' then greatest(calc.sh, 1) else calc.sh end, coalesce(calc.omode = 'include', false)
  from calc
  where coalesce(calc.omode, '') <> 'exclude'
    and (calc.omode = 'include' or (
      calc.sh > 0
      and (not sl_bool(d, '{min_total,on}', false) or calc.tot >= sl_num(d, '{min_total,value}', 0))
      and (not sl_bool(d, '{active_days,on}', false) or calc.adays >= sl_num(d, '{active_days,days}', 1))
      and (not sl_bool(d, '{exclude_flagged}', true) or calc.review_status <> 'pending')
      and (not sl_bool(d, '{exclude_inactive}', true) or calc.status = 'active')
      and (not sl_bool(d, '{exclude_prev_winners}', true) or not exists (
            select 1 from sl_draw_winners w join sl_draw_rounds r on r.id = w.round_id
            where w.contestant_id = calc.id and w.status = 'active' and r.status = 'done' and r.is_test = p_test))
      and (not (calc.id = any(top_ids)))
      and sl_custom_ok(d -> 'custom', calc.tot, calc.adays, calc.g, calc.bname, calc.status, calc.manual_total)
    ));
end $$;

create or replace function sl_draw_preview(p_gender text default 'all', p_test boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  return (select jsonb_build_object('count', count(*), 'total_shares', coalesce(sum(shares), 0),
            'entries', coalesce(jsonb_agg(to_jsonb(e) order by e.shares desc, e.total desc), '[]'::jsonb))
          from sl_draw_eligible(p_gender, p_test) e);
end $$;

-- اختيار فائز موزون من مؤهلي الجولة (بدون من سبق اختيارهم)
create or replace function sl_pick_weighted(p_round bigint, p_exclude uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare tot bigint; ticket bigint; cid uuid;
begin
  select coalesce(sum(shares), 0) into tot from sl_draw_entries where round_id = p_round and not (contestant_id = any(p_exclude));
  if tot <= 0 then return null; end if;
  ticket := sl_rand_below(tot) + 1;   -- رقم سهم منتظم في [1، مجموع الأسهم]
  select x.contestant_id into cid from (
    select e.contestant_id, sum(e.shares) over (order by e.contestant_id) cum
    from sl_draw_entries e where e.round_id = p_round and not (e.contestant_id = any(p_exclude))
  ) x where x.cum >= ticket order by x.cum limit 1;
  return cid;
end $$;

-- تنفيذ السحب (للمشرف فقط، معاملة واحدة)
create or replace function sl_run_draw(p_name text, p_count int, p_gender text default 'all', p_test boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email(); rid bigint; cnt int; tot bigint; picked uuid[] := '{}'; cid uuid; i int; e sl_draw_entries;
begin
  perform pg_advisory_xact_lock(7700113);
  if coalesce(btrim(p_name), '') = '' then raise exception 'sl:name_required'; end if;
  if coalesce(p_count, 0) < 1 then raise exception 'sl:bad_count'; end if;
  insert into sl_draw_rounds(name, winners_count, gender, is_test, executed_by, rules)
  values (btrim(p_name), p_count, p_gender, p_test, em, jsonb_build_object('draw', sl_cfg() -> 'draw', 'gender', p_gender, 'count', p_count))
  returning id into rid;
  insert into sl_draw_entries(round_id, contestant_id, name, gender, bus_name, total, active_days, shares, forced)
  select rid, x.contestant_id, x.name, x.gender, x.bus_name, x.total, x.active_days, x.shares, x.forced from sl_draw_eligible(p_gender, p_test) x;
  select count(*), coalesce(sum(shares), 0) into cnt, tot from sl_draw_entries where round_id = rid;
  if cnt = 0 then raise exception 'sl:draw_no_eligible'; end if;
  for i in 1 .. least(p_count, cnt) loop
    cid := sl_pick_weighted(rid, picked);
    exit when cid is null;
    select * into e from sl_draw_entries where round_id = rid and contestant_id = cid;
    insert into sl_draw_winners(round_id, contestant_id, draw_order, name, gender, bus_name, shares, total)
    values (rid, cid, i, e.name, e.gender, e.bus_name, e.shares, e.total);
    picked := picked || cid;   -- تُحذف كل أسهمه: لا يفوز مرتين في الجولة
  end loop;
  update sl_draw_rounds set eligible_count = cnt, total_shares = tot where id = rid;
  perform sl_audit('run_draw', rid::text, jsonb_build_object('name', p_name, 'count', p_count, 'gender', p_gender, 'eligible', cnt, 'total_shares', tot, 'winners', array_length(picked, 1), 'test', p_test), null);
  return jsonb_build_object('round_id', rid, 'eligible', cnt, 'total_shares', tot, 'winners', array_length(picked, 1));
end $$;

-- مؤهلو جولة (لشاشة العرض والتصدير)
create or replace function sl_round_entries(p_round bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.shares desc, e.total desc) from sl_draw_entries e where e.round_id = p_round), '[]'::jsonb);
end $$;

create or replace function sl_cancel_draw(p_round bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email();
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'sl:reason_required'; end if;
  update sl_draw_rounds set status = 'cancelled', cancelled_at = now(), cancelled_by = em, cancel_reason = p_reason where id = p_round and status = 'done';
  perform sl_audit('cancel_draw', p_round::text, null, p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- استبدال فائز بسحب بديل بنفس قواعد الجولة (من لقطة مؤهليها)
create or replace function sl_replace_winner(p_winner bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email(); w sl_draw_winners; r sl_draw_rounds; ex uuid[]; cid uuid; e sl_draw_entries; nid bigint;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'sl:reason_required'; end if;
  perform pg_advisory_xact_lock(7700113);
  select * into w from sl_draw_winners where id = p_winner and status = 'active';
  if not found then raise exception 'sl:not_found'; end if;
  select * into r from sl_draw_rounds where id = w.round_id;
  if r.status <> 'done' then raise exception 'sl:draw_cancelled'; end if;
  -- يُستبعد كل من ظهر في هذه الجولة، وفائزو الجولات الأخرى إن كان الشرط مفعلاً وقتها
  select array_agg(contestant_id) into ex from sl_draw_winners where round_id = r.id;
  if sl_bool(r.rules, '{draw,exclude_prev_winners}', true) then
    ex := ex || coalesce((select array_agg(w2.contestant_id) from sl_draw_winners w2 join sl_draw_rounds r2 on r2.id = w2.round_id
                          where r2.id <> r.id and r2.status = 'done' and r2.is_test = r.is_test and w2.status = 'active'), '{}');
  end if;
  ex := ex || coalesce((select array_agg(contestant_id) from sl_overrides where mode = 'exclude'), '{}');
  cid := sl_pick_weighted(r.id, ex);
  if cid is null then raise exception 'sl:no_candidates'; end if;
  select * into e from sl_draw_entries where round_id = r.id and contestant_id = cid;
  update sl_draw_winners set status = 'replaced', replaced_reason = p_reason, replaced_at = now() where id = w.id;
  insert into sl_draw_winners(round_id, contestant_id, draw_order, name, gender, bus_name, shares, total, replacement_of)
  values (r.id, cid, (select max(draw_order) + 1 from sl_draw_winners where round_id = r.id), e.name, e.gender, e.bus_name, e.shares, e.total, w.id)
  returning id into nid;
  perform sl_audit('replace_winner', r.id::text, jsonb_build_object('old', w.name, 'new', e.name, 'winner_id', nid), p_reason);
  return jsonb_build_object('ok', true, 'winner_id', nid, 'name', e.name, 'bus', e.bus_name, 'shares', e.shares);
end $$;

create or replace function sl_admin_winner_mark(p_winner bigint, p_field text, p_value boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform sl_admin_email();
  if p_field = 'contacted' then update sl_draw_winners set contacted = p_value where id = p_winner;
  elsif p_field = 'delivered' then update sl_draw_winners set delivered = p_value where id = p_winner;
  else raise exception 'sl:bad_action'; end if;
  perform sl_audit('winner_' || p_field, p_winner::text, jsonb_build_object('value', p_value), null);
  return jsonb_build_object('ok', true);
end $$;

-- ===================== المحاكاة والتصفير =====================

-- 60 متسابقاً وهمياً (is_test) لتجربة الإحصائيات والسحب
create or replace function sl_admin_simulate() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := sl_cfg(); mn text[] := array['محمد','علي','حسن','حسين','أحمد','جعفر','عباس','مهدي','رضا','صادق','باقر','كاظم','سلمان','عيسى','موسى'];
  fn text[] := array['زينب','فاطمة','مريم','زهراء','نرجس','سكينة','رقية','خديجة','معصومة','بتول','حوراء','آمنة','ليلى','كوثر','هدى'];
  fam text[] := array['الخلف','الحسن','الموسى','العلي','الصالح','الأحمد','الناصر','الحمد','البقشي','العيسى'];
  bids bigint[] := '{}'; i int; cid uuid; g text; day0 date; nd int; k int; v int; lvl numeric; td date; b bigint;
begin
  perform sl_admin_email();
  for i in 1..4 loop bids := bids || sl_bus_id('باص تجريبي ' || i, true); end loop;
  td := sl_day(now(), cfg);
  -- أيام المحاكاة: كامل أيام المسابقة (أو 4 أيام إن لم تُجدول)
  day0 := coalesce(sl_day(sl_ts(cfg, 'start_at'), cfg), td - 3);
  nd := coalesce(sl_day(sl_ts(cfg, 'end_at') - interval '1 millisecond', cfg) - day0 + 1, td - day0 + 1);
  nd := greatest(1, least(15, nd));
  for i in 1..60 loop
    g := case when i % 2 = 0 then 'f' else 'm' end;
    b := bids[1 + (i % 4)];
    cid := null;
    insert into sl_contestants(name, phone, gender, bus_id, is_test, created_by)
    values (case when g = 'm' then mn[1 + (i % 15)] else fn[1 + (i % 15)] end || ' ' || fam[1 + ((i * 7) % 10)] || ' (' || i || ')',
            '99900' || lpad(i::text, 5, '0'), g, b, true, 'sim')
    on conflict (phone) do nothing returning id into cid;
    if cid is null then continue; end if;
    lvl := 800 + random() * 5000;
    for k in 0 .. nd - 1 loop
      if random() < 0.15 then continue; end if;
      v := (lvl * (0.4 + random()))::int;
      insert into sl_batches(batch_id, contestant_id, received_at, day_date, requested, accepted, rejected, reason, client_stats)
      values (gen_random_uuid(), cid, now() - make_interval(days => greatest(0, td - (day0 + k))), day0 + k, v + case when random() < 0.08 then (v * 0.6)::int else 0 end, v,
              case when random() < 0.08 then (v * 0.6)::int else 0 end, 'speed', '{}'::jsonb);
    end loop;
    if random() < 0.15 then
      insert into sl_manual_entries(contestant_id, day_date, count, status) values (cid, td, 100 + (random() * 400)::int, case when random() < 0.5 then 'pending' else 'approved' end);
    end if;
    perform sl_recompute(cid);
    update sl_contestants set reached_at = now() - make_interval(mins => (random() * 3000)::int), last_sync_at = now() - make_interval(mins => (random() * 600)::int),
      last_active_at = now() - make_interval(mins => (random() * 600)::int),
      review_status = case when random() < 0.06 then 'pending' else 'none' end,
      flag_reasons = case when random() < 0.06 then '["reject_ratio"]'::jsonb else '[]'::jsonb end
    where id = cid;
    update sl_contestants set flag_reasons = '["robotic"]' where id = cid and review_status = 'pending' and flag_reasons = '[]'::jsonb;
  end loop;
  perform sl_audit('simulate', null, jsonb_build_object('count', 60), null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function sl_admin_delete_test() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform sl_admin_email();
  delete from sl_contestants where is_test;
  get diagnostics n = row_count;
  delete from sl_draw_rounds where is_test;
  delete from sl_results_snapshot where is_test;
  delete from sl_buses where is_test;
  perform sl_audit('delete_test', null, jsonb_build_object('contestants', n), null);
  return jsonb_build_object('ok', true, 'deleted', n);
end $$;

-- تصفير المسابقة وحذف بياناتها لإعداد مسابقة جديدة
-- p_opts: {confirm:'حذف المسابقة', keep_contestants, keep_buses, keep_settings}
create or replace function sl_admin_reset(p_opts jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare em text := sl_admin_email(); cfg jsonb := sl_cfg(); kc boolean; kb boolean; ks boolean; summary jsonb;
begin
  if coalesce(p_opts ->> 'confirm', '') <> 'حذف المسابقة' then raise exception 'sl:confirm_mismatch'; end if;
  kc := sl_bool(p_opts, '{keep_contestants}', false);
  kb := kc or sl_bool(p_opts, '{keep_buses}', true);
  ks := sl_bool(p_opts, '{keep_settings}', true);
  summary := jsonb_build_object(
    'contestants', (select count(*) from sl_contestants where not is_test),
    'total_app', (select coalesce(sum(app_total), 0) from sl_contestants where not is_test),
    'total_manual', (select coalesce(sum(manual_total), 0) from sl_contestants where not is_test),
    'batches', (select count(*) from sl_batches), 'rounds', (select count(*) from sl_draw_rounds where not is_test),
    'keep_contestants', kc, 'keep_buses', kb, 'keep_settings', ks);

  delete from sl_draw_rounds;          -- (مع المؤهلين والفائزين)
  delete from sl_results_snapshot;
  delete from sl_overrides;
  delete from sl_batches;
  delete from sl_manual_entries;
  delete from sl_adjustments;
  delete from sl_daily;
  delete from sl_sessions;             -- تُلغى كل الجلسات: لا تصل ضغطات قديمة للمسابقة الجديدة
  delete from sl_rate_limits;
  delete from sl_contestants where is_test;
  delete from sl_buses where is_test;
  if kc then
    update sl_contestants set app_total = 0, manual_total = 0, manual_pending = 0, adj_total = 0, rejected_total = 0,
      reached_at = null, last_active_at = null, last_sync_at = null, bucket_tokens = 0, bucket_at = null,
      review_status = 'none', flag_reasons = '[]'::jsonb, review_note = null, stats = '{}'::jsonb, status = 'active',
      pin_hash = null, joined_at = now();
  else
    delete from sl_contestants;
  end if;
  if not kb then delete from sl_buses; end if;

  -- الإعدادات: الهوية والشعار تبقى دائماً، والجدولة والإعلان تُفرّغ
  if ks then
    cfg := jsonb_set(cfg, '{schedule}', coalesce(cfg -> 'schedule', '{}'::jsonb) || '{"start_at":null,"end_at":null}'::jsonb);
    cfg := jsonb_set(cfg, '{display}', coalesce(cfg -> 'display', '{}'::jsonb) || '{"announcement":""}'::jsonb);
  else
    cfg := coalesce(p_opts -> 'default_config', '{}'::jsonb) || jsonb_build_object('identity', cfg -> 'identity');
  end if;
  update sl_settings set value = cfg, updated_at = now() where key = 'config';
  update sl_settings set value = '{"mode":"draft","paused":false,"paused_at":null,"published":false,"published_at":null,"frozen_at":null}'::jsonb, updated_at = now() where key = 'state';
  update sl_public_cache set data = '{}'::jsonb, computed_at = '-infinity' where id = 1;

  delete from sl_audit_log;
  perform sl_audit('reset_competition', null, summary, p_opts ->> 'reason');
  return jsonb_build_object('ok', true, 'summary', summary);
end $$;

-- ===================== الأمان: RLS والصلاحيات =====================

do $$
declare t text;
begin
  foreach t in array array['sl_admins','sl_settings','sl_buses','sl_contestants','sl_sessions','sl_batches','sl_manual_entries',
    'sl_adjustments','sl_daily','sl_public_cache','sl_rate_limits','sl_audit_log','sl_overrides','sl_results_snapshot',
    'sl_draw_rounds','sl_draw_entries','sl_draw_winners'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists sl_admin_all on %I', t);
    -- القراءة والكتابة الكاملة للمشرف فقط (المتسابق يتعامل عبر الدوال)
    execute format('create policy sl_admin_all on %I for all to authenticated using (sl_is_admin()) with check (sl_is_admin())', t);
    execute format('revoke all on %I from anon', t);
  end loop;
end $$;

-- إغلاق كل دوال sl_ ثم فتح المطلوب فقط
do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'sl\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- دوال المتسابق (بلا تسجيل دخول)
grant execute on function sl_public_state(), sl_get_logo(), sl_lookup(text), sl_login(text, text, boolean, text),
  sl_register(text, text, text, bigint, text, boolean, text), sl_me(text), sl_logout(text),
  sl_submit_batch(text, uuid, int, jsonb), sl_add_manual(text, int), sl_is_admin()
  to anon, authenticated;

-- دوال المشرف (كل دالة تتحقق داخلياً أن البريد في sl_admins)
grant execute on function sl_admin_whoami(), sl_admin_dump(boolean), sl_admin_contestant(uuid), sl_admin_save_config(jsonb),
  sl_admin_save_logo(text), sl_admin_freeze(boolean), sl_admin_state(text), sl_admin_bus(text, bigint, text),
  sl_admin_upsert_contestant(jsonb), sl_admin_set_status(uuid, text, text), sl_admin_reset_pin(uuid),
  sl_admin_delete_contestant(uuid, text), sl_admin_adjust(uuid, int, text), sl_admin_review(uuid, text, int, text),
  sl_admin_manual(bigint, text, text), sl_admin_override(uuid, text, text), sl_admin_import(jsonb, text),
  sl_draw_preview(text, boolean), sl_run_draw(text, int, text, boolean), sl_round_entries(bigint), sl_cancel_draw(bigint, text),
  sl_replace_winner(bigint, text), sl_admin_winner_mark(bigint, text, boolean),
  sl_admin_simulate(), sl_admin_delete_test(), sl_admin_reset(jsonb)
  to authenticated;

-- تحديث مخطط واجهة PostgREST
notify pgrst, 'reload schema';
