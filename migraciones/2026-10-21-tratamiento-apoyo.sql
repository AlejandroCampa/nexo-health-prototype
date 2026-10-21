-- Tratamiento de apoyo (recetas de efectos secundarios y suplementos)
-- 21 oct 2026. Formato revisado por legal (confirmado por la Dra. Marrero).
--
-- Solo añade una tabla nueva; no toca nada existente. El GLP-1 sigue en su
-- propio flujo (aprobación + farmacia 503A por LifeFile).
-- Dosis e instrucciones las escribe el médico; nada viene prellenado.
-- Una receta firmada no se cambia ni se borra; se puede anular (status).

create table if not exists public.rx_apoyo (
  id               uuid primary key default gen_random_uuid(),
  patient_user_id  uuid not null references auth.users(id),
  author_user_id   uuid not null references auth.users(id),
  author_name      text not null,
  author_title     text,
  author_npi       text,
  author_license   text,
  items            jsonb not null,          -- [{name, purpose, sig, qty, refills}]
  pharmacy         text,
  allergies        text,                    -- copia de lo registrado al firmar
  include_in_plan  boolean not null default true,
  status           text not null default 'active' check (status in ('active','cancelled')),
  signed_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.rx_apoyo enable row level security;
create index if not exists rx_apoyo_patient_idx on public.rx_apoyo (patient_user_id, created_at desc);
create policy "rx_apoyo: personal lee" on public.rx_apoyo for select to authenticated using (public.is_staff());
create policy "rx_apoyo: paciente lee las suyas" on public.rx_apoyo for select to authenticated using (auth.uid() = patient_user_id);
create policy "rx_apoyo: medico firma" on public.rx_apoyo for insert to authenticated
  with check (auth.uid() = author_user_id and exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.role in ('physician','admin')));
create policy "rx_apoyo: medico anula" on public.rx_apoyo for update to authenticated
  using (exists (select 1 from public.staff s where s.user_id = auth.uid() and s.role in ('physician','admin')))
  with check (exists (select 1 from public.staff s where s.user_id = auth.uid() and s.role in ('physician','admin')));

create or replace function public.proteger_rx_apoyo()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Las recetas no se borran; se anulan.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.signed_at := now(); new.created_at := now(); new.updated_at := now(); new.status := 'active';
    return new;
  end if;
  if (to_jsonb(new) - array['status','updated_at']) is distinct from (to_jsonb(old) - array['status','updated_at']) then
    raise exception 'Una receta firmada no se modifica. Anúlala y haz una nueva.' using errcode = 'P0001';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'Una receta anulada no se reactiva.' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger proteger_rx_apoyo before insert or update or delete on public.rx_apoyo
  for each row execute function public.proteger_rx_apoyo();
create trigger auditar after insert or update or delete on public.rx_apoyo
  for each row execute function public.auditar_cambio();
