// ============================================================
// notify — Supabase Edge Function  (build 14oct-3)
//
// 14oct-3: AVISO "VENCIO HOY" para quien paga con ATH (sin tarjeta guardada).
//   ATH no cobra solo: el dia que vence membership_paid_until (hora de PR) se
//   le manda UN correo con dos botones — renovar con ATH, o poner una tarjeta
//   que renueva sola. Una vez por fecha (columna expired_notice_for, ver
//   sql-aviso-vencida-ath.sql). Los de tarjeta no lo reciben (nmi-renew les
//   cobra y les manda su recibo). Cuenta en expiredNoticesSent; dry=1 no manda.
//   El recibo de renovacion automatica ya no trae los pasos de paciente nuevo
//   ("Book your evaluation...") y dice hasta cuando queda pagado.
//
// 14oct-2: la membresia vale MEMBERSHIP_MONTHLY ($50) — una constante. De
//   ahi salen el precio de lista del recibo (un pago normal de $50 ya no
//   lleva linea de descuento), "renews at $50/month", y los montos por
//   defecto de payment / card_declined.
//
// 14oct-1: evento "payment" con data.free_trial (primer mes gratis con
//   codigo): el recibo dice $0.00 cobrado hoy, que la tarjeta se verifico sin
//   cobrar, y que renueva a la mensual en data.renews_on salvo que cancele.
//
// 13oct-1: CONFIRMAR O CANCELAR desde el recordatorio.
//   · El email del dia antes trae "Confirm" y "I can't make it". Llevan a
//     nuviclinic.com/?cita=<id>&t=<token> — la pagina enseña la cita y los
//     botones, y el clic hace POST {event:"appointment_response"}. El enlace
//     solo NO cambia nada: los escaneres de Outlook/Gmail abren los enlaces
//     y cancelarian citas solos.
//   · El token es aleatorio, uno por cita (appointments.confirm_token). No
//     hace falta sesion: el paciente confirma desde el email en el telefono.
//   · Confirmar → confirmed_at. Cancelar → status 'cancelled' +
//     patient_cancelled_at, aviso al equipo y al paciente.
//
// 12oct-2: el cron se autentica con un CODIGO DE UN SOLO USO que la propia
//   base crea en la tabla cron_nonces (sin acceso para anon/authenticated) y
//   manda en la cabecera x-cron-nonce. La funcion lo verifica y lo BORRA.
//   No hace falta ningun secret compartido. (CRON_SECRET sigue sirviendo.)
//
// 12oct-1: RECORDATORIOS AUTOMATICOS (una vez al dia, lo dispara pg_cron):
//   · A cada paciente con cita MAÑANA: "tu evaluacion es mañana a las X".
//   · Al equipo: UN correo con la lista de citas de mañana.
//   · A cada paciente cuya membresia vence en 3 dias o menos: cuando vence,
//     si se renueva sola (tarjeta guardada) o si tiene que renovarla para
//     seguir con su cuidado y su medicamento; y si no tiene cita de
//     seguimiento, que la pida.
//   Cada recordatorio sale UNA vez (columnas reminder_sent_at y
//   expiry_reminder_for). Protegido con el secret CRON_SECRET.
//   Lo dispara: POST {"event":"daily_reminders"} con cabecera x-cron-secret.
//   Prueba sin mandar nada: GET ?job=reminders&dry=1&key=<CRON_SECRET>
//
// 05oct-2: sin import externo (Deno.serve nativo). El import de deno.land
//   podia hacer fallar el deploy desde el panel sin decir por que.
//
// 05oct-1:
//   · Errores de Resend traducidos a una frase que dice QUE arreglar
//     (key mala/ausente, dominio sin verificar, cuota diaria agotada...).
//   · GET a la URL de la funcion = chequeo de salud (key puesta? remitente?).
//     Con ?test=1 manda un correo de prueba a NOTIFY_TO y devuelve el error
//     EXACTO de Resend. Sirve para saber en 10 segundos por que no sale nada.
//   · Eventos nuevos: message_received (mensaje paciente<->equipo),
//     card_declined (la renovacion automatica fallo), y copia al equipo de
//     shipment. El paciente tambien recibe bienvenida al registrarse.
//   · Los correos de mensajes NO llevan el texto del mensaje (minimo
//     necesario: es informacion de salud). Solo avisan y mandan a entrar.
//
// Cambios vs la versión anterior:
//   1. Eventos NUEVOS que la app ya mandaba y aquí caían en "Unknown event"
//      (400) — o sea, NUNCA salían:
//        · appointment_cancelled  (el paciente mueve su cita / el equipo la cancela)
//        · lab_uploaded           (el paciente sube un lab)
//        · prescription_approved  (el médico aprueba una receta)
//      y appointment_booked ahora distingue una cita NUEVA de una MOVIDA
//      (data.moved === true).
//   2. La API key ya NO tiene fallback en el código. Estaba pegada en el
//      archivo, así que esa key hay que revocarla en Resend y crear otra:
//        supabase secrets set RESEND_API_KEY=re_LA_NUEVA
//      Sin el secret, la función responde 500 con un mensaje claro en vez de
//      mandar con una key filtrada.
//   3. `sent` se declara antes de usarse (antes se leía dentro de trySend
//      antes de la línea que lo creaba; funcionaba por suerte).
//
// DEPLOY  (el slug de la función en Supabase es el que está en NOTIFY_FUNCTION
//          dentro de index.html — hoy 'swift-responder')
//   supabase functions deploy swift-responder --no-verify-jwt
//   supabase secrets set RESEND_API_KEY=re_xxxxxxxx      <-- key NUEVA
//   supabase secrets set NOTIFY_TO="alejandro@nuviclinic.com,drcampa@nuviclinic.com"
//        (separa con comas para mandar a varios)
//   supabase secrets set CLINIC_PHONE="+1 787 000 0000"
// ============================================================


// El nombre de la VARIABLE va en comillas. Lo que se guarda con
// `supabase secrets set` es el valor; el código nunca lo contiene.
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// Bandeja interna de la clínica. Acepta VARIOS correos separados por coma.
// Para añadir a alguien: mete su correo aquí, o mejor en el secret NOTIFY_TO
// (que gana sobre esto) para no tener que redesplegar.
const NOTIFY_TO = (Deno.env.get("NOTIFY_TO")
  ?? "alejandro@nuviclinic.com, drcampa@nuviclinic.com, drangelicamarrero@nuviclinic.com")
  .split(",").map((e) => e.trim()).filter(Boolean);
const CLINIC_PHONE = Deno.env.get("CLINIC_PHONE") ?? "";
const FROM       = "Nuvi Clinic <info@nuviclinic.com>";
const SITE       = "https://nuviclinic.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Escapar lo que viene del cliente antes de meterlo en HTML. Un nombre con
// "<" rompía el email, y un nombre hostil podía inyectar marcado.
const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function shell(title: string, body: string, footerNote = "") {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EAFBFF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EAFBFF;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#FFFFFF;border-radius:18px;overflow:hidden;box-shadow:0 18px 44px -28px rgba(8,26,77,0.35);">
    <tr><td style="height:5px;background:#FF6B6B;line-height:5px;font-size:0;">&nbsp;</td></tr>
    <tr><td style="padding:34px 38px 0;">
      <div style="font-size:13px;font-weight:700;letter-spacing:0.14em;color:#00A896;text-transform:uppercase;">Nuvi Clinic</div>
    </td></tr>
    <tr><td style="padding:14px 38px 0;">
      <h1 style="margin:0 0 16px;font-size:25px;line-height:1.3;font-weight:600;color:#081A4D;">${title}</h1>
    </td></tr>
    <tr><td style="padding:0 38px 30px;color:#3A4A66;font-size:15.5px;line-height:1.65;">${body}</td></tr>
    <tr><td style="padding:20px 38px 28px;border-top:1px solid #E6EDF2;background:#F7FBFC;">
      <p style="margin:0 0 5px;font-size:12.5px;color:#7A8FA3;">Nuvi Clinic · Puerto Rico${
        CLINIC_PHONE ? ` · ${esc(CLINIC_PHONE)}` : ""}</p>
      <p style="margin:0;font-size:12.5px;color:#7A8FA3;">Not for medical emergencies — call 911.</p>
      ${footerNote ? `<p style="margin:8px 0 0;font-size:11.5px;color:#9AAABB;">${footerNote}</p>` : ""}
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

const btn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#081A4D;color:#fff;text-decoration:none;
    font-size:16px;font-weight:600;padding:14px 32px;border-radius:100px;">${label}</a>`;

// Boton secundario (borde, sin relleno), para la segunda opcion de un correo.
const btn2 = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#ffffff;color:#081A4D;text-decoration:none;
    font-size:15px;font-weight:600;padding:12px 26px;border-radius:100px;border:2px solid #081A4D;">${label}</a>`;

const row = (k: string, v: string) =>
  `<div style="margin-bottom:6px;"><b>${esc(k)}:</b> ${esc(v)}</div>`;

const card = (inner: string) =>
  `<table role="presentation" width="100%" style="background:#F2FAFB;border-radius:12px;margin-bottom:22px;">
     <tr><td style="padding:16px 18px;font-size:14.5px;color:#081A4D;">${inner}</td></tr></table>`;

const INTERNAL = "Internal notification — not sent to the patient.";

// ---- RECORDATORIOS DIARIOS ------------------------------------------------
// Lee la base con la service key (Supabase la inyecta sola en cada funcion) y
// por REST, sin librerias: esta funcion no importa nada de fuera a proposito.
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? Deno.env.get("RENEW_SECRET") ?? "";
const MEMBERSHIP_WARN_DAYS = 3;

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json",
               Prefer: "return=representation", ...(init.headers || {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`DB ${r.status} on ${path.split("?")[0]}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

// Puerto Rico es UTC-4 todo el año (sin horario de verano).
function fechaPR(offsetDays = 0): string {
  const d = new Date(Date.now() - 4 * 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
function fechaBonita(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return isNaN(d.getTime()) ? iso
    : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
// La app guarda la hora como "10:00 AM" (paciente) o "14:30" (input del doctor).
function horaBonita(t: unknown): string {
  const s = String(t ?? "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return s;
  let h = parseInt(m[1], 10); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ¿La llamada viene de NUESTRA base? Solo la base (service role / cron) puede
// escribir en cron_nonces. El codigo se gasta al usarlo y caduca a los 10 min.
async function autorizadoPorNonce(req: Request): Promise<boolean> {
  const n = req.headers.get("x-cron-nonce") || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n) || !SB_URL || !SB_SERVICE) return false;
  try {
    const desde = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const rows = await rest(`cron_nonces?token=eq.${n}&created_at=gte.${desde}`, { method: "DELETE" });
    return Array.isArray(rows) && rows.length === 1;
  } catch (_) { return false; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ver / confirmar / cancelar una cita con el token del email. Devuelve
// [cuerpo, status http]. Nada de datos clinicos: fecha, hora y estado.
async function responderCita(d: any): Promise<[Record<string, unknown>, number]> {
  const id = String(d.id ?? ""), t = String(d.t ?? ""), action = String(d.action ?? "view");
  if (!UUID_RE.test(t) || !/^[0-9a-zA-Z-]{1,64}$/.test(id) || !["view", "confirm", "cancel"].includes(action))
    return [{ error: "This link is not valid." }, 400];
  let rows: any[];
  try { rows = await rest(`appointments?select=*&id=eq.${encodeURIComponent(id)}&confirm_token=eq.${t}`) || []; }
  catch (e) { return [{ error: "We could not load your appointment. Please try again." }, 500]; }
  const c = rows[0];
  if (!c) return [{ error: "This link is no longer valid. Your care team may have moved the appointment — check your dashboard." }, 404];
  const info = { date: c.appointment_date, dateLabel: fechaBonita(String(c.appointment_date)), time: horaBonita(c.appointment_time),
                 status: c.status, confirmed: !!c.confirmed_at };
  if (action === "view") return [{ ok: true, ...info }, 200];
  if (String(c.appointment_date) < fechaPR(0)) return [{ error: "This appointment has already passed.", ...info }, 409];
  if (c.status === "cancelled") return [{ ok: true, ...info, already: "cancelled" }, 200];
  if (c.status !== "scheduled") return [{ error: "This appointment can no longer be changed online. Message your care team.", ...info }, 409];

  let hh: any = {};
  try { const h = await rest(`health_history?select=full_name,email&user_id=eq.${c.user_id}&order=created_at.desc&limit=1`); hh = (h && h[0]) || {}; } catch (_) { /* sigue */ }
  const name = hh.full_name || hh.email || "A patient";
  const first = String(name).split(" ")[0];
  let staffTo: string[] = NOTIFY_TO;
  try { const st = await rest(`staff?select=*&user_id=eq.${c.np_user_id}`); if (st && st[0] && st[0].email) staffTo = [st[0].email]; } catch (_) { /* bandeja */ }

  if (action === "confirm") {
    if (c.confirmed_at) return [{ ok: true, ...info, confirmed: true, already: "confirmed" }, 200];
    try { await rest(`appointments?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ confirmed_at: new Date().toISOString() }) }); }
    catch (e) { return [{ error: "We could not save your confirmation. Please try again." }, 500]; }
    return [{ ok: true, ...info, confirmed: true }, 200];
  }

  // cancel
  try { await rest(`appointments?id=eq.${encodeURIComponent(id)}`, { method: "PATCH",
          body: JSON.stringify({ status: "cancelled", patient_cancelled_at: new Date().toISOString(), confirmed_at: null }) }); }
  catch (e) { return [{ error: "We could not cancel it. Please try again or message your care team." }, 500]; }
  try {
    await send(staffTo, `Cancelled by patient — ${name} — ${info.dateLabel} at ${info.time}`,
      shell("A patient cancelled their appointment", `
        ${card(row("Patient", name) + row("Date", info.dateLabel) + row("Time", info.time) +
               (c.ticket_number ? row("Ticket", c.ticket_number) : "") + row("Patient email", hh.email || "—"))}
        <p style="margin:0 0 24px;">They cancelled from the reminder email. The slot is free again —
        reach out to set a new time.</p>
        ${btn(SITE, "Open patient chart")}`, INTERNAL));
  } catch (e) { console.error("cancel staff email failed:", e); }
  if (hh.email) {
    try {
      await send(hh.email, "Your Nuvi Clinic appointment was cancelled",
        shell("Appointment cancelled", `
          <p style="margin:0 0 14px;">Hi ${esc(first)} — we cancelled your appointment on ${esc(info.dateLabel)} at ${esc(info.time)}, as you asked.</p>
          <p style="margin:0 0 20px;">Your care team will reach out to find you a new time. You can also use
          “Ask us to schedule it” on your dashboard.</p>
          ${btn(SITE, "Open your dashboard")}`));
    } catch (e) { console.error("cancel patient email failed:", e); }
  }
  return [{ ok: true, ...info, status: "cancelled", confirmed: false }, 200];
}

async function correrRecordatorios(dry: boolean) {
  const out: Record<string, unknown> = { dry, today: fechaPR(0), tomorrow: fechaPR(1) };
  const enviados: string[] = []; const fallos: string[] = [];
  // Resend admite ~2 envios por segundo: se espera entre uno y otro.
  const mandar = async (to: unknown, subject: string, html: string, etiqueta: string) => {
    if (dry) { enviados.push(etiqueta + " (dry)"); return true; }
    try {
      const r: any = await send(to as string | string[], subject, html);
      await pausa(600);
      if (r && r.skipped) { fallos.push(etiqueta + ": no valid recipient"); return false; }
      enviados.push(etiqueta); return true;
    } catch (e) { fallos.push(etiqueta + ": " + String(e)); await pausa(600); return false; }
  };

  // El paciente de cada user_id: su health_history MAS RECIENTE.
  const pacientes = new Map<string, any>();
  const cargarPacientes = async (ids: string[]) => {
    const faltan = [...new Set(ids)].filter((id) => id && !pacientes.has(id));
    if (!faltan.length) return;
    const rows = await rest(`health_history?select=*&user_id=in.(${faltan.join(",")})&order=created_at.desc`);
    for (const r of rows || []) if (!pacientes.has(r.user_id)) pacientes.set(r.user_id, r);
  };
  let staff: any[] = [];
  try { staff = await rest("staff?select=*") || []; } catch (_) { staff = []; }
  const staffDe = (uid: string) => staff.find((x) => x.user_id === uid) || null;

  // ---- 1) Citas de MAÑANA ----
  const manana = fechaPR(1);
  const citas: any[] = await rest(`appointments?select=*&appointment_date=eq.${manana}&status=eq.scheduled&type=eq.np_interview&order=appointment_time.asc`) || [];
  const pendientes = citas.filter((c) => !c.reminder_sent_at);
  await cargarPacientes(pendientes.map((c) => c.user_id));
  const avisadas: string[] = [];
  const lista: Array<{ name: string; time: string; provider: string; to: string[] }> = [];
  for (const c of pendientes) {
    const hh = pacientes.get(c.user_id) || {};
    const name = hh.full_name || hh.email || "Patient";
    const first = String(name).split(" ")[0];
    const prov = staffDe(c.np_user_id);
    const hora = horaBonita(c.appointment_time);
    lista.push({ name, time: hora, provider: prov?.full_name || "", to: prov?.email ? [prov.email] : NOTIFY_TO });
    if (!hh.email) { fallos.push("appointment " + c.id + ": patient has no email"); continue; }
    // Token para confirmar/cancelar desde el email. Se guarda ANTES de mandar:
    // un enlace con un token que no esta en la base no serviria.
    let token: string = c.confirm_token || "";
    if (!token && !dry) {
      token = crypto.randomUUID();
      try { await rest(`appointments?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify({ confirm_token: token }) }); }
      catch (e) { token = ""; fallos.push("appointment " + c.id + ": could not save confirm token: " + String(e)); }
    }
    const enlace = (r: string) => `${SITE}/?cita=${encodeURIComponent(c.id)}&t=${encodeURIComponent(token)}&r=${r}`;
    const botones = token
      ? `<p style="margin:0 0 12px;font-weight:600;color:#081A4D;">Please confirm you'll be there:</p>
         <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr>
           <td style="padding:0 10px 10px 0;">${btn(enlace("confirm"), "Yes, I'll be there")}</td>
           <td style="padding:0 0 10px 0;"><a href="${enlace("cancel")}" style="display:inline-block;color:#8C2F2F;text-decoration:none;font-size:15px;font-weight:600;padding:13px 22px;border:1.5px solid #E2B4B4;border-radius:100px;">I can't make it</a></td>
         </tr></table>`
      : btn(SITE, "Open your dashboard");
    const ok = await mandar(hh.email, `Please confirm: your Nuvi Clinic evaluation is tomorrow at ${hora}`,
      shell("Your evaluation is tomorrow", `
        <p style="margin:0 0 14px;">Hi ${esc(first)} — this is a reminder of your video visit with your care team.</p>
        ${card(row("Date", fechaBonita(manana)) + row("Time", hora + " (Puerto Rico)") +
               (prov?.full_name ? row("With", prov.full_name) : "") +
               (c.ticket_number ? row("Confirmation", c.ticket_number) : ""))}
        ${botones}
        <p style="margin:0 0 6px;">At your appointment time, join from your dashboard at nuviclinic.com — from a quiet
        place with good signal. Your phone works, no app to install.</p>
        <p style="margin:16px 0 0;font-size:14px;color:#7A8FA3;">If you cancel, your care team will reach out to find you a new time.</p>`), "appointment:" + c.id);
    if (ok) avisadas.push(c.id);
  }
  // Un solo correo al equipo con la lista (agrupado por destinatario).
  const porDestino = new Map<string, typeof lista>();
  for (const it of lista) { const k = it.to.join(","); porDestino.set(k, [...(porDestino.get(k) || []), it]); }
  for (const [k, items] of porDestino) {
    await mandar(k.split(","), `Tomorrow's appointments (${items.length}) — ${fechaBonita(manana)}`,
      shell(`Tomorrow: ${items.length} appointment${items.length === 1 ? "" : "s"}`, `
        ${card(items.map((i) => row(i.time, i.name + (i.provider ? " — " + i.provider : ""))).join(""))}
        <p style="margin:0 0 24px;">Each patient was emailed a reminder asking them to confirm or cancel.
        The calendar shows who confirmed; you'll get an email if anyone cancels.</p>
        ${btn(SITE, "Open calendar")}`, INTERNAL), "staff-digest:" + k);
  }
  if (!dry && avisadas.length) {
    try { await rest(`appointments?id=in.(${avisadas.join(",")})`, { method: "PATCH", body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }) }); }
    catch (e) { fallos.push("could not mark appointments as reminded: " + String(e)); }
  }
  out.appointmentsTomorrow = citas.length; out.appointmentRemindersSent = avisadas.length;

  // ---- 2) Membresias que vencen en <= 3 dias ----
  const hoy = fechaPR(0), limite = fechaPR(MEMBERSHIP_WARN_DAYS);
  const vencen: any[] = await rest(`health_history?select=*&paid=eq.true&membership_paid_until=gte.${hoy}&membership_paid_until=lte.${limite}&order=created_at.desc`) || [];
  const vistos = new Set<string>(); let avisosMembresia = 0;
  for (const hh of vencen) {
    if (vistos.has(hh.user_id)) continue; vistos.add(hh.user_id);      // solo la fila mas reciente
    if (hh.plan === "Comped" || hh.membership_cancelled) continue;
    if (hh.expiry_reminder_for && String(hh.expiry_reminder_for).slice(0, 10) === String(hh.membership_paid_until).slice(0, 10)) continue;
    // Sin tarjeta y vence HOY: le toca el aviso "vencio hoy" (seccion 3), no dos correos el mismo dia.
    if (!hh.card_vault_id && String(hh.membership_paid_until).slice(0, 10) === hoy) continue;
    if (!hh.email) { fallos.push("membership " + hh.user_id + ": no email"); continue; }
    const first = String(hh.full_name || "").split(" ")[0] || "there";
    const vence = fechaBonita(String(hh.membership_paid_until).slice(0, 10));
    const auto = !!hh.card_vault_id;
    let tieneCita = false;
    try {
      const prox = await rest(`appointments?select=id&user_id=eq.${hh.user_id}&appointment_date=gte.${hoy}&status=eq.scheduled&limit=1`);
      tieneCita = !!(prox && prox.length);
    } catch (_) { /* si falla, se le recuerda igual */ }
    const ok = await mandar(hh.email,
      auto ? `Your Nuvi Clinic membership renews on ${vence}` : `Your Nuvi Clinic membership expires on ${vence}`,
      shell(auto ? "Your membership renews soon" : "Your membership is about to expire", `
        <p style="margin:0 0 14px;">Hi ${esc(first)} — ${auto
          ? `your membership renews automatically on <b>${esc(vence)}</b> with the card you saved${hh.card_last4 ? ` (ending ${esc(hh.card_last4)})` : ""}. Nothing to do.`
          : `your membership is paid through <b>${esc(vence)}</b>. Renew before then so your care continues without a gap.`}</p>
        <p style="margin:0 0 14px;">An active membership and an up-to-date follow-up evaluation are what let your physician renew your medication.</p>
        ${tieneCita ? "" : `<p style="margin:0 0 14px;"><b>You don't have a follow-up on the calendar yet.</b> Use “Ask us to schedule it” on your dashboard and your care team will set it up.</p>`}
        ${btn(SITE, auto ? "Open your dashboard" : "Renew my membership")}`),
      "membership:" + hh.user_id);
    if (ok) {
      avisosMembresia++;
      if (!dry) {
        try { await rest(`health_history?id=eq.${hh.id}`, { method: "PATCH", body: JSON.stringify({ expiry_reminder_for: String(hh.membership_paid_until).slice(0, 10) }) }); }
        catch (e) { fallos.push("could not mark membership reminder: " + String(e)); }
      }
    }
  }
  out.membershipRemindersSent = avisosMembresia;

  // ---- 3) Vencio HOY y paga con ATH (sin tarjeta guardada) ----
  // ATH no tiene cobros recurrentes: si no hace nada, hoy se queda sin
  // membresia. Los de tarjeta NO: nmi-renew les cobra y les manda su recibo.
  const venceHoy: any[] = await rest(`health_history?select=*&paid=eq.true&membership_paid_until=eq.${hoy}&order=created_at.desc`) || [];
  const vistosHoy = new Set<string>(); let avisosVencida = 0;
  const RENOVAR = SITE + "/?renovar=1";
  for (const hh of venceHoy) {
    if (vistosHoy.has(hh.user_id)) continue; vistosHoy.add(hh.user_id);
    if (hh.plan === "Comped" || hh.membership_cancelled || hh.card_vault_id) continue;
    if (hh.expired_notice_for && String(hh.expired_notice_for).slice(0, 10) === hoy) continue;   // ya avisado por esta fecha
    if (!hh.email) { fallos.push("expired " + hh.user_id + ": no email"); continue; }
    const first = String(hh.full_name || "").split(" ")[0] || "there";
    const fecha = fechaBonita(hoy);
    const ok = await mandar(hh.email, "Your Nuvi Clinic membership expired today",
      shell("Your membership expired today", `
        <p style="margin:0 0 14px;">Hi ${esc(first)} — your membership was paid through <b>${esc(fecha)}</b>, which is today.
          To keep your care and your medication refills going, renew for ${MEMBERSHIP_STR}:</p>
        <p style="margin:0 0 12px;">${btn(RENOVAR + "&metodo=ath", "Renew with ATH Móvil")}</p>
        <p style="margin:0 0 8px;">${btn2(RENOVAR + "&metodo=card", "Add a card — renews automatically")}</p>
        <p style="margin:0 0 18px;font-size:13.5px;color:#7A8FA3;line-height:1.6;">With a card, your membership renews automatically each month
          (${MEMBERSHIP_STR}/month), so you won't need to do this again. You can cancel anytime from your dashboard.</p>
        <p style="margin:0 0 14px;">An active membership and an up-to-date follow-up evaluation are what let your physician renew your medication.</p>
        <p style="margin:0;font-size:13.5px;color:#7A8FA3;">If you already renewed, ignore this email.</p>`),
      "expired:" + hh.user_id);
    if (ok) {
      avisosVencida++;
      if (!dry) {
        // Si la columna no existe (SQL sin correr) esto falla: se anota y el job sigue.
        try { await rest(`health_history?id=eq.${hh.id}`, { method: "PATCH", body: JSON.stringify({ expired_notice_for: hoy }) }); }
        catch (e) { fallos.push("could not mark expired notice (run sql-aviso-vencida-ath.sql?): " + String(e)); }
      }
    }
  }
  out.expiredNoticesSent = avisosVencida;
  out.sent = enviados.length; out.failed = fallos.length ? fallos : undefined;
  return out;
}

// ---- Piezas de recibo -----------------------------------------------------
// Un recibo no es un aviso: lleva conceptos desglosados, un total separado por
// una regla, un número que el paciente pueda citar, y la fecha. Si alguien
// disputa un cargo con su banco, esto es lo que enseña.
// Precio de la membresia. Igual que en nmi-charge, nmi-renew e index.html.
const MEMBERSHIP_MONTHLY = 50;
const MEMBERSHIP_STR = "$" + MEMBERSHIP_MONTHLY;

const money = (v: unknown) => {
  const s = String(v ?? "").trim();
  if (!s) return "—";
  return s.startsWith("$") ? s : "$" + s;
};

const line = (k: string, v: string) =>
  `<tr><td style="padding:7px 0;font-size:14.5px;color:#3A4A66;">${esc(k)}</td>
       <td style="padding:7px 0;font-size:14.5px;color:#081A4D;text-align:right;
                  font-variant-numeric:tabular-nums;">${esc(v)}</td></tr>`;

const receipt = (items: Array<[string, string]>, total: [string, string]) => `
  <table role="presentation" width="100%" style="background:#F7FBFC;border-radius:12px;margin-bottom:22px;">
    <tr><td style="padding:18px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${items.map(([k, v]) => line(k, v)).join("")}
        <tr><td colspan="2" style="padding:6px 0 0;">
          <div style="border-top:1px solid #DCE6EA;"></div></td></tr>
        <tr>
          <td style="padding:11px 0 0;font-size:15px;font-weight:700;color:#081A4D;">${esc(total[0])}</td>
          <td style="padding:11px 0 0;font-size:17px;font-weight:700;color:#081A4D;text-align:right;
                     font-variant-numeric:tabular-nums;">${esc(total[1])}</td>
        </tr>
      </table>
    </td></tr>
  </table>`;

// Número de recibo. Si la app manda uno, se respeta — así coincide con lo que
// haya quedado guardado. Si no, se arma con la fecha y algo aleatorio.
const receiptNo = (given: unknown) => {
  if (given) return String(given);
  const d = new Date();
  const ymd = d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, "0")
    + String(d.getDate()).padStart(2, "0");
  return "NV-" + ymd + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
};

// Fecha del recibo. Si la app manda data.date se usa ESA, no la de hoy:
// en un recibo reenviado después (o en un envío retroactivo) poner la fecha
// de hoy sería declarar un cobro que no ocurrió ese día.
const receiptDate = (given: unknown) => {
  if (given) {
    const d = new Date(String(given));
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }
    return String(given);
  }
  return new Date().toLocaleDateString("en-US",
    { year: "numeric", month: "long", day: "numeric" });
};

// Franja de "pagado" arriba del recibo.
const paidStamp = (amount: string, label = "Payment received") => `
  <table role="presentation" width="100%" style="margin-bottom:20px;">
    <tr><td style="padding:14px 18px;background:#EDF7F4;border-left:3px solid #00A896;border-radius:0 10px 10px 0;">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#00A896;">${esc(label)}</div>
      <div style="font-size:24px;font-weight:700;color:#081A4D;margin-top:3px;font-variant-numeric:tabular-nums;">${esc(amount)}</div>
    </td></tr>
  </table>`;

// Una dirección suelta, ya limpia. Resend rechaza el envío ENTERO si una sola
// viene mal formada, así que se validan antes en vez de descubrirlo con un 422.
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// Traduce el error de Resend a lo que hay que HACER. El texto crudo de Resend
// es correcto pero uno lo lee a las 11 de la noche y no sabe que significa.
function hintResend(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401 || b.includes("api key is invalid") || b.includes("restricted_api_key"))
    return "Resend rejected the API key (revoked, mistyped, or sending-only key on the wrong domain). Create a new key in Resend → API Keys and set it again as the RESEND_API_KEY secret.";
  if (status === 403 && (b.includes("domain") || b.includes("verify")))
    return "The sender domain is not verified in Resend. Open Resend → Domains → nuviclinic.com and re-check the DNS records (SPF/DKIM) until it says Verified.";
  if (status === 429 || b.includes("quota") || b.includes("rate_limit"))
    return "Resend sending limit reached (free plan: 100/day, 3,000/month). Wait for the reset or upgrade the plan.";
  if (status === 422) return "Resend rejected the message format (usually a bad recipient or sender address).";
  return "";
}

async function send(to: string | string[] | undefined, subject: string, html: string) {
  // Acepta un correo, una lista, o un string con comas ("a@x.com, b@y.com").
  // Lo último pasa cuando el secret NOTIFY_TO trae varios: si no se separa,
  // Resend recibe una "dirección" con coma dentro y devuelve 422.
  const raw = (Array.isArray(to) ? to : [to])
    .flatMap((e) => String(e ?? "").split(","))
    .map((e) => e.trim())
    .filter(Boolean);

  const list = raw.filter((e) => EMAIL_RE.test(e));
  const bad  = raw.filter((e) => !EMAIL_RE.test(e));
  if (bad.length) console.warn("direcciones descartadas por formato:", bad);

  // Sin destinatario válido no se intenta: Resend devolvería 422 y tumbaría el
  // resto de los envíos del mismo evento.
  if (!list.length) { console.warn("send skipped, no valid recipient:", subject, raw); return { skipped: true }; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: list, subject, html }),
  });
  if (!r.ok) {
    const txt = await r.text();
    const h = hintResend(r.status, txt);
    throw new Error(`Resend ${r.status}: ${txt.slice(0, 300)}${h ? " — FIX: " + h : ""}`);
  }
  return r.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    const u = new URL(req.url);
    const info: Record<string, unknown> = {
      ok: true, function: "notify", resendKeySet: !!RESEND_KEY,
      from: FROM, staffRecipients: NOTIFY_TO.length,
    };
    if (u.searchParams.get("job") === "reminders") {
      if (!CRON_SECRET || u.searchParams.get("key") !== CRON_SECRET) return json({ error: "Unauthorized" }, 401);
      try { return json(await correrRecordatorios(u.searchParams.get("dry") !== "0")); }
      catch (e) { return json({ error: String(e) }, 500); }
    }
    if (u.searchParams.get("test") === "1") {
      if (!RESEND_KEY) { info.ok = false; info.testResult = "RESEND_API_KEY is not set on this function"; return json(info, 500); }
      try {
        const r: any = await send(NOTIFY_TO, "Nuvi Clinic — email test",
          shell("Email test", `<p style="margin:0;">If you are reading this, the sender works.</p>`, INTERNAL));
        info.testResult = "sent to " + NOTIFY_TO.join(", "); info.resendId = r?.id;
      } catch (e) { info.ok = false; info.testResult = String(e); return json(info, 500); }
    }
    return json(info);
  }
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // Chequear la key aquí y no arriba: así el error llega al navegador CON
  // cabeceras CORS y se lee como lo que es, en vez de como un fallo de CORS.
  if (!RESEND_KEY) {
    console.error("RESEND_API_KEY no está configurada");
    return json({ error: "RESEND_API_KEY is not set on this function" }, 500);
  }

  try {
    const { event, patient = {}, data = {} } = await req.json();

    // El trabajo diario de recordatorios. Solo con el secret: sin el,
    // cualquiera podria disparar correos a todos los pacientes.
    if (event === "daily_reminders") {
      const porSecret = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
      if (!porSecret && !(await autorizadoPorNonce(req))) return json({ error: "Unauthorized" }, 401);
      return json(await correrRecordatorios(data && data.dry === true));
    }

    // Respuesta del paciente desde el enlace del recordatorio (sin sesion).
    if (event === "appointment_response") return json(...(await responderCita(data || {})));
    const name  = patient.name  || "A patient";
    const email = patient.email || "";
    const first = String(name).split(" ")[0];

    // Cada envío se aísla. Antes, si el correo al staff fallaba, el recibo del
    // paciente ni se intentaba — un destinatario mal escrito dejaba al
    // paciente sin su comprobante de pago.
    // Registra en `sent` SOLO lo que de verdad salió. Si dijera "staff" cuando
    // el envío se saltó, el campo que se lee en consola para diagnosticar
    // estaría mintiendo — y volveríamos a adivinar.
    const sent: string[] = [];
    const failed: string[] = [];
    const trySend = async (to: unknown, subject: string, html: string, who: string) => {
      try {
        const r: any = await send(to as string | string[], subject, html);
        if (r && r.skipped) { failed.push(who + ": no valid recipient"); return false; }
        sent.push(who);
        return true;
      } catch (e) {
        console.error("send failed (" + who + "):", e);
        failed.push(who + ": " + String(e));
        return false;
      }
    };

    // El clínico asignado si lo hay; si no, la bandeja de la clínica.
    const staffTo = data.providerEmail ? String(data.providerEmail) : NOTIFY_TO;

    switch (event) {

      // ---- intake completado ----
      case "signup": {
        await trySend(NOTIFY_TO, `New signup — ${name}`,
          shell("New patient signed up", `
            <p style="margin:0 0 14px;"><b>${esc(name)}</b> just completed their health history.</p>
            <p style="margin:0 0 20px;">Email: ${esc(email) || "(no email)"}</p>
            <p style="margin:0 0 24px;">They have not paid yet. Nothing to action until they do.</p>
            ${btn(SITE, "Open dashboard")}`, INTERNAL), "staff");

        if (email) {
          await trySend(email, "Welcome to Nuvi Clinic — we received your health history",
            shell(`Welcome, ${esc(first)}`, `
              <p style="margin:0 0 14px;">Thanks for completing your health history. It's now in your chart.</p>
              <p style="margin:0 0 20px;">Next step: activate your membership, then book a video visit with a licensed physician.
              Your physician decides whether treatment is appropriate for you.</p>
              ${btn(SITE, "Continue to your dashboard")}`), "patient");
        }
        break;
      }

      // ---- pagó la membresía ----
      case "payment": {
        const free = data.free_trial === true;
        const renewsOn = free && data.renews_on ? fechaBonita(String(data.renews_on).slice(0, 10)) : "";
        const renewAmt = money(data.renew_amount ?? ("$" + MEMBERSHIP_MONTHLY.toFixed(2)));
        await trySend(NOTIFY_TO, free ? `Free first month started — ${name}` : `Payment — ${name}`,
          shell(free ? "Free first month started" : "Membership payment received", `
            <p style="margin:0 0 14px;"><b>${esc(name)}</b> ${free
              ? `started a free first month with a promo code. Card verified and saved, <b>$0.00 charged</b>; renews at ${esc(renewAmt)}/month${renewsOn ? ` on ${esc(renewsOn)}` : ""}.`
              : "paid for membership."}</p>
            ${card(row("Email", email || "—") + row("Amount", data.amount ?? MEMBERSHIP_STR) +
                   (data.coupon ? row("Code", data.coupon) : ""))}
            <p style="margin:0 0 24px;">They now need a physician evaluation booked and reviewed.</p>
            ${btn(SITE, "Review patient")}`, INTERNAL), "staff");

        // ---- RECIBO 1: suscripción ----
        if (email) {
          const amount = money(data.amount ?? MEMBERSHIP_STR);
          const no = receiptNo(data.receipt);
          const listed = MEMBERSHIP_MONTHLY;
          // Solo se usa si se pago MENOS que la lista (abajo).
          const promo = data.coupon || "Launch promotion";
          const paidNum = parseFloat(String(amount).replace(/[^0-9.]/g, "")) || 0;
          const items: Array<[string, string]> = [
            ["Nuvi Clinic membership — " + (data.plan ?? "Basic"), "$" + listed],
          ];
          if (paidNum < listed) {
            items.push([promo ? ("Discount — " + String(promo)) : "Discount",
                        "-$" + (listed - paidNum)]);
          }
          const pagadoHasta = data.renewal && data.paid_until ? fechaBonita(String(data.paid_until).slice(0, 10)) : "";
          items.push(["Billing period", free
            ? ("First month free, then " + renewAmt + "/month" + (renewsOn ? " from " + renewsOn : ""))
            : data.renewal ? ("Monthly" + (pagadoHasta ? " — paid through " + pagadoHasta : ""))
            : "Monthly, starting today"]);

          await trySend(email, data.renewal ? "Your Nuvi Clinic membership renewed — receipt"
                             : free ? "Your free first month has started — Nuvi Clinic"
                             : "Thanks for subscribing — your Nuvi Clinic receipt",
            shell(data.renewal ? `Your membership renewed, ${esc(first)}` : `Thanks for joining, ${esc(first)}`, `
              <p style="margin:0 0 18px;">${data.renewal
                ? "Your monthly membership renewed automatically on the card you saved."
                : free ? "Your free first month is active and your care team can see your file."
                : "Your membership is active and your care team can see your file."}
              Here's your receipt — keep it for your records.</p>

              ${paidStamp(amount, free ? "Nothing charged today" : "Payment received")}
              ${receipt(items, ["Total charged", amount])}

              <table role="presentation" width="100%" style="margin-bottom:22px;">
                <tr>
                  <td style="font-size:13px;color:#7A8FA3;padding-bottom:4px;">Receipt no.</td>
                  <td style="font-size:13px;color:#7A8FA3;padding-bottom:4px;text-align:right;">Date</td>
                </tr>
                <tr>
                  <td style="font-size:13.5px;color:#081A4D;font-family:monospace;">${esc(no)}</td>
                  <td style="font-size:13.5px;color:#081A4D;text-align:right;">${esc(receiptDate(data.date))}</td>
                </tr>
              </table>

              ${data.renewal ? `
              <p style="margin:0 0 22px;">Nothing else to do. Keep your monthly follow-up evaluation on the calendar so your
                physician can keep renewing your medication.</p>
              ${btn(SITE, "Open your dashboard")}` : `
              <p style="margin:0 0 12px;font-weight:600;color:#081A4D;">What happens next</p>
              <ol style="margin:0 0 22px;padding-left:20px;">
                <li style="margin-bottom:8px;">Book your evaluation with a licensed physician.</li>
                <li style="margin-bottom:8px;">Your physician reviews your history and decides whether treatment is appropriate.</li>
                <li>If approved, your medication ships to your home within 2 days.</li>
              </ol>
              ${btn(SITE, "Book your evaluation")}`}

              <p style="margin:24px 0 0;font-size:13.5px;color:#7A8FA3;line-height:1.6;">
                ${free
                  ? `Your card${data.last4 ? ` ending ${esc(String(data.last4))}` : ""} was verified, not charged. Your membership renews automatically at ${esc(renewAmt)}/month${renewsOn ? ` on <b>${esc(renewsOn)}</b>` : " after your free month"} unless you cancel before then from your dashboard.`
                  : `Your membership renews at ${MEMBERSHIP_STR}/month and you can cancel anytime from your dashboard.`}
                <b>Medication is billed separately</b> — the membership covers your care, not the prescription.
              </p>`), "patient");
        }
        break;
      }

      // ---- cita agendada o MOVIDA: confirmación al paciente + aviso al doctor ----
      // data.moved === true cuando el equipo la cambió de fecha desde la ficha.
      case "appointment_booked": {
        const when = [data.date, data.time].filter(Boolean).join(" at ") || "your scheduled time";
        const moved = data.moved === true;

        if (email) {
          await trySend(email,
            moved ? `Your appointment was moved — ${when}` : `Your evaluation is booked — ${when}`,
            shell(moved ? "Your appointment was moved" : "Your evaluation is booked", `
              <p style="margin:0 0 14px;">${moved
                ? `Hi ${esc(first)} — your care team moved your appointment. Here is the new time:`
                : `You're all set, ${esc(first)}.`}</p>
              ${card(row("Date", data.date ?? "—") + row("Time", data.time ?? "—") +
                     (data.provider ? row("With", data.provider) : "") +
                     (data.ticket ? row("Confirmation", data.ticket) : ""))}
              <p style="margin:0 0 20px;">It's a video visit — join from this same site, no app to install.
              Have your questions ready; the physician will review your history with you.</p>
              ${btn(SITE, "Join at your appointment time")}
              ${CLINIC_PHONE ? `<p style="margin:22px 0 0;font-size:14px;">Need to reschedule? Call ${esc(CLINIC_PHONE)}.</p>`
                             : `<p style="margin:22px 0 0;font-size:14px;">Need to reschedule? Message your care team from your dashboard.</p>`}`), "patient");
        }

        // Aviso al clínico asignado; si no hay, a la bandeja de la clínica.
        await trySend(staffTo,
          (moved ? "Appointment moved — " : "New appointment — ") + `${name} — ${when}`,
          shell(moved ? "An appointment was moved" : "You have a new appointment", `
            ${card(row("Patient", name) + row("Date", data.date ?? "—") +
                   row("Time", data.time ?? "—") +
                   (data.ticket ? row("Ticket", data.ticket) : "") +
                   row("Patient email", email || "—"))}
            ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");
        break;
      }

      // ---- cita cancelada: por el paciente (al moverla) o por el equipo ----
      case "appointment_cancelled": {
        const when = [data.date, data.time].filter(Boolean).join(" at ") || "your scheduled time";
        const byPatient = /patient/i.test(String(data.reason ?? ""));

        if (email) {
          await trySend(email, `Your appointment on ${when} was cancelled`,
            shell("Appointment cancelled", `
              <p style="margin:0 0 14px;">Hi ${esc(first)} — the appointment below is no longer on the calendar.</p>
              ${card(row("Date", data.date ?? "—") + row("Time", data.time ?? "—") +
                     (data.ticket ? row("Confirmation", data.ticket) : ""))}
              <p style="margin:0 0 20px;">${byPatient
                ? "You asked to move it. Pick a new time from your dashboard — your records, labs and messages are untouched."
                : "Your care team cancelled it and will be in touch to set a new one. Your records, labs and messages are untouched."}</p>
              ${btn(SITE, byPatient ? "Pick a new time" : "Open your dashboard")}`), "patient");
        }

        await trySend(staffTo, `Appointment cancelled — ${name} — ${when}`,
          shell("An appointment was cancelled", `
            ${card(row("Patient", name) + row("Date", data.date ?? "—") +
                   row("Time", data.time ?? "—") +
                   (data.ticket ? row("Ticket", data.ticket) : "") +
                   row("Reason", data.reason ?? "—") +
                   row("Patient email", email || "—"))}
            ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");
        break;
      }

      // ---- receta aprobada: el paciente ya puede comprarla ----
      case "prescription_approved": {
        const med  = [data.medication, data.dose].filter(Boolean).join(" — ") || "your medication";
        const cost = data.price != null && data.price !== "" ? money(data.price) + "/mo" : "";

        if (email) {
          await trySend(email, `Your prescription is ready to order — ${data.medication ?? "Nuvi Clinic"}`,
            shell("Your prescription was approved", `
              <p style="margin:0 0 14px;">Good news, ${esc(first)} — your physician approved your treatment.</p>
              ${card(row("Medication", data.medication ?? "—") +
                     (data.dose ? row("Dose", data.dose) : "") +
                     (cost ? row("Price", cost) : "") +
                     (data.provider ? row("Approved by", data.provider) : ""))}
              <p style="margin:0 0 20px;">Nothing ships until you order it. When you're ready, place the order from
              your dashboard and our compounding pharmacy prepares it — usually shipping within 2 days.</p>
              ${btn(SITE, "Order from your dashboard")}
              <p style="margin:22px 0 0;font-size:13.5px;color:#7A8FA3;line-height:1.6;">
                Medication is billed separately from your membership. Each prescription covers 28 days;
                your physician reviews your dose at each monthly evaluation.
              </p>`), "patient");
        }

        await trySend(NOTIFY_TO, `Prescription approved — ${name} — ${med}`,
          shell("Prescription approved", `
            ${card(row("Patient", name) + row("Medication", med) +
                   (cost ? row("Price", cost) : "") +
                   (data.provider ? row("Approved by", data.provider) : "") +
                   row("Patient email", email || "—"))}
            <p style="margin:0 0 24px;">Awaiting the patient's payment. <b>Do not submit to the pharmacy until it clears.</b></p>
            ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");
        break;
      }

      // ---- el paciente subió un lab / documento ----
      case "lab_uploaded": {
        await trySend(NOTIFY_TO, `Lab uploaded — ${name}`,
          shell("A patient uploaded a document", `
            ${card(row("Patient", name) + row("File", data.fileName ?? "—") +
                   row("Patient email", email || "—"))}
            <p style="margin:0 0 24px;">Review it in the chart before their next evaluation.</p>
            ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");

        if (email) {
          await trySend(email, "We received your document",
            shell("Document received", `
              <p style="margin:0 0 14px;">Thanks, ${esc(first)} — <b>${esc(data.fileName ?? "your document")}</b>
              is now in your chart and your care team can see it.</p>
              <p style="margin:0 0 20px;">Your physician will review it before your next evaluation.
              No action needed on your side.</p>
              ${btn(SITE, "Open your dashboard")}`), "patient");
        }
        break;
      }

      // ---- pagó el medicamento ----
      case "med_payment": {
        const med = [data.medication, data.dose].filter(Boolean).join(" ");

        // ---- RECIBO 2: medicamento ----
        if (email) {
          const amount = money(data.amount);
          const no = receiptNo(data.receipt);
          const ship = [data.shipTo, data.shipCity, data.shipState, data.shipZip]
            .filter(Boolean).join(", ");
          // Con descuento se enseñan las tres líneas: precio de lista, lo que
          // se descontó, y el total. Un recibo que solo dice "$0" no explica
          // nada; uno que dice "$180 → -$180 → $0" sí.
          const items: Array<[string, string]> = [
            [data.medication ? String(data.medication) : "Medication",
             data.listPrice ? money(data.listPrice) : amount],
          ];
          if (data.dose)  items.push(["Dose", String(data.dose)]);
          items.push(["Supply", "28 days (4 weeks)"]);
          items.push(["Pharmacy", "503A compounding partner"]);
          if (data.discount) {
            items.push([data.coupon ? ("Discount — " + String(data.coupon)) : "Discount",
                        String(data.discount)]);
          }

          await trySend(email, "Thank you for your purchase — medication receipt",
            shell("Thank you for your purchase", `
              <p style="margin:0 0 18px;">We've received your payment, ${esc(first)}.
              Here's your receipt for this prescription.</p>

              ${paidStamp(amount)}
              ${receipt(items, ["Total charged", amount])}

              <table role="presentation" width="100%" style="margin-bottom:22px;">
                <tr>
                  <td style="font-size:13px;color:#7A8FA3;padding-bottom:4px;">Receipt no.</td>
                  <td style="font-size:13px;color:#7A8FA3;padding-bottom:4px;text-align:right;">Date</td>
                </tr>
                <tr>
                  <td style="font-size:13.5px;color:#081A4D;font-family:monospace;">${esc(no)}</td>
                  <td style="font-size:13.5px;color:#081A4D;text-align:right;">${esc(receiptDate(data.date))}</td>
                </tr>
              </table>

              ${ship ? `<p style="margin:0 0 6px;font-weight:600;color:#081A4D;">Shipping to</p>
                        <p style="margin:0 0 22px;font-size:14.5px;">${esc(ship)}</p>` : ""}

              <p style="margin:0 0 12px;font-weight:600;color:#081A4D;">What happens next</p>
              <ol style="margin:0 0 22px;padding-left:20px;">
                <li style="margin-bottom:8px;">Your care team sends the prescription to the pharmacy.</li>
                <li style="margin-bottom:8px;">The pharmacy compounds and ships it — usually within 2 days.</li>
                <li>You'll get an email with tracking the moment it leaves.</li>
              </ol>

              <table role="presentation" width="100%" style="background:#FDF6EF;border-radius:12px;">
                <tr><td style="padding:15px 18px;font-size:14px;color:#3A4A66;line-height:1.6;">
                  <b style="color:#081A4D;">Before your next refill</b><br>
                  This covers 28 days. You need an evaluation with your physician before each
                  refill — book next month's early so you don't run out.
                </td></tr>
              </table>

              <p style="margin:22px 0 0;font-size:13.5px;color:#7A8FA3;line-height:1.6;">
                This charge is separate from your ${MEMBERSHIP_STR}/month membership.
                Questions about the charge? Reply to this email.
              </p>`), "patient");
        }

        await trySend(NOTIFY_TO, `Medication paid — ${name}`,
          shell("Medication payment received", `
            <p style="margin:0 0 14px;"><b>${esc(name)}</b> paid for medication.</p>
            ${card(row("Medication", med || "—") + row("Amount", data.amount ?? "—") +
                   row("Email", email || "—"))}
            <p style="margin:0 0 24px;"><b>Action needed:</b> submit this prescription to the pharmacy.</p>
            ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");
        break;
      }

      // ---- envío ----
      case "shipment": {
        if (!email) return json({ error: "shipment requires patient.email" }, 400);
        const carrier  = data.carrier ?? "USPS";
        const tracking = data.tracking ?? "";
        const url = data.trackingUrl
          ?? (tracking ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}` : "");
        await trySend(email, "Your medication is on the way",
          shell("Your medication has shipped", `
            <p style="margin:0 0 18px;">Your ${esc(data.medication ?? "medication")}${
              data.dose ? ` (${esc(data.dose)})` : ""} is on its way.</p>
            ${card(row("Carrier", carrier) + (tracking ? row("Tracking", tracking) : ""))}
            ${url ? btn(url, "Track your shipment") : ""}
            <p style="margin:22px 0 0;font-size:14px;">Keep it refrigerated between 36–46°F when it arrives. Never leave it in a hot car.</p>`), "patient");

        await trySend(NOTIFY_TO, `Shipped — ${name}`,
          shell("A medication shipped", `
            ${card(row("Patient", name) + row("Carrier", carrier) + (tracking ? row("Tracking", tracking) : ""))}
            ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");
        break;
      }

      // ---- mensaje entre paciente y equipo ----
      // data.from: 'patient' (avisa al equipo) | 'staff' (avisa al paciente).
      // NUNCA lleva el texto del mensaje: es informacion de salud y un correo
      // no es un canal protegido. Solo avisa y manda a entrar.
      case "message_received": {
        if (data.from === "staff") {
          if (!email) return json({ error: "message_received from staff requires patient.email" }, 400);
          await trySend(email, "You have a new message from your care team",
            shell("New message from your care team", `
              <p style="margin:0 0 14px;">Hi ${esc(first)} — your care team sent you a message.</p>
              <p style="margin:0 0 20px;">For your privacy we don't put medical details in email. Sign in to read it.</p>
              ${btn(SITE, "Read your message")}`), "patient");
        } else {
          const req_ = data.kind === "appointment_request";
          await trySend(staffTo, (req_ ? "Appointment request — " : "New patient message — ") + name,
            shell(req_ ? "A patient asked for an appointment change" : "New patient message", `
              ${card(row("Patient", name) + row("Patient email", email || "—"))}
              <p style="margin:0 0 24px;">${req_
                ? "They sent a request to book or move their evaluation. Open the chart to read it and set a time."
                : "Open the chart to read it and reply. Message text is not included in email."}</p>
              ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");
        }
        break;
      }

      // ---- la renovacion automatica fallo ----
      case "card_declined": {
        const amount = money(data.amount ?? MEMBERSHIP_STR);
        if (email) {
          await trySend(email, "Action needed — your Nuvi Clinic membership payment didn't go through",
            shell("We couldn't renew your membership", `
              <p style="margin:0 0 14px;">Hi ${esc(first)} — we tried to charge ${esc(amount)}${
                data.last4 ? ` to the card ending in ${esc(data.last4)}` : " to your saved card"} and the bank declined it.</p>
              <p style="margin:0 0 20px;">Your access is not interrupted today. ${data.until
                ? `Your current period ends ${esc(data.until)}. ` : ""}Please pay with another card or ATH Móvil from your dashboard so your care continues without a gap. We'll retry the saved card tomorrow.</p>
              ${btn(SITE, "Update payment")}`), "patient");
        }
        await trySend(NOTIFY_TO, `Renewal declined — ${name}`,
          shell("A membership renewal was declined", `
            ${card(row("Patient", name) + row("Amount", amount) + row("Patient email", email || "—") +
                   (data.until ? row("Paid until", data.until) : ""))}
            <p style="margin:0 0 24px;">The patient was emailed. The saved card is retried daily until the period ends.</p>
            ${btn(SITE, "Open patient chart")}`, INTERNAL), "staff");
        break;
      }

      // ---- recordatorio de evaluación ----
      case "eval_due": {
        if (!email) return json({ error: "eval_due requires patient.email" }, 400);
        await trySend(email, "Time to book your monthly evaluation",
          shell("Your evaluation is due", `
            <p style="margin:0 0 16px;">Your membership includes an evaluation with your physician each month. It's how your dose is adjusted safely.</p>
            <p style="margin:0 0 24px;"><b>Your refill depends on this visit.</b> Book it before you run low.</p>
            ${btn(SITE, "Book your evaluation")}`), "patient");
        break;
      }

      default:
        return json({ error: `Unknown event: ${event}` }, 400);
    }

    return json({ ok: true, event, sent, failed: failed.length ? failed : undefined });

  } catch (err) {
    console.error("notify error:", err);
    return json({ error: String(err) }, 500);
  }
});