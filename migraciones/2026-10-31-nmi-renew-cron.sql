-- 31 oct 2026: el cron de renovaciones tenia "<RENEW_SECRET>" literal y la
-- funcion pedia JWT, asi que nunca cobro. Ahora usa un nonce de un solo uso.
-- Membresia: $50 cada 28 dias (nmi-renew, nmi-charge, athm-confirm).
select cron.unschedule('nmi-renew');
select cron.schedule('nmi-renew', '0 10 * * *', $c$
  with n as (insert into cron_nonces default values returning token)
  select net.http_post(
    url     := 'https://wywcvmmheuyepkxptwue.supabase.co/functions/v1/nmi-renew',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-nonce',(select token::text from n)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$c$);
