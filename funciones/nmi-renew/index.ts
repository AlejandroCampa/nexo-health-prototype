// ============================================================
// nmi-renew — Supabase Edge Function (programada, una vez al dia)
// Renueva las membresias que vencen cobrando la tarjeta guardada en el
// Customer Vault de NMI. Se salta las de cortesia (Comped), las canceladas
// y las que no tienen tarjeta (esas siguen pagando a mano por ATH).
//
// Si la tarjeta falla: NO se le corta el acceso ese dia. Se le manda un
// correo ("actualiza tu tarjeta") y se reintenta al dia siguiente; la app
// ya tiene su propio aviso de "vence en X dias". Un cargo fallido se
// registra en athm_orders como 'declined' para que el equipo lo vea.
//
// 31oct-1 (Dra. Marrero): la membresia es $50 cada 28 DIAS (antes 30).
//   Y la autorizacion del cron: el cron tenia el texto "<RENEW_SECRET>" en
//   vez del secreto y la funcion pedia JWT, asi que NUNCA corrio. Ahora el
//   cron manda un nonce de un solo uso (tabla cron_nonces, como el de los
//   recordatorios) y el secreto sigue valiendo si alguien lo usa a mano.
//   DEPLOY: --no-verify-jwt.
// 14oct-3: el recibo de renovacion lleva paid_until ("paid through <fecha>").
// 14oct-2: la membresia es $50 para TODOS (MEMBERSHIP_MONTHLY, una linea).
// 14oct-1: plan 'FreeFirst' (primer mes gratis con codigo) renueva a la mensual y
//   pasa a 'Basic', igual que Promo50. Si cancelo antes de vencer
//   (membership_cancelled = true) no se le cobra: el filtro de abajo lo salta.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NMI_KEY      = Deno.env.get("NMI_SECURITY_KEY") ?? "";
const NMI_URL      = Deno.env.get("NMI_API_URL") ?? "https://secure.nmi.com/api/transact.php";
const RENEW_SECRET = Deno.env.get("RENEW_SECRET") ?? "";
const NOTIFY_FN    = Deno.env.get("NOTIFY_FUNCTION") ?? "swift-responder";
const MEMBERSHIP_MONTHLY = 50;   // precio de la membresia; igual en nmi-charge, notify e index.html
const PRECIO: Record<string, number> = { Basic: MEMBERSHIP_MONTHLY, Promo50: MEMBERSHIP_MONTHLY, FreeFirst: MEMBERSHIP_MONTHLY, Comped: 0 };   // la promo / el mes gratis son solo el primer periodo
const MEMBERSHIP_DAYS = 28;      // 31oct: ciclo de 28 dias (igual en nmi-charge y athm-confirm)
const DIAS_ANTES = 1;   // se cobra el dia antes de vencer

const s = (v: unknown) => (v == null ? "" : String(v)).trim();
const json = (b: unknown, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json" } });
const ref12 = () => { const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let r = ""; for (let i = 0; i < 12; i++) r += a[Math.floor(Math.random() * a.length)]; return r; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Nonce de un solo uso que el cron inserta en cron_nonces justo antes de
// llamar. Se borra al usarlo y caduca a los 10 minutos.
async function autorizadoPorNonce(db: ReturnType<typeof createClient>, req: Request): Promise<boolean> {
  const n = req.headers.get("x-cron-nonce") || "";
  if (!UUID.test(n)) return false;
  const desde = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data, error } = await db.from("cron_nonces").delete().eq("token", n).gte("created_at", desde).select("token");
  return !error && Array.isArray(data) && data.length === 1;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const porSecreto = !!RENEW_SECRET && req.headers.get("x-renew-secret") === RENEW_SECRET;
  if (!porSecreto && !(await autorizadoPorNonce(db, req))) return json({ error: "Unauthorized" }, 401);
  if (!NMI_KEY) return json({ error: "NMI_SECURITY_KEY is not set" }, 500);

  const limite = new Date(); limite.setDate(limite.getDate() + DIAS_ANTES);
  const hoyISO = new Date().toISOString().slice(0, 10);

  const { data: vencen, error } = await db.from("health_history").select("*")
    .eq("paid", true).eq("membership_cancelled", false).neq("plan", "Comped")
    .not("card_vault_id", "is", null)
    .lte("membership_paid_until", limite.toISOString().slice(0, 10));
  if (error) return json({ error: error.message }, 500);

  const out: unknown[] = [];
  for (const hh of vencen ?? []) {
    // Un intento por dia, no uno por ejecucion.
    if (s(hh.renewal_attempted_at).slice(0, 10) === hoyISO) { out.push({ user: hh.user_id, skipped: "already tried today" }); continue; }
    const amount = PRECIO[s(hh.plan)] ?? PRECIO.Basic;
    if (!(amount > 0)) continue;
    const ref = ref12();
    await db.from("health_history").update({ renewal_attempted_at: new Date().toISOString() }).eq("id", hh.id);
    await db.from("athm_orders").insert({ ref, user_id: hh.user_id, kind: "membership", target_id: "Basic", amount, label: "Membership renewal (auto)", status: "open", processor: "nmi" });

    const body = new URLSearchParams({ security_key: NMI_KEY, type: "sale", customer_vault_id: s(hh.card_vault_id),
      amount: amount.toFixed(2), orderid: ref, order_description: "Nuvi Clinic", currency: "USD" });
    let nmi: Record<string, string> = {};
    try {
      const r = await fetch(NMI_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      for (const [k, v] of new URLSearchParams(await r.text())) nmi[k] = v;
    } catch (e) { nmi = { response: "3", responsetext: String(e) }; }

    const patient = { name: hh.full_name || hh.email, email: hh.email };
    if (nmi.response === "1") {
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      const desde = hh.membership_paid_until && new Date(hh.membership_paid_until) > hoy ? new Date(hh.membership_paid_until) : hoy;
      const hasta = new Date(desde); hasta.setDate(hasta.getDate() + MEMBERSHIP_DAYS);
      await db.from("athm_orders").update({ status: "paid", transaction_id: s(nmi.transactionid), paid_at: new Date().toISOString() }).eq("ref", ref);
      await db.from("health_history").update({ membership_paid_until: hasta.toISOString().slice(0, 10), plan: "Basic", last_renewal_at: new Date().toISOString() }).eq("id", hh.id);
      try { await fetch(`${SUPABASE_URL}/functions/v1/${NOTIFY_FN}`, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ event: "payment", patient, data: { amount: "$" + amount.toFixed(2), plan: "Basic", receipt: "NV-" + ref, date: new Date().toISOString(), renewal: true, paid_until: hasta.toISOString().slice(0, 10) } }) }); } catch (_) { /* detached */ }
      out.push({ user: hh.user_id, renewed_until: hasta.toISOString().slice(0, 10) });
    } else {
      await db.from("athm_orders").update({ status: "declined", error: s(nmi.responsetext).slice(0, 300) }).eq("ref", ref);
      try { await fetch(`${SUPABASE_URL}/functions/v1/${NOTIFY_FN}`, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ event: "card_declined", patient, data: { amount: "$" + amount.toFixed(2), until: hh.membership_paid_until, last4: hh.card_last4 || null } }) }); } catch (_) { /* detached */ }
      out.push({ user: hh.user_id, declined: s(nmi.responsetext) });
    }
  }
  return json({ ok: true, processed: out });
});
