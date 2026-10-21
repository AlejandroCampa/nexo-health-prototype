-- Deshacer la Etapa 5 (solo si algo salió mal). Correr en el SQL Editor.
-- Las tablas nuevas (lab_orders, audit_log) y las columnas nuevas se quedan:
-- no molestan a la web vieja y no se pierde lo que se haya escrito.
drop trigger if exists auditar on public.medical_records;
drop trigger if exists auditar on public.lab_documents;
drop trigger if exists auditar on public.lab_orders;
drop trigger if exists auditar on public.prescriptions;
drop trigger if exists auditar on public.health_history;
drop trigger if exists auditar on public.appointments;
drop trigger if exists proteger_documento_lab on public.lab_documents;
drop policy if exists "staff sube labs del paciente" on storage.objects;
drop policy if exists "paciente lee lo que su medico libero" on storage.objects;
drop policy if exists "staff sube documentos al paciente" on public.lab_documents;
drop policy if exists "staff revisa y libera documentos" on public.lab_documents;
alter policy "paciente lee sus documentos" on public.lab_documents using (auth.uid() = user_id);
