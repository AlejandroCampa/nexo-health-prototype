-- Respaldo antes de la Etapa 4 (correr ANTES de 2026-10-21-etapa4-notas.sql)
--
-- Copia la tabla de notas a un esquema "respaldo" que la web NO puede leer
-- (ni pacientes ni personal: solo el dueño del proyecto desde el panel).
-- Los datos no salen de Supabase.

create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;

create table if not exists respaldo.medical_records_20261021 as
  select * from public.medical_records;

revoke all on respaldo.medical_records_20261021 from public, anon, authenticated;

-- Verificacion: los dos numeros tienen que ser iguales.
select (select count(*) from public.medical_records)           as original,
       (select count(*) from respaldo.medical_records_20261021) as copia;
