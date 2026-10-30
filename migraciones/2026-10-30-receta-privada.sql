-- 30 oct 2026 (Dra. Marrero): los archivos de receta (staff/<paciente>/rx/...)
-- los ve SOLO el equipo medico. El paciente nunca, aunque alguien los "libere".
alter table public.lab_documents drop constraint if exists receta_nunca_liberada;
alter table public.lab_documents add constraint receta_nunca_liberada
  check (released_at is null or file_path !~ '^staff/[^/]+/rx/');

drop policy if exists "paciente lee sus documentos" on public.lab_documents;
create policy "paciente lee sus documentos" on public.lab_documents for select
  using (auth.uid() = user_id
         and file_path !~ '^staff/[^/]+/rx/'
         and (uploaded_by is null or uploaded_by = user_id or released_at is not null));

drop policy if exists "paciente lee lo que su medico libero" on storage.objects;
create policy "paciente lee lo que su medico libero" on storage.objects for select to authenticated
  using (bucket_id = 'lab-documents'
         and objects.name !~ '^staff/[^/]+/rx/'
         and exists (select 1 from public.lab_documents d
                      where d.file_path = objects.name and d.user_id = auth.uid()
                        and d.released_at is not null and d.deleted_at is null));
