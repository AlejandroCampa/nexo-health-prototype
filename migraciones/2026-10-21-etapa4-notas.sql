-- Etapa 4: plantillas de notas y notas firmadas protegidas (21 oct 2026)
--
-- ORDEN EN PRODUCCION:
--   1. Correr PRIMERO 2026-10-21-etapa4-respaldo.sql (copia de las notas).
--   2. Correr este archivo.
--   3. Publicar la web nueva.
-- La web que ya esta en vivo sigue funcionando con este cambio (solo se
-- añaden columnas; nada se borra ni se renombra).
--
-- Que hace:
--   * Columnas nuevas en medical_records:
--       template          'initial' | 'glp1_followup' | 'free' | 'addendum'
--       template_version  version de la plantilla con que se escribio
--       content           los campos de la plantilla (jsonb)
--       cosigner_npi / cosigner_license
--                         la web ya intentaba guardarlas al co-firmar y no
--                         existian: la co-firma fallaba.
--   * Proteccion en la base (no depende de la web):
--       - Una nota firmada no se modifica. Lo unico que se le puede añadir
--         es la co-firma, una sola vez.
--       - Una nota firmada no se puede "desfirmar".
--       - La fecha y hora de firma las pone el servidor, no el navegador.
--       - Un borrador solo lo edita quien lo escribio.
--       - Las notas no se borran. Nunca.
--       - Una adenda solo puede apuntar a una nota firmada.
--
-- Para deshacer: 2026-10-21-etapa4-deshacer.sql

alter table public.medical_records
  add column if not exists template text,
  add column if not exists template_version integer,
  add column if not exists content jsonb,
  add column if not exists cosigner_npi text,
  add column if not exists cosigner_license text;

create or replace function public.proteger_nota_clinica()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  campos_cofirma text[] := array['cosigned_by','cosigned_by_name','cosigned_at',
                                 'cosigner_npi','cosigner_license','updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Las notas clínicas no se borran.' using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.signed then
      new.signed_at := now();
    end if;
    if new.amends_record_id is not null and not exists (
         select 1 from public.medical_records m
         where m.id = new.amends_record_id and m.signed) then
      raise exception 'Una adenda solo puede añadirse a una nota firmada.' using errcode = 'P0001';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE
  if old.signed then
    if new.signed is distinct from true then
      raise exception 'Una nota firmada no se puede desfirmar.' using errcode = 'P0001';
    end if;
    if (to_jsonb(new) - campos_cofirma) is distinct from (to_jsonb(old) - campos_cofirma) then
      raise exception 'Una nota firmada no se puede modificar. Añade una adenda.' using errcode = 'P0001';
    end if;
    if old.cosigned_at is not null and (
         new.cosigned_at is distinct from old.cosigned_at
      or new.cosigned_by is distinct from old.cosigned_by
      or new.cosigned_by_name is distinct from old.cosigned_by_name
      or new.cosigner_npi is distinct from old.cosigner_npi
      or new.cosigner_license is distinct from old.cosigner_license) then
      raise exception 'Esta nota ya está co-firmada.' using errcode = 'P0001';
    end if;
    if old.cosigned_at is null and new.cosigned_at is not null then
      new.cosigned_at := now();
      if auth.uid() is not null then
        new.cosigned_by := auth.uid();
      end if;
    end if;
  else
    -- Borrador: solo su autor (desde la web). Desde el SQL Editor auth.uid()
    -- es null y se permite mantenimiento.
    if auth.uid() is not null and auth.uid() is distinct from old.author_user_id then
      raise exception 'Solo quien escribió el borrador puede editarlo.' using errcode = 'P0001';
    end if;
    if new.author_user_id is distinct from old.author_user_id
       or new.patient_user_id is distinct from old.patient_user_id then
      raise exception 'No se puede cambiar el autor ni el paciente de una nota.' using errcode = 'P0001';
    end if;
    if new.signed then
      new.signed_at := now();
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists proteger_nota_clinica on public.medical_records;
create trigger proteger_nota_clinica
  before insert or update or delete on public.medical_records
  for each row execute function public.proteger_nota_clinica();

create index if not exists medical_records_patient_idx
  on public.medical_records (patient_user_id, encounter_date desc);
