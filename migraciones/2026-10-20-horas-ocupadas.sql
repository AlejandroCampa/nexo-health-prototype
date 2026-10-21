-- Seguridad: las citas de los pacientes ya no se pueden leer sin permiso.
-- ORDEN EN PRODUCCIÓN:
--   1) Correr la PARTE 1 (es segura: solo añade una función).
--   2) Publicar la página nueva, que ya usa esa función.
--   3) Correr la PARTE 2 (cierra el acceso abierto).
-- Si se corre la parte 2 antes de publicar la página, el calendario mostraría
-- todas las horas libres y se podrían duplicar citas.

-- PARTE 1
create or replace function public.np_interview_busy_slots(p_date date)
returns table (appointment_time text, np_user_id uuid, duration_minutes smallint)
language sql stable security definer set search_path = public as $$
  select a.appointment_time, a.np_user_id, a.duration_minutes
    from public.appointments a
   where a.type = 'np_interview'
     and a.appointment_date = p_date
     and a.status <> 'cancelled'
     and auth.uid() is not null;
$$;
revoke all on function public.np_interview_busy_slots(date) from public, anon;
grant execute on function public.np_interview_busy_slots(date) to authenticated;

-- PARTE 2
drop policy if exists "Authenticated users can check NP interview availability" on public.appointments;
