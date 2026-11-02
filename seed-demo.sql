-- =====================================================================
--  بيانات تجريبية اختيارية: 3 باصات و8 متسابقين ومسابقة 4 أيام تبدأ اليوم
--  شغّله بعد schema.sql إذا أردت تجربة كل الشاشات على Supabase.
--  للتخلص منها لاحقاً: لوحة المشرف → الإعدادات → «تصفير المسابقة وحذف بياناتها».
--  أرقام الدخول: 0500000001 … 0500000008
-- =====================================================================

insert into sl_buses(name, sort) values ('باص 1', 1), ('باص 2', 2), ('باص 3', 3) on conflict do nothing;

insert into sl_contestants(name, phone, gender, bus_id, created_by)
select v.name, v.phone, v.g, (select id from sl_buses where name = v.bus and not is_test), 'seed'
from (values
  ('عيسى الخلف',   '966500000001', 'm', 'باص 1'),
  ('حسن الموسى',   '966500000002', 'm', 'باص 1'),
  ('محمد العلي',   '966500000003', 'm', 'باص 2'),
  ('جعفر الصالح',  '966500000004', 'm', 'باص 3'),
  ('زينب الحسن',   '966500000005', 'f', 'باص 1'),
  ('فاطمة الأحمد', '966500000006', 'f', 'باص 2'),
  ('مريم الناصر',  '966500000007', 'f', 'باص 2'),
  ('زهراء البقشي', '966500000008', 'f', 'باص 3')
) v(name, phone, g, bus)
on conflict (phone) do nothing;

-- مسابقة 4 أيام تبدأ من منتصف ليل اليوم بتوقيت الرياض، مع إظهار كل البطاقات للتجربة
update sl_settings set value = value
  || jsonb_build_object('schedule', coalesce(value -> 'schedule', '{}'::jsonb) || jsonb_build_object(
       'start_at', (date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh'),
       'end_at',   (date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh') + interval '4 days'))
  || jsonb_build_object('display', coalesce(value -> 'display', '{}'::jsonb) || '{"show_bus_ranking":true,"show_gender":true,"show_shares":true,"campaign_goal":100000,"announcement":"الباص 2 متصدر حتى الآن! استمروا 🌿"}'::jsonb)
where key = 'config';
update sl_settings set value = value || '{"mode":"auto","paused":false}'::jsonb where key = 'state';
update sl_public_cache set computed_at = '-infinity' where id = 1;
