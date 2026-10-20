-- Fase 3: duración de la cita.
-- NO correr en producción sin aprobación. Primero en el ambiente de prueba.
--
-- La evaluación inicial dura 30 minutos (ocupa dos bloques de 15 en la agenda)
-- y el seguimiento 15. El sitio guarda la duración aquí; las citas que ya
-- existen quedan en 15, que es lo que eran.
alter table public.appointments
  add column if not exists duration_minutes smallint not null default 15
  check (duration_minutes in (15, 30));
