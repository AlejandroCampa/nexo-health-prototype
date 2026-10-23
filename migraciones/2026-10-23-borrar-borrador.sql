-- Permite borrar un BORRADOR de nota clínica (sin firmar) por su propio autor.
-- Las notas firmadas siguen protegidas: no se borran ni se modifican.
-- El borrado queda registrado en la auditoría (trigger "auditar").
-- Para deshacer: 2026-10-23-borrar-borrador-deshacer.sql

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
    -- Solo se borra un BORRADOR (sin firmar), y solo su autor desde la web.
    -- Las notas firmadas nunca se borran: se corrigen con una adenda.
    if old.signed then
      raise exception 'Una nota firmada no se borra. Añade una adenda.' using errcode = 'P0001';
    end if;
    if auth.uid() is not null and auth.uid() is distinct from old.author_user_id then
      raise exception 'Solo quien escribió el borrador puede borrarlo.' using errcode = 'P0001';
    end if;
    return old;
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


drop policy if exists "Author deletes own unsigned record" on public.medical_records;
create policy "Author deletes own unsigned record" on public.medical_records
  for delete using (is_staff() and auth.uid() = author_user_id and signed = false);
