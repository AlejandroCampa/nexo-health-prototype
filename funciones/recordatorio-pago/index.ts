// ============================================================
// recordatorio-pago — correo "termina tu inscripción" para quien llenó su
// historial pero no ha pagado la membresía. Pedido por la Dra. Marrero
// (22 oct 2026). El botón lleva a https://nuviclinic.com/?pagar=1, que abre
// el login y luego la tarjeta de pago.
//
// NO corre solo (no hay cron). Se llama a mano con un código de un solo uso
// de cron_nonces (cabecera x-cron-nonce):
//   {"test_to":"correo@x.com","name":"Nombre"}  -> manda un ejemplo a ese correo
//   {"user_id":"<uuid>"}                        -> se lo manda a ese paciente,
//                                                  solo si no ha pagado
// No cobra nada y no cambia nada en la base.
// ============================================================
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const CLINIC_PHONE = Deno.env.get("CLINIC_PHONE") ?? "";
const FROM = "Nuvi Clinic <info@nuviclinic.com>";
const SITE = "https://nuviclinic.com";
const PRECIO = 50;   // igual que MEMBERSHIP_MONTHLY en nmi-renew, notify e index.html

const json = (b: unknown, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
    "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`DB ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
function fechaPR(dias = 0): string {   // Puerto Rico = UTC-4 todo el año
  return new Date(Date.now() - 4 * 3600 * 1000 + dias * 86400000).toISOString().slice(0, 10);
}
function fechaES(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("es-PR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
function fechaBonita(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
async function autorizado(req: Request): Promise<boolean> {
  const n = req.headers.get("x-cron-nonce") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n)) return false;
  try {
    const desde = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const rows = await rest(`cron_nonces?token=eq.${n}&created_at=gte.${desde}`, { method: "DELETE" });
    return Array.isArray(rows) && rows.length === 1;
  } catch (_) { return false; }
}
function shell(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EAFBFF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EAFBFF;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#FFFFFF;border-radius:18px;overflow:hidden;">
<tr><td style="height:5px;background:#FF6B6B;line-height:5px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:34px 38px 0;"><div style="font-size:13px;font-weight:700;letter-spacing:0.14em;color:#00A896;text-transform:uppercase;">Nuvi Clinic</div></td></tr>
<tr><td style="padding:14px 38px 0;"><h1 style="margin:0 0 16px;font-size:25px;line-height:1.3;font-weight:600;color:#081A4D;">${title}</h1></td></tr>
<tr><td style="padding:0 38px 30px;color:#3A4A66;font-size:15.5px;line-height:1.65;">${body}</td></tr>
<tr><td style="padding:20px 38px 28px;border-top:1px solid #E6EDF2;background:#F7FBFC;">
<p style="margin:0 0 5px;font-size:12.5px;color:#7A8FA3;">Nuvi Clinic · Puerto Rico${CLINIC_PHONE ? ` · ${esc(CLINIC_PHONE)}` : ""}</p>
<p style="margin:0;font-size:12.5px;color:#7A8FA3;">Not for medical emergencies — call 911.</p></td></tr>
</table></td></tr></table></body></html>`;
}
const btn = (href: string, label: string) => `<a href="${href}" style="display:inline-block;background:#081A4D;color:#fff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 32px;border-radius:100px;">${label}</a>`;


const LINK = SITE + "/?pagar=1";

// Enlace que ya entra a su cuenta (magic link de Supabase, de un solo uso y
// con caducidad) y aterriza en la tarjeta de pago. Si no se puede crear, el
// botón usa LINK, que abre el login y luego el pago.
async function enlaceEntrada(email: string): Promise<{ url: string; magic: boolean }> {
  try {
    const r = await fetch(`${SB_URL}/auth/v1/admin/generate_link`, { method: "POST",
      headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "magiclink", email, redirect_to: LINK }) });
    const d = await r.json();
    const url = d.action_link || (d.properties && d.properties.action_link);
    if (r.ok && url) return { url, magic: true };
  } catch (_) { /* cae al enlace normal */ }
  return { url: LINK, magic: false };
}

function correo(first: string, href: string) {
  return shell("Finish your enrollment", `
      <p style="margin:0 0 14px;">Hi ${esc(first)} — thanks for completing your health history. Your last step is to activate your membership ($${PRECIO}/month) so you can book your video evaluation with a licensed physician.</p>
      <p style="margin:0 0 22px;">Hola ${esc(first)} — gracias por completar tu historial médico. Solo te falta activar tu membresía ($${PRECIO} al mes) para poder agendar tu evaluación por video con un médico licenciado.</p>
      ${btn(href, "Activate my membership / Activar mi membresía")}
      <p style="margin:22px 0 0;font-size:13.5px;color:#7A8FA3;">The button signs you in and takes you straight to payment. If it has expired, just enter your email and we will send you a code. / El botón entra a tu cuenta y te lleva directo al pago. Si ya caducó, escribe tu correo y te enviamos un código.</p>`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!(await autorizado(req))) return json({ error: "Unauthorized" }, 401);
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* sin cuerpo */ }
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY is not set" }, 500);
  let to = "", first = "there";
  if (body.test_to) {
    to = String(body.test_to); first = String(body.name || "there");
  } else if (body.user_id) {
    const filas: any[] = await rest(`health_history?select=email,full_name,paid,membership_cancelled&user_id=eq.${encodeURIComponent(body.user_id)}&order=created_at.desc&limit=1`) || [];
    const hh = filas[0];
    if (!hh) return json({ error: "patient not found" }, 404);
    if (hh.paid) return json({ ok: false, skipped: "already paid" });
    if (!hh.email) return json({ error: "patient has no email" }, 400);
    to = hh.email; first = String(hh.full_name || "").split(" ")[0] || "there";
  } else {
    return json({ error: "send test_to or user_id" }, 400);
  }
  const enl = await enlaceEntrada(to);
  const r = await fetch("https://api.resend.com/emails", { method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject: "Finish your Nuvi Clinic enrollment / Termina tu inscripción", html: correo(first, enl.url) }) });
  if (!r.ok) return json({ error: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
  return json({ ok: true, sent: 1, direct_login: enl.magic });
});
