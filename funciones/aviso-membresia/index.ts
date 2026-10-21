// ============================================================
// aviso-membresia — aviso por correo 7 días antes de que venza o se renueve
// la membresía (Etapa 5, aprobado por la Dra. Marrero el 21 oct 2026).
//
// Una vez al día lo dispara pg_cron (job 'nuvi-aviso-membresia-7d') con un
// código de un solo uso en cron_nonces, igual que los recordatorios de notify.
// Manda UN correo a cada paciente cuya membresía vence exactamente dentro de
// 7 días (hora de Puerto Rico). El aviso de 3 días de notify sigue igual.
//
// No cobra nada y no cambia nada en la base: solo lee y manda el correo.
// Prueba sin mandar: POST {"dry":true} con la cabecera x-cron-nonce.
// ============================================================
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const CLINIC_PHONE = Deno.env.get("CLINIC_PHONE") ?? "";
const FROM = "Nuvi Clinic <info@nuviclinic.com>";
const SITE = "https://nuviclinic.com";
const DIAS = 7;
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!(await autorizado(req))) return json({ error: "Unauthorized" }, 401);
  let dry = false;
  try { dry = !!(await req.json()).dry; } catch (_) { /* sin cuerpo */ }
  if (!dry && !RESEND_KEY) return json({ error: "RESEND_API_KEY is not set" }, 500);

  const objetivo = fechaPR(DIAS);
  const filas: any[] = await rest(`health_history?select=*&paid=eq.true&membership_paid_until=eq.${objetivo}&order=created_at.desc`) || [];
  const vistos = new Set<string>(); const enviados: string[] = []; const fallos: string[] = [];
  for (const hh of filas) {
    if (vistos.has(hh.user_id)) continue; vistos.add(hh.user_id);    // la fila más reciente del paciente
    if (hh.plan === "Comped" || hh.membership_cancelled) continue;
    if (!hh.email) { fallos.push(hh.user_id + ": no email"); continue; }
    const first = String(hh.full_name || "").split(" ")[0] || "there";
    const vence = fechaBonita(objetivo);
    const auto = !!hh.card_vault_id;
    const asunto = auto ? `Your Nuvi Clinic membership renews in 7 days` : `Your Nuvi Clinic membership ends in 7 days`;
    const html = shell(auto ? "Your membership renews in 7 days" : "Your membership ends in 7 days", `
      <p style="margin:0 0 14px;">Hi ${esc(first)} — ${auto
        ? `your membership renews automatically on <b>${esc(vence)}</b>: $${PRECIO} to the card you saved${hh.card_last4 ? ` (ending ${esc(hh.card_last4)})` : ""}. Nothing to do. If you don't want to continue, you can cancel from Settings in your dashboard before then.`
        : `your membership is paid through <b>${esc(vence)}</b>. Renew before then so your care continues without a gap.`}</p>
      <p style="margin:0 0 22px;">Hola ${esc(first)} — ${auto
        ? `tu membresía se renueva sola el <b>${esc(fechaES(objetivo))}</b>: $${PRECIO} a la tarjeta que guardaste${hh.card_last4 ? ` (termina en ${esc(hh.card_last4)})` : ""}. No tienes que hacer nada. Si no quieres seguir, puedes cancelar desde Ajustes en tu cuenta antes de esa fecha.`
        : `tu membresía está pagada hasta el <b>${esc(fechaES(objetivo))}</b>. Renuévala antes para que tu cuidado siga sin interrupción.`}</p>
      ${btn(SITE, auto ? "Open your dashboard" : "Renew my membership")}`);
    if (dry) { enviados.push(hh.user_id + " (dry)"); continue; }
    try {
      const r = await fetch("https://api.resend.com/emails", { method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [hh.email], subject: asunto, html }) });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
      enviados.push(hh.user_id);
    } catch (e) { fallos.push(hh.user_id + ": " + String(e)); }
    await pausa(600);
  }
  return json({ ok: true, dry, target: objetivo, sent: enviados.length, failures: fallos });
});
