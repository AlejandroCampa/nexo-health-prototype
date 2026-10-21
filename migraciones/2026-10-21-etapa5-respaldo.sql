-- Respaldo antes de la Etapa 5 (correr ANTES de 2026-10-21-etapa5.sql)
create schema if not exists respaldo;
revoke all on schema respaldo from public, anon, authenticated;
create table if not exists respaldo.lab_documents_20261021 as select * from public.lab_documents;
revoke all on respaldo.lab_documents_20261021 from public, anon, authenticated;
select (select count(*) from public.lab_documents) original,
       (select count(*) from respaldo.lab_documents_20261021) copia;
