// mensaje-aviso — Supabase Edge Function (31 oct 2026). DEPLOY: --no-verify-jwt.
// Cuando un paciente escribe en el chat (o pide cambiar su cita), avisa por
// correo a los dos medicos (Dra. Marrero y Dr. Campa). En
// espanol y con asunto claro. NO incluye el texto (es informacion de salud):
// el correo lleva al chat. Alejandro no recibe estos avisos.
// Seguridad: exige la sesion del paciente (jwt en el body) y que ese paciente
// haya escrito un mensaje en los ultimos 3 minutos; asi nadie lo usa para spam.
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SITE = "https://nuviclinic.com";
const MEDICOS = ["drangelicamarrero@nuviclinic.com", "drcampa@nuviclinic.com"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
               "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
async function rest(p: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${p}`, { headers: { apikey: SB, Authorization: `Bearer ${SB}` } });
  if (!r.ok) throw new Error("DB " + r.status);
  return r.json();
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const jwt = String(b.jwt || "");
    const pideCita = b.kind === "appointment_request";
    const movio = b.kind === "appointment_moved";
    if (!jwt) return json({ error: "Unauthorized" }, 401);
    const ur = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB, Authorization: `Bearer ${jwt}` } });
    if (!ur.ok) return json({ error: "Unauthorized" }, 401);
    const u = await ur.json(); const uid = String(u?.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return json({ error: "Unauthorized" }, 401);
    const desde = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const msgs = await rest(`messages?select=id&user_id=eq.${uid}&sender=eq.patient&created_at=gte.${desde}&limit=1`);
    if (!Array.isArray(msgs) || !msgs.length) return json({ ok: true, skipped: "no recent message" });
    const hh = (await rest(`health_history?select=full_name,email&user_id=eq.${uid}&order=created_at.desc&limit=1`))[0] || {};
    const nombre = String(hh.full_name || hh.email || "Un paciente").trim();
    // 31 oct (Dra. Marrero): el aviso va SIEMPRE a los dos medicos.
    const para = MEDICOS;
    const titulo = movio ? `${esc(nombre)} movió su cita` : pideCita ? `${esc(nombre)} quiere cambiar su cita` : `${esc(nombre)} te escribió`;
    const html = `<!doctype html><html><body style="margin:0;background:#EAFBFF;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EAFBFF;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fff;border-radius:18px;overflow:hidden;">
<tr><td style="height:5px;background:#FF6B6B;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:34px 38px 0;"><div style="font-size:13px;font-weight:700;letter-spacing:.14em;color:#00A896;text-transform:uppercase;">Nuvi Clinic</div>
<h1 style="margin:14px 0 16px;font-size:24px;line-height:1.3;color:#081A4D;font-weight:600;">${pideCita || movio ? "📅" : "💬"} ${titulo}</h1></td></tr>
<tr><td style="padding:0 38px 30px;color:#3A4A66;font-size:15.5px;line-height:1.65;">
<p style="margin:0 0 14px;">${movio ? "Cambió su cita desde su portal, en una hora libre de tu horario. La fecha nueva ya está en el calendario y en el chat." : pideCita ? "Pidió por el chat que le muevan la cita." : "Tiene un mensaje nuevo en el chat."} Por privacidad el texto no va en el correo.</p>
<p style="margin:0 0 22px;">Entra al portal: en <b>Inicio</b> está arriba, en <b>“Mensajes por contestar”</b>, con el botón para responder.</p>
<a href="${SITE}" style="display:inline-block;background:#081A4D;color:#fff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 32px;border-radius:100px;">Abrir el portal</a>
</td></tr>
<tr><td style="padding:18px 38px 24px;border-top:1px solid #E6EDF2;background:#F7FBFC;font-size:11.5px;color:#9AAABB;">Aviso interno — no se envía al paciente.</td></tr>
</table></td></tr></table></body></html>`;
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Nuvi Clinic <info@nuviclinic.com>", to: para,
        subject: (pideCita || movio ? "📅 " : "💬 ") + (movio ? `${nombre} movió su cita` : pideCita ? `${nombre} quiere cambiar su cita` : `Mensaje nuevo de ${nombre}`), html }) });
    if (!r.ok) return json({ error: "Resend " + r.status }, 502);
    return json({ ok: true, to: para.length });
  } catch (e) { console.error(e); return json({ error: String(e) }, 500); }
});
