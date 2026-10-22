-- Órdenes de referido (22 oct 2026). Pedido por la Dra. Marrero.
--
-- Solo añade una tabla nueva; no toca nada existente.
-- Un referido firmado no se cambia ni se borra; solo cambia su estado
-- (sent → completed, o se anula con cancelled).
-- El paciente ve los suyos (para llevar el PDF al especialista).

create table if not exists public.referral_orders (
  id                uuid primary key default gen_random_uuid(),
  patient_user_id   uuid not null references auth.users(id),
  author_user_id    uuid not null references auth.users(id),
  author_name       text not null,
  author_title      text,
  author_npi        text,
  author_license    text,
  specialty         text not null,
  provider_name     text,
  provider_phone    text,
  provider_fax      text,
  urgency           text not null default 'routine' check (urgency in ('routine','urgent')),
  service           text not null default 'consult' check (service in ('consult','consult_treat','testing','comanage')),
  reason            text not null,
  icd10             text[] not null default '{}',
  attachments       text[] not null default '{}',
  patient_note      text,
  status            text not null default 'sent' check (status in ('sent','completed','cancelled')),
  signed_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.referral_orders enable row level security;
create index if not exists referral_orders_patient_idx on public.referral_orders (patient_user_id, created_at desc);
create policy "referidos: personal lee" on public.referral_orders for select to authenticated using (public.is_staff());
create policy "referidos: paciente lee los suyos" on public.referral_orders for select to authenticated using (auth.uid() = patient_user_id);
create policy "referidos: medico firma" on public.referral_orders for insert to authenticated
  with check (auth.uid() = author_user_id and exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.role in ('physician','admin')));
create policy "referidos: personal cambia estado" on public.referral_orders for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create or replace function public.proteger_referido()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Los referidos no se borran; se anulan.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.signed_at := now(); new.created_at := now(); new.updated_at := now(); new.status := 'sent';
    return new;
  end if;
  if (to_jsonb(new) - array['status','updated_at']) is distinct from (to_jsonb(old) - array['status','updated_at']) then
    raise exception 'Un referido firmado no se modifica. Anúlalo y haz uno nuevo.' using errcode = 'P0001';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'Un referido anulado no se reactiva.' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger proteger_referido before insert or update or delete on public.referral_orders
  for each row execute function public.proteger_referido();
create trigger auditar after insert or update or delete on public.referral_orders
  for each row execute function public.auditar_cambio();
