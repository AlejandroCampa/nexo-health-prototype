-- 31 oct 2026 (Dra. Marrero): check-in semanal del paciente en "Progress":
-- peso y medidas, dosis aplicada, sintomas y habitos. Una fila por semana.
create table if not exists public.weekly_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_date date not null,                 -- lunes de la semana (hora PR)
  weight_lbs numeric check (weight_lbs is null or weight_lbs between 50 and 1000),
  waist_in numeric check (waist_in is null or waist_in between 15 and 90),
  hip_in numeric check (hip_in is null or hip_in between 15 and 90),
  dose_taken boolean,
  dose_date date,
  dose_mg numeric check (dose_mg is null or dose_mg between 0 and 100),
  injection_site text check (injection_site is null or injection_site in ('abdomen','thigh','arm','other')),
  nausea smallint check (nausea is null or nausea between 0 and 5),
  appetite smallint check (appetite is null or appetite between 1 and 5),
  energy smallint check (energy is null or energy between 1 and 5),
  side_effects text[] not null default '{}',
  water_cups smallint check (water_cups is null or water_cups between 0 and 40),
  protein_g smallint check (protein_g is null or protein_g between 0 and 400),
  exercise_min smallint check (exercise_min is null or exercise_min between 0 and 3000),
  sleep_hours numeric check (sleep_hours is null or sleep_hours between 0 and 16),
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_date)
);
alter table public.weekly_checkins enable row level security;
drop policy if exists "paciente lee sus checkins" on public.weekly_checkins;
create policy "paciente lee sus checkins" on public.weekly_checkins for select using (auth.uid() = user_id);
drop policy if exists "paciente crea sus checkins" on public.weekly_checkins;
create policy "paciente crea sus checkins" on public.weekly_checkins for insert with check (auth.uid() = user_id);
drop policy if exists "paciente edita sus checkins" on public.weekly_checkins;
create policy "paciente edita sus checkins" on public.weekly_checkins for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "staff lee checkins" on public.weekly_checkins;
create policy "staff lee checkins" on public.weekly_checkins for select to authenticated using (public.is_staff());
grant select, insert, update on public.weekly_checkins to authenticated;

-- El texto del tracker dice "tu equipo medico tambien lo ve": ahora es verdad.
drop policy if exists "staff lee pesadas" on public.weight_logs;
create policy "staff lee pesadas" on public.weight_logs for select to authenticated using (public.is_staff());
