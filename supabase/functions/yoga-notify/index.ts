import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// yoga-notify — aviso por Telegram de una nueva SOLICITUD DE RESERVA de la
// demo WhiteMoon · Yoga & Pilates (asistente "Zoe").
//
// El lead ya se inserta en leads_web desde el cliente (origen='demo-yoga');
// esta función SOLO envía la notificación vía Telegram Bot API, manteniendo el
// token EXCLUSIVAMENTE server-side. En el JS de cliente no hay ninguna apikey
// del notificador: solo la publishable key de Supabase, que únicamente puede
// INSERT en leads_web vía RLS.
//
// Recibe (POST): { nombre, telefono, motivo, dia, hora, reservada, origen }
// El cuerpo llega por navigator.sendBeacon como text/plain;charset=UTF-8 —
// un tipo CORS-safelisted, para no disparar un preflight que el beacon no
// sabe hacer. `req.json()` no mira el Content-Type, así que lo parsea igual.
//
// Secrets usados (nunca en cliente):
//   - TELEGRAM_BOT_TOKEN : token del bot de Telegram
//   - TELEGRAM_CHAT_ID   : chat destino del aviso
//
// UN SOLO Telegram por evento: `yoga-cita` ya manda su propio
// "🧘 NUEVA RESERVA" cuando la plaza queda escrita en la agenda, así que Zoe
// solo llama aquí cuando NO hubo reserva (salida sin plaza, "prefiero que me
// llaméis" o fallback si la agenda no responde).
//
// Regla del proyecto: si el envío falla → console.warn, nunca interrumpe nada.
//
// Desplegar con:
//   supabase functions deploy yoga-notify --no-verify-jwt --project-ref mlaqtniujnvfxcvcourm

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const data = (payload.args ?? payload) as Record<string, unknown>;
  const nombre = String(data.nombre ?? "").trim();
  const telefono = String(data.telefono ?? "").trim();
  const motivo = String(data.motivo ?? "").trim();
  const dia = String(data.dia ?? "").trim();
  const hora = String(data.hora ?? "").trim();
  const origen = String(data.origen ?? "demo-yoga").trim();
  const reservada = data.reservada === true || data.reservada === "Sí";

  // Guard de lead incompleto — estándar WhiteMoon.
  // Un lead solo es válido con nombre Y teléfono: sin ambos no se avisa.
  if (!nombre || !telefono) {
    return json({ ok: false, error: "lead incompleto" }, 400);
  }

  const message =
    `🧘 NUEVA SOLICITUD DE RESERVA — ${origen}\n\n` +
    `👤 ${nombre}\n` +
    `📱 ${telefono}\n` +
    `🧘‍♀️ Clase: ${motivo || "-"}\n` +
    (dia && hora ? `📅 ${dia} a las ${hora}\n` : "📅 Sin franja elegida\n") +
    `\n` +
    (reservada
      ? "✅ Plaza YA reservada en la agenda. No hay que llamar para cerrarla.\n"
      : "⚠️ Solo tenemos el lead: hay que llamar para cerrar día y hora.\n") +
    `📲 CONTACTAR: https://wa.me/34${telefono.replace(/\D/g, "")}`;

  let notified = false;
  try {
    const tgToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const tgChat = Deno.env.get("TELEGRAM_CHAT_ID");
    if (tgToken && tgChat) {
      const r = await fetch(
        `https://api.telegram.org/bot${tgToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tgChat, text: message }),
        },
      );
      notified = r.ok;
      if (!r.ok) {
        console.warn("[yoga-notify] Telegram falló:", r.status, await r.text());
      }
    } else {
      console.warn("[yoga-notify] sin TELEGRAM_BOT_TOKEN/CHAT_ID, mensaje:", message);
    }
  } catch (e) {
    console.warn("[yoga-notify] error enviando Telegram:", e);
  }

  return json({ ok: true, notified });
});
