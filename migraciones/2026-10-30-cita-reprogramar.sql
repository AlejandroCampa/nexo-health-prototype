-- 2026-10-30: el paciente puede pedir reprogramar desde el correo (sin cancelar).
-- Aplicada en nuvi-pruebas y TelemedProject.
alter table public.appointments add column if not exists reschedule_requested_at timestamptz;
alter table public.appointments add column if not exists reschedule_note text;
