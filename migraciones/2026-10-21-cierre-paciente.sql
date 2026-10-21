-- Lo que un paciente NO puede cambiar desde su sesión (Etapa 6, 21 oct 2026)
--
-- Encontrado en la prueba completa (intentos de un paciente desde su sesión):
--  1. Citas: el paciente podía cambiar la fecha, la hora, el estado, el médico
--     y hasta el dueño de su propia cita. Ya no hay ningún botón que lo haga
--     (la cita la mueve el equipo), así que en la base se cierra: un paciente
--     no actualiza citas. Las confirmaciones por correo y los recordatorios
--     los hace el servidor, que no pasa por esta regla.
--  2. Expediente (health_history): el paciente podía escribir
--     submitted_to_pharmacy, lifefile_patient_ref, cancelled_by_staff y
--     medication_autopay_status. Son del equipo y del servidor. Se congelan
--     para el paciente; el personal y el servidor siguen igual.
--
-- No borra nada ni cambia reglas existentes: solo añade dos triggers.
-- Para deshacer:
--   drop trigger if exists paciente_no_mueve_citas on public.appointments;
--   drop trigger if exists paciente_no_toca_farmacia on public.health_history;

create or replace function public.paciente_no_mueve_citas()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null
     or public.is_staff() then
    return new;
  end if;
  raise exception 'Para cambiar o cancelar tu cita, escríbele a tu equipo médico.' using errcode = 'P0001';
end $$;
create trigger paciente_no_mueve_citas before update on public.appointments
  for each row execute function public.paciente_no_mueve_citas();

create or replace function public.paciente_no_toca_farmacia()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null
     or public.is_staff() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.submitted_to_pharmacy := false; new.submitted_to_pharmacy_at := null;
    new.lifefile_patient_ref := null; new.cancelled_by_staff := false;
    new.medication_autopay_status := null;
    new.membership_paid_until := null; new.card_vault_id := null; new.card_last4 := null;
    return new;
  end if;
  new.submitted_to_pharmacy     := old.submitted_to_pharmacy;
  new.submitted_to_pharmacy_at  := old.submitted_to_pharmacy_at;
  new.lifefile_patient_ref      := old.lifefile_patient_ref;
  new.cancelled_by_staff        := old.cancelled_by_staff;
  new.medication_autopay_status := old.medication_autopay_status;
  new.membership_paid_until     := old.membership_paid_until;
  new.card_vault_id             := old.card_vault_id;
  new.card_last4                := old.card_last4;
  new.last_renewal_at           := old.last_renewal_at;
  new.renewal_attempted_at      := old.renewal_attempted_at;
  return new;
end $$;
create trigger paciente_no_toca_farmacia before insert or update on public.health_history
  for each row execute function public.paciente_no_toca_farmacia();

revoke all on function public.paciente_no_mueve_citas() from public, anon, authenticated;
revoke all on function public.paciente_no_toca_farmacia() from public, anon, authenticated;
