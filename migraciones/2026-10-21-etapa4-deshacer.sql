-- Deshacer la Etapa 4 (solo si algo salio mal)
--
-- PARTE 1 — quita la proteccion. Las columnas nuevas se quedan (no molestan
-- a la web vieja y no se pierde lo que se haya escrito en ellas).
drop trigger if exists proteger_nota_clinica on public.medical_records;
drop function if exists public.proteger_nota_clinica();

-- PARTE 2 — SOLO si las notas que existian se dañaron. Devuelve cada nota
-- del respaldo a como estaba. Las notas nuevas (escritas despues del
-- respaldo) no se tocan.
-- update public.medical_records m set
--   patient_user_id = r.patient_user_id, author_user_id = r.author_user_id,
--   author_name = r.author_name, author_role = r.author_role,
--   encounter_date = r.encounter_date, encounter_type = r.encounter_type,
--   subjective = r.subjective, objective = r.objective,
--   assessment = r.assessment, plan = r.plan, weight_lbs = r.weight_lbs,
--   blood_pressure = r.blood_pressure, heart_rate = r.heart_rate,
--   signed = r.signed, signed_at = r.signed_at, created_at = r.created_at,
--   updated_at = r.updated_at, encounter_time = r.encounter_time,
--   requires_cosign = r.requires_cosign, cosigned_by = r.cosigned_by,
--   cosigned_by_name = r.cosigned_by_name, cosigned_at = r.cosigned_at,
--   author_npi = r.author_npi, author_license = r.author_license,
--   amends_record_id = r.amends_record_id
-- from respaldo.medical_records_20261021 r where r.id = m.id;
-- insert into public.medical_records
--   select r.*, null, null, null, null, null
--   from respaldo.medical_records_20261021 r
--   where not exists (select 1 from public.medical_records m where m.id = r.id);
