-- 30 oct 2026
-- 1) El telefono del registro (user_metadata.phone) nunca llegaba a
--    health_history.phone. Este trigger lo copia al crear o editar la fila
--    si viene vacio. Y se rellenan las filas que ya existen.
create or replace function public.hh_phone_desde_registro()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  if coalesce(trim(new.phone), '') = '' then
    select nullif(trim(u.raw_user_meta_data->>'phone'), '') into new.phone
      from auth.users u where u.id = new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists hh_phone_desde_registro on public.health_history;
create trigger hh_phone_desde_registro before insert or update on public.health_history
  for each row execute function public.hh_phone_desde_registro();
update public.health_history h set phone = u.raw_user_meta_data->>'phone'
  from auth.users u where u.id = h.user_id and h.phone is null
  and coalesce(u.raw_user_meta_data->>'phone','') <> '';

-- 2) Aviso 15 minutos antes de la cita (funcion cita-aviso, modo "soon").
alter table public.appointments add column if not exists soon_notified_at timestamptz;
alter table public.appointments add column if not exists waiting_notified_at timestamptz;

create or replace function public.cita_inicio(d date, t text)
returns timestamptz language plpgsql stable as $$
begin
  return ((d::text || ' ' || trim(t))::timestamp) at time zone 'America/Puerto_Rico';
exception when others then return null;
end $$;

create or replace function public.avisos_cita_pronto()
returns integer language plpgsql security definer set search_path = public, extensions, net as $$
declare r record; n integer := 0;
begin
  for r in
    select a.id from public.appointments a
     where a.status = 'scheduled' and a.soon_notified_at is null
       and a.appointment_date between (now() at time zone 'America/Puerto_Rico')::date - 1
                                  and (now() at time zone 'America/Puerto_Rico')::date + 1
       and public.cita_inicio(a.appointment_date, a.appointment_time::text)
           between now() + interval '9 minutes' and now() + interval '16 minutes'
  loop
    update public.appointments set confirm_token = coalesce(confirm_token, gen_random_uuid()),
           soon_notified_at = now() where id = r.id;
    perform net.http_post(
      url := 'https://wywcvmmheuyepkxptwue.supabase.co/functions/v1/cita-aviso',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := jsonb_build_object('mode','soon','appointment_id', r.id,
              't', (select confirm_token from public.appointments where id = r.id)));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.avisos_cita_pronto() from public, anon, authenticated;

select cron.unschedule('avisos-cita-pronto') where exists (select 1 from cron.job where jobname='avisos-cita-pronto');
select cron.schedule('avisos-cita-pronto', '*/5 * * * *', 'select public.avisos_cita_pronto()');
