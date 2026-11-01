-- 31 oct 2026 (Dra. Marrero): agua y proteina en el check-in son Si / No.
alter table public.weekly_checkins add column if not exists water_ok boolean;
alter table public.weekly_checkins add column if not exists protein_ok boolean;
