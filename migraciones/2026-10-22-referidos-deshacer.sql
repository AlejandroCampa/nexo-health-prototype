-- Deshacer órdenes de referido. Solo si la tabla está vacía o ya no hace falta.
-- (Correrlo a mano en el SQL Editor: contiene DROP.)
drop table if exists public.referral_orders;
drop function if exists public.proteger_referido();
