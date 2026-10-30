// cita-aviso — Supabase Edge Function (30 oct 2026). DEPLOY: --no-verify-jwt.
// Avisos de UNA cita al paciente, por correo:
//   mode "soon"    — "tu cita empieza en 15 minutos". Lo llama el cron
//                    avisos-cita-pronto (SQL) con appointment_id + confirm_token.
//   mode "waiting" — "tu medica te esta esperando". Lo llama el boton del staff
//                    (jwt de la sesion en el body) o SQL con el token.
// Nada del body llega al correo: todo sale de la base por appointment_id.
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SITE = "https://nuviclinic.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
               "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rest(p: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${p}`, { ...init, headers: { apikey: SB, Authorization: `Bearer ${SB}`,
    "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) } });
  const t = await r.text(); if (!r.ok) throw new Error("DB " + r.status + " " + t.slice(0, 120));
  return t ? JSON.parse(t) : null;
}
async function esStaff(jwt: string): Promise<string | null> {
  if (!jwt) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB, Authorization: `Bearer ${jwt}` } });
  if (!r.ok) return null;
  const u = await r.json(); if (!u?.id) return null;
  const st = await rest(`staff?select=user_id&user_id=eq.${u.id}&limit=1`);
  return Array.isArray(st) && st.length ? u.id : null;
}
function horaBonita(t: unknown): string {
  const s = String(t ?? "").trim(); const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return s; let h = parseInt(m[1], 10); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`;
}
function shell(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#EAFBFF;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EAFBFF;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 18px 44px -28px rgba(8,26,77,0.35);">
<tr><td style="height:5px;background:#FF6B6B;line-height:5px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:34px 38px 0;"><div style="font-size:13px;font-weight:700;letter-spacing:0.14em;color:#00A896;text-transform:uppercase;">Nuvi Clinic</div></td></tr>
<tr><td style="padding:14px 38px 0;"><h1 style="margin:0 0 16px;font-size:25px;line-height:1.3;font-weight:600;color:#081A4D;">${title}</h1></td></tr>
<tr><td style="padding:0 38px 30px;color:#3A4A66;font-size:15.5px;line-height:1.65;">${body}</td></tr>
<tr><td style="padding:20px 38px 28px;border-top:1px solid #E6EDF2;background:#F7FBFC;"><p style="margin:0;font-size:12.5px;color:#7A8FA3;">Nuvi Clinic · Puerto Rico · Not for medical emergencies — call 911.</p></td></tr>
</table></td></tr></table></body></html>`;
}
const btn = (label: string) => `<a href="${SITE}" style="display:inline-block;background:#081A4D;color:#fff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 32px;border-radius:100px;">${label}</a>`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const mode = String(b.mode || ""), id = String(b.appointment_id || ""), t = String(b.t || "");
    if (!["soon", "waiting"].includes(mode) || !UUID.test(id)) return json({ error: "bad request" }, 400);
    let filtro = `id=eq.${id}`;
    if (UUID.test(t)) filtro += `&confirm_token=eq.${t}`;
    else if (mode !== "waiting" || !(await esStaff(String(b.jwt || "")))) return json({ error: "Unauthorized" }, 401);
    const ap = (await rest(`appointments?select=id,user_id,np_user_id,status,appointment_time,waiting_notified_at&${filtro}`))[0];
    if (!ap || ap.status !== "scheduled") return json({ error: "Appointment not found or not scheduled" }, 404);
    if (mode === "waiting" && ap.waiting_notified_at && Date.now() - Date.parse(ap.waiting_notified_at) < 90_000)
      return json({ ok: true, skipped: "sent less than 90 seconds ago" });
    const p = (await rest(`health_history?select=full_name,email&user_id=eq.${ap.user_id}&order=created_at.desc&limit=1`))[0] || {};
    if (!p.email) return json({ error: "Patient has no email" }, 400);
    const st = ap.np_user_id ? (await rest(`staff?select=full_name&user_id=eq.${ap.np_user_id}&limit=1`))[0] : null;
    const partes = String(st?.full_name || "").trim().split(/\s+/).filter((w: string) => !/^[A-Z]\.$/.test(w));
    const medico = partes.length ? `la Dra. ${partes[0]}${partes[1] ? " " + partes[1] : ""}` : "tu médica";
    const Medico = medico.charAt(0).toUpperCase() + medico.slice(1);
    const first = String(p.full_name || "").trim().split(/\s+/)[0] || "";
    const hora = horaBonita(ap.appointment_time);
    let subject = "", html = "";
    if (mode === "soon") {
      subject = `Tu cita empieza en 15 minutos (${hora}) — Nuvi Clinic`;
      html = shell(`${first ? esc(first) + ", tu" : "Tu"} cita empieza en 15 minutos`, `
        <p style="margin:0 0 14px;">Tu videollamada con ${esc(medico)} es hoy a las <b>${esc(hora)}</b> (hora de Puerto Rico).</p>
        <p style="margin:0 0 22px;">Entra a nuviclinic.com con tu email unos minutos antes y toca <b>Unirme a la videollamada</b>. Busca un lugar tranquilo con buena señal. No tienes que instalar nada.</p>
        ${btn("Entrar a mi cita")}
        <hr style="border:0;border-top:1px solid #E6EDF2;margin:26px 0 16px;">
        <p style="margin:0;font-size:14px;"><b>Your visit starts in 15 minutes</b> (${esc(hora)}, Puerto Rico time). Sign in at nuviclinic.com with your email and join the video visit.</p>`);
    } else {
      subject = "Tu médica te está esperando en la videollamada — Nuvi Clinic";
      html = shell(`${first ? esc(first) + ", tu" : "Tu"} médica te está esperando`, `
        <p style="margin:0 0 14px;">${esc(Medico)} ya está en la videollamada para tu cita de hoy.</p>
        <p style="margin:0 0 22px;">Entra ahora a nuviclinic.com con tu email y toca <b>Unirme a la videollamada</b>. No tienes que instalar nada.</p>
        ${btn("Entrar a mi cita")}
        <hr style="border:0;border-top:1px solid #E6EDF2;margin:26px 0 16px;">
        <p style="margin:0;font-size:14px;"><b>Your doctor is waiting.</b> Sign in at nuviclinic.com with your email and join the video visit now.</p>`);
    }
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Nuvi Clinic <info@nuviclinic.com>", to: [p.email], subject, html }) });
    if (!r.ok) return json({ error: "Resend " + r.status + ": " + (await r.text()).slice(0, 200) }, 502);
    if (mode === "waiting") await rest(`appointments?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ waiting_notified_at: new Date().toISOString() }) });
    return json({ ok: true, mode });
  } catch (e) { console.error(e); return json({ error: String(e) }, 500); }
});
