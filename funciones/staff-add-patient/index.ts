// ============================================================
// staff-add-patient — Supabase Edge Function (29 oct 2026)
// Un MEDICO (staff.role = 'physician') anade un paciente nuevo sin que el
// paciente se registre ni pague:
//   1. pone el email en comped_emails (membresia de cortesia, nunca se cobra)
//   2. crea la cuenta de acceso (sin contrasena; entra con el codigo por email)
//      o usa la que ya exista con ese email
//   3. crea su fila de health_history con intake_pending = true; el trigger
//      zz_cortesia_por_email la deja en plan 'Comped' y paid = true
// Si el paciente ya tiene historial, solo se le pone la cortesia.
// Quien llama se toma del JWT, nunca del body. No envia correos.
//
// DEPLOY: supabase functions deploy staff-add-patient --no-verify-jwt
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, st = 200) =>
  new Response(JSON.stringify(b), { status: st, headers: { ...CORS, "Content-Type": "application/json" } });
const s = (v: unknown) => (v == null ? "" : String(v)).trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ESTADOS = ["PR", "MD"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!auth) return json({ error: "Sign in required" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY || SERVICE_KEY, { global: { headers: { Authorization: `Bearer ${auth}` } }, auth: { persistSession: false } });
    const { data: u } = await userClient.auth.getUser(auth);
    if (!u?.user) return json({ error: "Sign in required" }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: yo } = await db.from("staff").select("role").eq("user_id", u.user.id).maybeSingle();
    if (!yo || yo.role !== "physician") return json({ error: "Only physicians can add patients." }, 403);

    const body = await req.json().catch(() => ({}));
    const email = s(body.email).toLowerCase();
    const fullName = s(body.full_name).slice(0, 120);
    const phone = s(body.phone).slice(0, 30) || null;
    const dob = /^\d{4}-\d{2}-\d{2}$/.test(s(body.date_of_birth)) ? s(body.date_of_birth) : null;
    const gender = ["female", "male", "other"].includes(s(body.gender)) ? s(body.gender) : null;
    const state = ESTADOS.includes(s(body.state)) ? s(body.state) : null;
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "Enter a valid email." }, 400);
    if (!fullName) return json({ error: "Enter the patient's full name." }, 400);

    // 1. Cortesia por email (si se registra solo, igual queda gratis).
    const { error: cErr } = await db.from("comped_emails").upsert(
      { email, active: true, note: "Added by staff " + u.user.id + " on " + new Date().toISOString().slice(0, 10) },
      { onConflict: "email" });
    if (cErr) return json({ error: "Could not save the complimentary membership: " + cErr.message }, 500);

    // 2. Cuenta: la que ya existe con ese email, o una nueva.
    let uid = "";
    const { data: ex } = await db.rpc("staff_buscar_usuario_por_email", { p_email: email });
    if (ex) uid = s(ex);
    let creada = false;
    if (!uid) {
      const { data: nu, error: uErr } = await db.auth.admin.createUser({
        email, email_confirm: true,
        user_metadata: { full_name: fullName, date_of_birth: dob, phone, added_by_staff: true },
      });
      if (uErr || !nu?.user) return json({ error: "Could not create the account: " + (uErr?.message || "unknown") }, 500);
      uid = nu.user.id; creada = true;
    }

    // 3. Expediente.
    const { data: hh } = await db.from("health_history").select("id, plan").eq("user_id", uid)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (hh) {
      const { error: upErr } = await db.from("health_history").update({ plan: "Comped", paid: true, membership_cancelled: false })
        .eq("id", hh.id);
      if (upErr) return json({ error: "Could not set the complimentary membership: " + upErr.message }, 500);
      return json({ ok: true, existed: true, account_created: creada, health_history_id: hh.id });
    }
    const { data: fila, error: hErr } = await db.from("health_history").insert({
      user_id: uid, email, full_name: fullName, phone, date_of_birth: dob, gender, shipping_state: state,
      intake_pending: true, added_by_staff: u.user.id,
    }).select("id, plan, paid").maybeSingle();
    if (hErr || !fila) return json({ error: "Could not create the chart: " + (hErr?.message || "unknown") }, 500);
    // Por si el trigger no corrio: la cortesia se pone igual.
    if (fila.plan !== "Comped" || !fila.paid) {
      await db.from("health_history").update({ plan: "Comped", paid: true, paid_at: new Date().toISOString() }).eq("id", fila.id);
    }
    return json({ ok: true, existed: false, account_created: creada, health_history_id: fila.id });
  } catch (err) {
    console.error("staff-add-patient:", err);
    return json({ error: String(err) }, 500);
  }
});
