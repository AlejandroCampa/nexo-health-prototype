-- 2026-10-29: el medico anade un paciente sin que se registre ni pague.
-- La Edge Function staff-add-patient crea la cuenta (sin contrasena: entra
-- con el codigo por email), pone el email en comped_emails y crea su fila
-- de health_history con intake_pending = true. Al entrar, el paciente ve
-- "Complete your health history"; al guardarlo, intake_pending pasa a false.
alter table public.health_history add column if not exists intake_pending boolean not null default false;
alter table public.health_history add column if not exists added_by_staff uuid;

-- Buscar una cuenta por email (solo la usa la Edge Function con la service key).
create or replace function public.staff_buscar_usuario_por_email(p_email text)
returns uuid language sql stable security definer set search_path = public, auth, pg_temp as $$
  select id from auth.users where lower(email) = lower(btrim(p_email)) limit 1
$$;
revoke all on function public.staff_buscar_usuario_por_email(text) from public, anon, authenticated;
grant execute on function public.staff_buscar_usuario_por_email(text) to service_role;

-- El paciente marca su historial como completo al guardarlo.
grant update (intake_pending) on public.health_history to authenticated;
