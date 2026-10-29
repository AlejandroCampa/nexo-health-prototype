alter table public.health_history drop column if exists intake_pending;
alter table public.health_history drop column if exists added_by_staff;
drop function if exists public.staff_buscar_usuario_por_email(text);
