-- Etapa 5: órdenes de labs, labs que sube el médico (ocultos hasta liberarlos)
-- y registro de auditoría (21 oct 2026)
--
-- ORDEN EN PRODUCCION:
--   1. 2026-10-21-etapa5-respaldo.sql (copia de lab_documents)
--   2. Este archivo.
--   3. Publicar la web nueva.
-- La web que está en vivo sigue funcionando con este cambio: el paciente
-- sigue viendo y subiendo sus documentos igual que hoy.
--
-- Nada aquí se borra ni se renombra. Las reglas que se cambian se cambian
-- con ALTER POLICY (mismo nombre, condición nueva).
-- Para deshacer: 2026-10-21-etapa5-deshacer.sql

------------------------------------------------------------------------
-- 1. Órdenes de laboratorio
------------------------------------------------------------------------
create table if not exists public.lab_orders (
  id               uuid primary key default gen_random_uuid(),
  patient_user_id  uuid not null references auth.users(id),
  author_user_id   uuid not null references auth.users(id),
  author_name      text not null,
  author_title     text,
  author_npi       text,
  author_license   text,
  tests            jsonb not null default '[]'::jsonb,   -- [{name, cpt}]
  other_test       text,
  icd10            text[] not null default array['Z79.899 Other long term (current) drug therapy'],
  fasting          text check (fasting in ('fasting','non_fasting')),
  patient_note     text,
  status           text not null default 'sent' check (status in ('sent','results_received','cancelled')),
  signed_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.lab_orders enable row level security;
create index if not exists lab_orders_patient_idx on public.lab_orders (patient_user_id, created_at desc);

create policy "lab_orders: personal lee" on public.lab_orders
  for select to authenticated using (public.is_staff());
create policy "lab_orders: paciente lee las suyas" on public.lab_orders
  for select to authenticated using (auth.uid() = patient_user_id);
create policy "lab_orders: medico firma" on public.lab_orders
  for insert to authenticated with check (public.is_staff() and auth.uid() = author_user_id);
create policy "lab_orders: personal cambia estado" on public.lab_orders
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- Una orden firmada no cambia: solo su estado. Y no se borra.
create or replace function public.proteger_orden_labs()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Las órdenes de laboratorio no se borran.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.signed_at := now(); new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  if (to_jsonb(new) - array['status','updated_at']) is distinct from (to_jsonb(old) - array['status','updated_at']) then
    raise exception 'Una orden firmada no se modifica. Haz una orden nueva.' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger proteger_orden_labs before insert or update or delete on public.lab_orders
  for each row execute function public.proteger_orden_labs();

------------------------------------------------------------------------
-- 2. lab_documents: el médico también sube, y el paciente no lo ve
--    hasta que el médico lo libera.
------------------------------------------------------------------------
alter table public.lab_documents
  add column if not exists uploaded_by  uuid,          -- null = lo subió el paciente (todo lo de antes)
  add column if not exists released_at  timestamptz,   -- cuándo se liberó al paciente (solo lo que sube el médico)
  add column if not exists released_by  uuid,
  add column if not exists reviewed_at  timestamptz,
  add column if not exists reviewed_by  uuid,
  add column if not exists reviewed_by_name text,
  add column if not exists staff_note   text,          -- nota para el paciente al liberar
  add column if not exists lab_order_id uuid references public.lab_orders(id);

-- El paciente ve lo suyo, más lo que el médico ya liberó.
alter policy "paciente lee sus documentos" on public.lab_documents
  using (auth.uid() = user_id
         and (uploaded_by is null or uploaded_by = user_id or released_at is not null));

create policy "staff sube documentos al paciente" on public.lab_documents
  for insert to authenticated with check (public.is_staff() and uploaded_by = auth.uid());
create policy "staff revisa y libera documentos" on public.lab_documents
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- Quién puede cambiar qué, en la base y no en la página:
--  * el paciente solo puede retirar (deleted_at) lo que él subió;
--  * el personal puede revisar, liberar y anotar, pero no cambiar el archivo.
create or replace function public.proteger_documento_lab()
returns trigger language plpgsql set search_path = public as $$
declare
  staff boolean := public.is_staff();
begin
  if tg_op = 'INSERT' then
    if not staff then
      new.uploaded_by := null; new.released_at := null; new.released_by := null;
      new.reviewed_at := null; new.reviewed_by := null; new.reviewed_by_name := null; new.staff_note := null;
    else
      new.uploaded_by := auth.uid();
      if new.released_at is not null then new.released_at := now(); new.released_by := auth.uid(); end if;
    end if;
    return new;
  end if;
  if new.user_id is distinct from old.user_id or new.file_path is distinct from old.file_path
     or new.uploaded_by is distinct from old.uploaded_by or new.uploaded_at is distinct from old.uploaded_at then
    raise exception 'No se puede cambiar el archivo ni el dueño de un documento.' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and not staff then
    if (to_jsonb(new) - 'deleted_at') is distinct from (to_jsonb(old) - 'deleted_at') then
      raise exception 'Solo puedes retirar tus documentos.' using errcode = 'P0001';
    end if;
    if old.uploaded_by is not null and old.uploaded_by <> old.user_id then
      raise exception 'Este documento lo compartió tu médico; no se puede retirar.' using errcode = 'P0001';
    end if;
  end if;
  if old.released_at is null and new.released_at is not null then
    new.released_at := now(); new.released_by := auth.uid();
  end if;
  if old.released_at is not null and new.released_at is null then
    raise exception 'Un documento ya compartido con el paciente no se puede volver a ocultar.' using errcode = 'P0001';
  end if;
  if old.reviewed_at is null and new.reviewed_at is not null then
    new.reviewed_at := now(); new.reviewed_by := auth.uid();
  end if;
  return new;
end $$;
create trigger proteger_documento_lab before insert or update on public.lab_documents
  for each row execute function public.proteger_documento_lab();

-- Archivos: el médico sube en staff/<paciente>/..., y el paciente solo
-- puede abrir ese archivo cuando el documento está liberado.
create policy "staff sube labs del paciente" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lab-documents' and public.is_staff() and (storage.foldername(name))[1] = 'staff');
create policy "paciente lee lo que su medico libero" on storage.objects
  for select to authenticated
  using (bucket_id = 'lab-documents' and exists (
    select 1 from public.lab_documents d
    where d.file_path = name and d.user_id = auth.uid()
      and d.released_at is not null and d.deleted_at is null));

------------------------------------------------------------------------
-- 3. Registro de auditoría: quién abrió o cambió qué, y cuándo.
--    Solo se añade; no se edita ni se borra. Lo leen médicos y admin.
--    Guarda QUÉ columnas cambiaron, no sus valores (no copia PHI).
------------------------------------------------------------------------
create table if not exists public.audit_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  actor_user_id   uuid,            -- null = el sistema (pagos, tareas programadas)
  actor_name      text,
  action          text not null,   -- insert | update | delete | open_chart | open_document | print_note | print_order ...
  table_name      text,
  record_id       text,
  patient_user_id uuid,
  detail          jsonb
);
alter table public.audit_log enable row level security;
create index if not exists audit_log_patient_idx on public.audit_log (patient_user_id, at desc);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create policy "auditoria: medicos y admin leen" on public.audit_log
  for select to authenticated using (exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.role in ('physician','admin')));
-- Sin políticas de insert/update/delete: nadie escribe directo desde la web.

create or replace function public.auditar_cambio()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fila jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  antes jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  cambiadas text[];
  paciente uuid;
begin
  begin
    paciente := coalesce(
      nullif(fila->>'patient_user_id','')::uuid,
      case when tg_table_name in ('health_history','appointments','lab_documents','prescriptions')
           then nullif(fila->>'user_id','')::uuid end);
    if tg_op = 'UPDATE' then
      select array_agg(k order by k) into cambiadas
      from jsonb_object_keys(fila) k
      where k not in ('updated_at') and (fila->k) is distinct from (antes->k);
      if cambiadas is null then return null; end if;
    end if;
    insert into public.audit_log (actor_user_id, actor_name, action, table_name, record_id, patient_user_id, detail)
    values (auth.uid(),
            (select s.full_name from public.staff s where s.user_id = auth.uid()),
            lower(tg_op), tg_table_name, fila->>'id', paciente,
            case when cambiadas is not null then jsonb_build_object('columns', to_jsonb(cambiadas)) end);
  exception when others then
    -- La auditoría nunca debe frenar una operación clínica ni un pago.
    raise warning 'auditar_cambio: %', sqlerrm;
  end;
  return null;
end $$;

create trigger auditar after insert or update or delete on public.medical_records for each row execute function public.auditar_cambio();
create trigger auditar after insert or update or delete on public.lab_documents   for each row execute function public.auditar_cambio();
create trigger auditar after insert or update or delete on public.lab_orders      for each row execute function public.auditar_cambio();
create trigger auditar after insert or update or delete on public.prescriptions   for each row execute function public.auditar_cambio();
create trigger auditar after insert or update or delete on public.health_history  for each row execute function public.auditar_cambio();
create trigger auditar after insert or update or delete on public.appointments    for each row execute function public.auditar_cambio();

-- Accesos (abrir un expediente, abrir un documento, imprimir): la web los
-- reporta con esta función. Solo personal; el actor es siempre quien llama.
create or replace function public.registrar_acceso(p_patient uuid, p_accion text, p_registro text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.staff s where s.user_id = auth.uid()) then
    return;
  end if;
  if p_accion not in ('open_chart','open_document','print_note','print_order','view_note') then
    return;
  end if;
  insert into public.audit_log (actor_user_id, actor_name, action, record_id, patient_user_id)
  values (auth.uid(), (select s.full_name from public.staff s where s.user_id = auth.uid()),
          p_accion, left(p_registro, 64), p_patient);
end $$;
revoke all on function public.registrar_acceso(uuid, text, text) from public, anon;
grant execute on function public.registrar_acceso(uuid, text, text) to authenticated;
revoke all on function public.auditar_cambio() from public, anon, authenticated;
