-- Dosis de mantenimiento establecida (22 oct 2026, Dra. Marrero).
-- Solo con esto (y membresía pagada) el paciente ve "Request a new prescription".
-- Lo marca el médico desde el expediente; el paciente no lo puede cambiar.
alter table public.health_history
  add column if not exists maintenance_established boolean not null default false,
  add column if not exists maintenance_set_at timestamptz,
  add column if not exists maintenance_set_by uuid;

create or replace function public.paciente_no_toca_farmacia()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null
     or public.is_staff() then
    if tg_op = 'UPDATE' and new.maintenance_established is distinct from old.maintenance_established then
      new.maintenance_set_at := now(); new.maintenance_set_by := auth.uid();
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.submitted_to_pharmacy := false; new.submitted_to_pharmacy_at := null;
    new.lifefile_patient_ref := null; new.cancelled_by_staff := false;
    new.medication_autopay_status := null;
    new.membership_paid_until := null; new.card_vault_id := null; new.card_last4 := null;
    new.maintenance_established := false; new.maintenance_set_at := null; new.maintenance_set_by := null;
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
  new.maintenance_established   := old.maintenance_established;
  new.maintenance_set_at        := old.maintenance_set_at;
  new.maintenance_set_by        := old.maintenance_set_by;
  return new;
end $$;
revoke all on function public.paciente_no_toca_farmacia() from public, anon, authenticated;
-- Producción usa permisos por columna: el personal necesita esto para marcarlo.
-- (El trigger impide que un paciente lo cambie.)
grant update (maintenance_established) on public.health_history to authenticated;
