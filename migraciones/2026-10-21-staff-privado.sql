-- Los pacientes ya no ven los datos de los médicos (21 oct 2026)
--
-- Antes: una regla dejaba a CUALQUIER usuario con sesión (pacientes
-- incluidos) leer toda la tabla staff: NPI, licencias, correos, etc.
-- Ahora:
--   * El personal sigue leyendo la tabla completa (reglas que ya existen).
--   * Cada quien sigue leyendo su propia fila (regla que ya existe).
--   * Los pacientes solo reciben, por la función staff_directorio(), lo que
--     necesitan para ver a su médico: id, rol, nombre, título y foto.
--
-- Orden: publicar primero la web que usa staff_directorio() (si no, el
-- calendario del paciente no encuentra médicos) y luego correr esto. En
-- realidad la web nueva funciona con o sin este cambio.
--
-- Para deshacer:
--   create policy "authenticated read staff" on public.staff
--     for select to authenticated using (true);
--   drop function public.staff_directorio();

create or replace function public.staff_directorio()
returns table (user_id uuid, role text, full_name text, title text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  select s.user_id, s.role, s.full_name, s.title, s.avatar_url
  from public.staff s
  where auth.uid() is not null;
$$;

revoke all on function public.staff_directorio() from public;
revoke all on function public.staff_directorio() from anon;
grant execute on function public.staff_directorio() to authenticated;

drop policy if exists "authenticated read staff" on public.staff;
