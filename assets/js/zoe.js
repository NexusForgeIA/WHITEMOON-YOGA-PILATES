/* =========================================================================
   Zoe — Agente IA de Whitemoon · Yoga & Pilates (demo WhiteMoon)

   Flujo de reserva: clase -> nombre -> teléfono -> día -> hora ->
   confirmación. El día y la hora van DETRÁS del contacto a propósito: así, si
   alguien abandona en el calendario, el lead ya está completo y no se pierde.

   Flujo de gestión (cambiar o cancelar una reserva ya hecha): teléfono ->
   `buscar-cita` -> se muestra la cita -> nombre para confirmar identidad ->
   cambiar (nuevo día y hora entre los huecos reales) o cancelar. La comprueba
   y la mueve el servidor: aquí no viaja ningún id de cita.

   Los huecos NO se inventan en cliente: se piden a la Edge Function
   `yoga-cita` (action 'huecos'), y al elegir hora se reserva de verdad
   (action 'reservar'), así la clase aparece en agenda.html.

   El lead se guarda SIEMPRE en leads_web (con cita_dia / cita_hora si las
   hay). El aviso por Telegram, en cambio, es UNO SOLO por evento:
     - con clase reservada -> avisa `yoga-cita` con su "🧘 NUEVA RESERVA"
     - sin reserva         -> avisa `yoga-notify` con el lead
   Así nunca salen dos mensajes por la misma solicitud.

   Nada de apikeys en cliente: la publishable key solo puede INSERT en
   leads_web vía RLS, y `yoga-cita` / `yoga-notify` son verify_jwt:false con
   sus tokens en Secrets.

   Estilo de respuesta: máximo 3 frases por mensaje y UNA pregunta cada vez.
   Zoe nunca cierra precios: los importes que cuenta son los orientativos
   públicos de la web, nunca tarifas internas.
   ========================================================================= */
(() => {
  "use strict";

  const SUPABASE_URL = "https://mlaqtniujnvfxcvcourm.supabase.co";
  const SUPABASE_KEY = "sb_publishable_6no6BuOgiA_2nonTJntAuQ_DTqEgrcV";
  const NOTIFY_FN = SUPABASE_URL + "/functions/v1/yoga-notify";
  const CITA_FN = SUPABASE_URL + "/functions/v1/yoga-cita";
  const LEADS_URL = SUPABASE_URL + "/rest/v1/leads_web";
  const ORIGEN = "demo-yoga";
  const SECTOR = "Yoga y Pilates";
  const EMPRESA = "WhiteMoon";
  const ESTUDIO = "Whitemoon · Yoga & Pilates";
  const TELEFONO = "643 199 580";
  /* Cierre de una plaza cerrada: sin número al que llamar y sin remitir a otro
     canal. Si hay que cambiarla, se cambia aquí mismo. */
  const CIERRE_CITA =
    "¡Te esperamos en la esterilla! ¿Necesitas cambiar o cancelar? Vuelve a " +
    "hablar conmigo y dime tu teléfono, y te lo gestiono al momento.";

  /* Clases: los `label` son EXACTAMENTE los data-clase de los botones
     "Reservar" de las tarjetas, para que al entrar desde una tarjeta se
     salte la pregunta inicial.

     `svc` es el nombre de la clase tal y como existe en la agenda (tabla
     servicios_yoga), porque es lo que espera `reservar`.

     `dur` es solo el valor por defecto: al abrir el chat se refresca con la
     duración real de la agenda, que el estudio puede editar en el panel. */
  const WORKS = [
    { label: "Yoga",            interes: "Yoga",             svc: "Yoga",            dur: 60 },
    { label: "Yoga suave",      interes: "Yoga suave",       svc: "Yoga suave",      dur: 60 },
    { label: "Pilates suelo",   interes: "Pilates suelo",    svc: "Pilates suelo",   dur: 55 },
    { label: "Pilates máquina", interes: "Pilates reformer", svc: "Pilates máquina", dur: 55 },
    { label: "Meditación",      interes: "Meditación",       svc: "Meditación",      dur: 45 },
  ];

  /* Qué es cada clase — se cuenta antes de pedir los datos.
     Máximo 3 frases, sin preguntas: la pregunta va siempre aparte.
     Los importes son los mismos precios orientativos que aparecen en la web. */
  const INFO = {
    "Yoga": "Clase de hatha y vinyasa: respiración, posturas de pie y de suelo, y unos minutos de relajación al final. Dura una hora y cada postura tiene su variante, así que sirve tanto si empiezas como si ya practicas. Orientativo 14 € la clase suelta.",
    "Yoga suave": "Ritmo lento, con silla o bloques si hacen falta, pensado para espalda cargada, poca movilidad o vuelta a la actividad. También dura una hora y se trabaja sin llegar a molestias. Orientativo 14 € la clase suelta.",
    "Pilates suelo": "Pilates mat en grupo reducido: control del centro, movilidad de columna y fuerza sin impacto, con esterilla y material pequeño. Son 55 minutos. Orientativo 16 € la clase suelta.",
    "Pilates máquina": "Pilates en reformer, con la resistencia de los muelles ajustada a ti. Al ser en máquina el grupo es más pequeño y el trabajo, más preciso. Son 55 minutos. Orientativo 24 € la clase suelta.",
    "Meditación": "Sesión guiada de 45 minutos: respiración, atención al cuerpo y práctica en silencio, sentado en cojín o en silla. No hace falta experiencia previa ni ropa especial. Orientativo 10 € la sesión suelta.",
  };

  /* ---------- fechas ---------- */
  const MESES_VISTA = 6;
  const DIAS_CORTOS = ["L", "M", "X", "J", "V", "S", "D"];
  const DIAS_LARGOS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

  const hoy = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const mismoDia = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  /* getDay() da domingo=0, que descoloca la rejilla: aquí lunes=0 */
  const diaSemanaLunes = (d) => (d.getDay() + 6) % 7;
  const formatoLargo = (d) =>
    d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const formatoCorto = (d) =>
    d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const isoLocal = (d) =>
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  /* Los ISO que devuelve `huecos` ya vienen en hora de Madrid con su offset
     ("2026-09-03T10:30:00+02:00"). Se cortan a pelo en vez de pasar por Date
     para que el navegador no los reinterprete en su propia zona horaria. */
  const horaDe = (iso) => iso.slice(11, 16);

  /* Un día es candidato si es laborable y no ha pasado. Es la misma regla que
     aplica yoga-cita en `esLaborable`; sirve para no lanzar 30
     peticiones por mes solo para pintar el calendario. Los huecos reales se
     piden al elegir día. */
  const diaCandidato = (fecha) => diaSemanaLunes(fecha) <= 4 && fecha >= hoy();

  const $ = (s, c = document) => c.querySelector(s);
  const panel = $("#zoe");
  if (!panel) return;
  const body = $(".zoe-body", panel);
  const quick = $(".zoe-quick", panel);
  const form = $(".zoe-foot", panel);
  const input = $(".zoe-foot input", panel);
  const sendBtn = $(".zoe-foot button", panel);
  const btn = $("#zoe-open");

  /* Entrada extra del menú inicial: no es una clase, abre la autogestión. */
  const GESTION = { label: "Cambiar o cancelar mi reserva", gestion: true };

  const lead = {
    servicio: "", interes: "", svc: "", dur: 45,
    nombre: "", telefono: "",
    dia: "", diaISO: "", hora: "", citaAt: "", citaId: "",
  };
  /* Datos de la autogestión, separados del lead a propósito: cambiar una cita
     que ya existe no es un lead nuevo y no debe acabar en leads_web. */
  const gestion = { telefono: "", nombre: "", cita: null, accion: "" };

  let step = "work";       // work -> name -> phone -> fecha -> hora -> done
                           // gestión: g-tel -> g-nombre -> fecha -> hora
  let modo = "reserva";    // reserva | gestion — decide a dónde va el calendario
  let started = false;
  let vista = null;        // mes que pinta el calendario
  let enviado = false;     // el lead solo se manda una vez

  /* ---------- helpers UI ---------- */
  const scroll = () => { body.scrollTop = body.scrollHeight; };
  const addMsg = (text, who = "bot") => {
    const el = document.createElement("div");
    el.className = "zoe-msg " + who;
    el.textContent = text;
    body.appendChild(el); scroll();
  };
  const typing = () => {
    const t = document.createElement("div");
    t.className = "zoe-typing";
    t.innerHTML = "<span></span><span></span><span></span>";
    body.appendChild(t); scroll();
    return t;
  };
  const botSay = (text, after) =>
    new Promise((res) => {
      const t = typing();
      setTimeout(() => {
        t.remove(); addMsg(text, "bot");
        if (after) after();
        res();
      }, Math.min(900, 340 + text.length * 8));
    });
  const clearQuick = () => { quick.innerHTML = ""; };
  const setQuick = (items, onPick) => {
    clearQuick();
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label || it;
      b.addEventListener("click", () => onPick(it));
      quick.appendChild(b);
    });
  };
  const setInput = (enabled, placeholder) => {
    input.disabled = !enabled; sendBtn.disabled = !enabled;
    input.placeholder = placeholder || "Escribe tu respuesta…";
    if (enabled) setTimeout(() => input.focus(), 60);
  };

  /* Widget único: se vuelve a pintar en el sitio en vez de apilar copias */
  const widget = (cls) => {
    let w = $("#zoe-widget", body);
    if (!w) { w = document.createElement("div"); w.id = "zoe-widget"; body.appendChild(w); }
    w.className = cls;
    w.innerHTML = "";
    scroll();
    return w;
  };
  const quitaWidget = () => { const w = $("#zoe-widget", body); if (w) w.remove(); };

  /* ---------- llamadas a yoga-cita ---------- */
  const agenda = async (payload) => {
    try {
      const r = await fetch(CITA_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) console.warn("[zoe] yoga-cita", r.status, data);
      return data;
    } catch (e) {
      console.warn("[zoe] yoga-cita sin red:", e);
      return { _neterr: true };
    }
  };

  /* Duraciones reales de la agenda: el estudio puede cambiarlas desde el
     panel, y la duración decide qué huecos entran. Si falla, se siguen
     usando las de WORKS. */
  const sincronizaDuraciones = async () => {
    const res = await agenda({ action: "servicios-list" });
    if (!res || !res.ok || !Array.isArray(res.servicios)) return;
    const porNombre = new Map(res.servicios.map((s) => [s.nombre, s]));
    WORKS.forEach((w) => {
      const s = porNombre.get(w.svc);
      if (s && s.duracion_min) w.dur = s.duracion_min;
    });
  };

  /* ---------- flujo ---------- */
  const start = async () => {
    if (started) return; started = true;
    setInput(false);
    sincronizaDuraciones();
    await botSay("Hola, soy Zoe, el asistente de Whitemoon Yoga & Pilates. Te reservo plaza en un minuto, sin llamadas.");
    await botSay("¿A qué clase te gustaría venir?", () => menuInicial());
  };

  const menuInicial = () => {
    modo = "reserva";
    step = "work";
    setInput(false);
    setQuick(WORKS.concat([GESTION]), (w) => {
      addMsg(w.label, "user");
      if (w.gestion) askGestionTel(); else pickWork(w.label);
    });
  };

  /* Elegida la clase: primero cuenta en qué consiste, luego pide el nombre. */
  const pickWork = async (label) => {
    const w = WORKS.find((x) => x.label === label) || WORKS[0];
    lead.servicio = w.label;
    lead.interes = w.interes;
    lead.svc = w.svc;
    lead.dur = w.dur;
    clearQuick();
    const info = INFO[w.label];
    if (info) await botSay(info);
    askName();
  };

  const askName = async () => {
    step = "name";
    clearQuick();
    await botSay("Voy a buscarte hueco. ¿A nombre de quién pongo la reserva?",
      () => setInput(true, "Tu nombre…"));
  };

  const askPhone = async () => {
    step = "phone";
    await botSay("Gracias, " + lead.nombre.split(" ")[0] + ". ¿A qué teléfono te avisamos si hay algún cambio?", () =>
      setInput(true, "Tu teléfono…")
    );
  };

  /* ---------- día ---------- */
  const askFecha = async () => {
    step = "fecha";
    clearQuick();
    if (!vista) { const t = hoy(); vista = new Date(t.getFullYear(), t.getMonth(), 1); }
    await botSay("Ya te tengo apuntado. ¿Qué día te viene bien? Hay clases de lunes a viernes.", () => {
      setInput(false, "Elige un día en el calendario");
      pintaCalendario();
    });
  };

  function pintaCalendario() {
    const box = widget("zoe-cal");
    const t = hoy();
    const mesActual = new Date(t.getFullYear(), t.getMonth(), 1);
    const limite = new Date(t.getFullYear(), t.getMonth() + MESES_VISTA, 1);

    const nav = document.createElement("div");
    nav.className = "zoe-cal__nav";
    const mk = (txt, aria, off, dis) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "zoe-cal__btn"; b.textContent = txt;
      b.setAttribute("aria-label", aria); b.disabled = dis;
      b.addEventListener("click", () => {
        vista = new Date(vista.getFullYear(), vista.getMonth() + off, 1);
        pintaCalendario();
      });
      return b;
    };
    /* Sin retroceder del mes actual */
    nav.appendChild(mk("‹", "Mes anterior", -1, vista <= mesActual));
    const etiquetaMes = vista.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    const titulo = document.createElement("p");
    titulo.className = "zoe-cal__mes";
    titulo.setAttribute("aria-live", "polite");
    /* es-ES da "septiembre de 2026"; con capitalize saldría "Septiembre De 2026" */
    titulo.textContent = etiquetaMes.charAt(0).toUpperCase() + etiquetaMes.slice(1);
    nav.appendChild(titulo);
    nav.appendChild(mk("›", "Mes siguiente", 1, vista >= limite));
    box.appendChild(nav);

    const grid = document.createElement("div");
    grid.className = "zoe-cal__grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Días disponibles de " + etiquetaMes);
    DIAS_CORTOS.forEach((d, i) => {
      const c = document.createElement("span");
      c.className = "zoe-cal__wd"; c.setAttribute("aria-hidden", "true");
      c.textContent = d; c.title = DIAS_LARGOS[i];
      grid.appendChild(c);
    });
    const primero = new Date(vista.getFullYear(), vista.getMonth(), 1);
    for (let h = 0; h < diaSemanaLunes(primero); h++) {
      const v = document.createElement("span");
      v.className = "zoe-cal__day is-empty"; v.setAttribute("aria-hidden", "true");
      grid.appendChild(v);
    }
    const ultimo = new Date(vista.getFullYear(), vista.getMonth() + 1, 0).getDate();
    for (let n = 1; n <= ultimo; n++) {
      const fecha = new Date(vista.getFullYear(), vista.getMonth(), n);
      const b = document.createElement("button");
      b.type = "button"; b.className = "zoe-cal__day"; b.textContent = String(n);
      if (mismoDia(fecha, new Date())) b.classList.add("is-today");
      if (!diaCandidato(fecha)) {
        b.disabled = true;
        b.setAttribute("aria-label", formatoLargo(fecha) + ", cerrado");
      } else {
        b.setAttribute("aria-label", formatoLargo(fecha));
        b.addEventListener("click", () => eligeFecha(fecha));
      }
      grid.appendChild(b);
    }
    box.appendChild(grid);

    const nota = document.createElement("p");
    nota.className = "zoe-cal__nota";
    nota.textContent = modo === "gestion"
      ? "Lunes a viernes. Elige el nuevo día para tu clase."
      : "Lunes a viernes. Si lo necesitas para hoy mismo, llámanos al " + TELEFONO + ".";
    box.appendChild(nota);

    const salir = document.createElement("button");
    salir.type = "button"; salir.className = "zoe-back";
    if (modo === "gestion") {
      /* En gestión, salir del calendario es dejar la reserva donde estaba. */
      salir.textContent = "Dejarla como está";
      salir.addEventListener("click", () => {
        addMsg("Dejarla como está", "user");
        quitaWidget();
        cierreGestion("Perfecto, no toco nada: tu reserva sigue igual.");
      });
    } else {
      /* Salida sin reserva: se cierra igual y llamamos nosotros. */
      salir.textContent = "Prefiero que me llaméis vosotros";
      salir.addEventListener("click", () => {
        addMsg("Prefiero que me llaméis vosotros", "user");
        quitaWidget();
        cierreSinCita();
      });
    }
    box.appendChild(salir);
  }

  const eligeFecha = async (fecha) => {
    if (modo === "gestion") {
      gestion.diaISO = isoLocal(fecha);
      gestion.dia = formatoLargo(fecha);
    } else {
      lead.dia = formatoLargo(fecha);
      lead.diaISO = isoLocal(fecha);
    }
    addMsg(formatoCorto(fecha), "user");
    quitaWidget();
    askHora(fecha);
  };

  /* "Elegir otro día" vuelve al calendario, pero el texto cambia: en una
     reserva nueva se está apuntando por primera vez y en una gestión se está
     moviendo algo que ya existe. */
  const otroDia = async () => {
    if (modo !== "gestion") { askFecha(); return; }
    step = "fecha";
    clearQuick();
    await botSay("Sin problema. ¿Qué otro día te viene mejor?", () => {
      setInput(false, "Elige un día en el calendario");
      pintaCalendario();
    });
  };

  /* ---------- hora: huecos REALES de la agenda ---------- */
  const askHora = async (fecha) => {
    step = "hora";
    const dia = modo === "gestion" ? gestion.diaISO : lead.diaISO;
    const dur = modo === "gestion" ? (gestion.cita && gestion.cita.duracion_min) || 45 : lead.dur;
    const t = typing();
    const res = await agenda({ action: "huecos", dia: dia, duracion_min: dur });
    t.remove();

    const huecos = res && res.ok && Array.isArray(res.huecos) ? res.huecos : [];
    if (!huecos.length) {
      const motivo = res && res._neterr
        ? "No he podido consultar la agenda ahora mismo."
        : "Ese día lo tenemos completo.";
      await botSay(motivo + " ¿Probamos con otro?", () => pintaSinHuecos());
      return;
    }
    await botSay("Perfecto. ¿A qué hora te viene mejor?", () => {
      setInput(false, "Elige una hora");
      pintaHoras(huecos, fecha);
    });
  };

  function pintaSinHuecos() {
    const box = widget("zoe-slots");
    const atras = document.createElement("button");
    atras.type = "button"; atras.className = "zoe-back";
    atras.textContent = "Elegir otro día";
    atras.addEventListener("click", () => { quitaWidget(); otroDia(); });
    box.appendChild(atras);
    const salir = document.createElement("button");
    salir.type = "button"; salir.className = "zoe-back";
    if (modo === "gestion") {
      salir.textContent = "Dejarla como está";
      salir.addEventListener("click", () => {
        addMsg("Dejarla como está", "user");
        quitaWidget();
        cierreGestion("Perfecto, no toco nada: tu reserva sigue igual.");
      });
    } else {
      salir.textContent = "Prefiero que me llaméis vosotros";
      salir.addEventListener("click", () => {
        addMsg("Prefiero que me llaméis vosotros", "user");
        quitaWidget();
        cierreSinCita();
      });
    }
    box.appendChild(salir);
  }

  function pintaHoras(huecos, fecha) {
    const box = widget("zoe-slots");
    /* El estudio abre en dos bloques (mañana y tarde); se agrupan por la
       hora del propio hueco en vez de repetir aquí los tramos del backend. */
    const manana = huecos.filter((h) => parseInt(horaDe(h), 10) < 14);
    const tarde = huecos.filter((h) => parseInt(horaDe(h), 10) >= 14);
    [["Mañana", manana], ["Tarde", tarde]].forEach(([etiqueta, lista]) => {
      if (!lista.length) return;
      const sep = document.createElement("p");
      sep.className = "zoe-slots__sep";
      sep.textContent = etiqueta;
      box.appendChild(sep);
      lista.forEach((iso) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "zoe-slot"; b.textContent = horaDe(iso);
        b.setAttribute("aria-label", horaDe(iso) + " del " + formatoCorto(fecha));
        b.addEventListener("click", () => eligeHora(iso, fecha));
        box.appendChild(b);
      });
    });
    const atras = document.createElement("button");
    atras.type = "button"; atras.className = "zoe-back";
    atras.textContent = "Elegir otro día";
    atras.addEventListener("click", () => { addMsg("Prefiero otro día", "user"); quitaWidget(); otroDia(); });
    box.appendChild(atras);
  }

  const eligeHora = async (iso, fecha) => {
    if (modo === "gestion") {
      addMsg(horaDe(iso), "user");
      quitaWidget();
      confirmaCambio(iso, fecha);
      return;
    }
    lead.hora = horaDe(iso);
    lead.citaAt = iso;
    addMsg(lead.hora, "user");
    quitaWidget();
    reservar(fecha);
  };

  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  /* Aviso simple: el SVG del check es decorativo (aria-hidden), el texto es
     quien transmite el resultado. */
  const tarjetaExito = (texto) => {
    const el = document.createElement("div");
    el.className = "zoe-ok";
    el.setAttribute("role", "status");
    const ic = document.createElement("span");
    ic.className = "zoe-ok__ic";
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = CHECK_SVG;
    const p = document.createElement("p");
    p.textContent = texto;
    el.append(ic, p);
    body.appendChild(el);
    scroll();
  };

  /* Tarjeta verde de cita: un resguardo, no un mensaje más del chat. Se pinta
     con nodos y textContent, nunca con innerHTML, para que un nombre con
     comillas o un "<" no pueda inyectar nada. `filas` es [[etiqueta, valor]].
     role="status" hace que un lector de pantalla la lea al aparecer. */
  const tarjetaCita = (titulo, filas) => {
    const el = document.createElement("div");
    el.className = "zoe-cita";
    el.setAttribute("role", "status");

    const head = document.createElement("div");
    head.className = "zoe-cita__head";
    const ic = document.createElement("span");
    ic.className = "zoe-cita__ic";
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = CHECK_SVG;
    const b = document.createElement("b");
    b.textContent = titulo;
    head.append(ic, b);

    const dl = document.createElement("dl");
    dl.className = "zoe-cita__rows";
    filas.forEach(([k, v]) => {
      if (!v) return;
      const row = document.createElement("div");
      row.className = "zoe-cita__row";
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      row.append(dt, dd);
      dl.appendChild(row);
    });

    el.append(head, dl);
    body.appendChild(el);
    scroll();
  };

  /* Una reserva, en filas etiqueta/valor. `datos` viene del servidor ya
     formateado en hora de Madrid. */
  const filasCita = (datos) => [
    ["Nombre", datos.nombre],
    ["Teléfono", datos.telefono],
    ["Clase", datos.servicio],
    ["Fecha", datos.fecha],
    ["Hora", datos.hora],
    ["Lugar", ESTUDIO],
  ];

  /* ---------- reserva real contra la agenda ---------- */
  const reservar = async (fecha) => {
    setInput(false); clearQuick();
    const t = typing();
    const res = await agenda({
      action: "reservar",
      cliente_nombre: lead.nombre,
      cliente_telefono: lead.telefono,
      servicio: lead.svc,
      duracion_min: lead.dur,
      cita_at: lead.citaAt,
    });
    t.remove();

    /* Se la ha llevado otra persona entre que pintamos los huecos y confirmó */
    if (res && res.ok === false && res.reason) {
      await botSay("Vaya, esa plaza la acaban de coger. Te enseño las horas que siguen libres ese día.");
      askHora(fecha);
      return;
    }

    if (!res || !res.ok) {
      /* La agenda no responde, pero el lead no se pierde: lo guardamos con la
         franja que pidió y que le llamen para confirmarla. */
      await cierreSinCita(true);
      return;
    }

    step = "done";
    lead.citaId = res.cita_id || "";
    /* La fecha y la hora las pone el servidor en hora de Madrid; el `lead`
       guarda las del navegador solo para el texto del aviso interno. */
    if (res.fecha) lead.dia = res.fecha;
    if (res.hora) lead.hora = res.hora;
    await enviarLead();
    tarjetaCita("¡Plaza confirmada!", filasCita({
      nombre: lead.nombre,
      telefono: lead.telefono,
      servicio: lead.servicio,
      fecha: res.fecha || lead.dia,
      hora: res.hora || lead.hora,
    }));
    setTimeout(() => addMsg(CIERRE_CITA, "bot"), 700);
  };

  /* Cierre sin plaza confirmada: el lead se guarda igual. */
  const cierreSinCita = async (conFranja) => {
    step = "done";
    setInput(false); clearQuick(); quitaWidget();
    const t = typing();
    if (!conFranja) { lead.dia = ""; lead.diaISO = ""; lead.hora = ""; }
    const ok = await enviarLead();
    t.remove();
    if (ok) {
      tarjetaExito("Anotado. Te llamamos al " + lead.telefono + " para cerrar el día y la hora.");
    } else {
      addMsg(
        "He guardado tus datos pero hubo un problema de conexión. Para no esperar, llámanos al " + TELEFONO + " y te atendemos al momento.",
        "bot"
      );
    }
  };

  /* ====================================================================
     GESTIÓN DE UNA RESERVA YA HECHA
     teléfono -> buscar -> nombre para confirmar -> cambiar o cancelar.
     Aquí no viaja ningún id: el servidor resuelve la cita por teléfono y
     comprueba el nombre antes de tocarla.
     ==================================================================== */

  const askGestionTel = async () => {
    modo = "gestion";
    step = "g-tel";
    clearQuick();
    gestion.cita = null; gestion.nombre = ""; gestion.accion = "";
    await botSay("Claro, te la busco. ¿Con qué teléfono reservaste?",
      () => setInput(true, "Tu teléfono…"));
  };

  const buscaCita = async () => {
    setInput(false); clearQuick();
    const t = typing();
    const res = await agenda({ action: "buscar-cita", telefono: gestion.telefono });
    t.remove();

    if (!res || res._neterr || !res.ok) {
      await botSay("No he podido consultar la agenda ahora mismo. ¿Lo intentamos otra vez?", () => {
        setQuick([{ label: "Probar otra vez" }, { label: "Reservar otra clase" }], (o) => {
          addMsg(o.label, "user");
          if (o.label === "Probar otra vez") buscaCita(); else menuInicial();
        });
      });
      return;
    }

    if (!res.encontrada) {
      await botSay("No encuentro ninguna reserva futura con ese teléfono. Puede que reservaras con otro número, o que ya haya pasado.");
      await botSay("¿Quieres probar con otro teléfono o te busco plaza en otra clase?", () => {
        setQuick([{ label: "Probar con otro teléfono" }, { label: "Reservar otra clase" }], (o) => {
          addMsg(o.label, "user");
          if (o.label === "Probar con otro teléfono") askGestionTel(); else menuInicial();
        });
      });
      return;
    }

    gestion.cita = res.cita;
    /* Se enseña la clase, la fecha y la hora, pero NO el nombre: es justo el
       dato que se pide después para comprobar que la reserva es de quien
       escribe. */
    tarjetaCita("Esta es tu reserva", [
      ["Clase", res.cita.servicio],
      ["Fecha", res.cita.fecha],
      ["Hora", res.cita.hora],
      ["Lugar", ESTUDIO],
    ]);
    await botSay("¿Qué quieres hacer con ella?", () => {
      setQuick([
        { label: "Cambiar el día y la hora", accion: "cambiar" },
        { label: "Cancelar la reserva", accion: "cancelar" },
        { label: "Dejarla como está", accion: "nada" },
      ], (o) => {
        addMsg(o.label, "user");
        if (o.accion === "nada") { cierreGestion("Perfecto, no toco nada: tu reserva sigue igual."); return; }
        gestion.accion = o.accion;
        askGestionNombre();
      });
    });
  };

  const askGestionNombre = async () => {
    step = "g-nombre";
    clearQuick();
    await botSay("Solo para asegurarme de que es tuya: ¿a nombre de quién está la reserva?",
      () => setInput(true, "Nombre de la reserva…"));
  };

  /* Con el nombre ya dado se comprueba ANTES de nada. Si no se comprobara
     aquí, quien se equivoca de nombre elegiría día y hora para toparse con el
     rechazo al final, después de todo el trabajo. La acción que muta vuelve a
     comprobarlo por su cuenta: esto es comodidad, no la barrera. */
  const sigueGestion = async () => {
    setInput(false); clearQuick();
    const t = typing();
    const res = await agenda({
      action: "comprobar-nombre",
      telefono: gestion.telefono,
      nombre: gestion.nombre,
    });
    t.remove();

    if (!res || res._neterr || !res.ok) {
      await botSay("No he podido comprobarlo ahora mismo. ¿Lo intentamos otra vez?", () => {
        setQuick([{ label: "Probar otra vez" }], () => { addMsg("Probar otra vez", "user"); sigueGestion(); });
      });
      return;
    }
    if (res.reason === "sin-cita") { sinCitaYa(); return; }
    if (!res.coincide) { nombreNoCuadra(); return; }

    if (gestion.accion === "cancelar") { cancelaCita(); return; }
    if (!vista) { const d = hoy(); vista = new Date(d.getFullYear(), d.getMonth(), 1); }
    step = "fecha";
    await botSay("Perfecto. ¿Qué día te viene mejor ahora?", () => {
      setInput(false, "Elige un día en el calendario");
      pintaCalendario();
    });
  };

  /* Nombre que no cuadra: se deja reintentar, pero sin pistas sobre cuál es
     el correcto. */
  const nombreNoCuadra = async () => {
    gestion.nombre = "";
    await botSay("Ese nombre no me cuadra con la reserva. ¿Lo repasas? Escríbelo tal y como lo diste al pedir la cita.", () => {
      step = "g-nombre";
      setInput(true, "Nombre de la reserva…");
    });
  };

  const sinCitaYa = async () => {
    await botSay("Vaya, ya no encuentro esa reserva. Puede que la acaben de cancelar desde el estudio.", () => {
      setQuick([{ label: "Reservar otra clase" }], (o) => { addMsg(o.label, "user"); menuInicial(); });
    });
  };

  const cancelaCita = async () => {
    setInput(false); clearQuick();
    const t = typing();
    const res = await agenda({
      action: "cancelar-cita",
      telefono: gestion.telefono,
      nombre: gestion.nombre,
    });
    t.remove();

    if (!res || res._neterr) {
      await botSay("No he podido conectar con la agenda. Tu reserva sigue en pie; inténtalo de nuevo en un momento.");
      cierreGestion();
      return;
    }
    if (res.ok === false && res.reason === "nombre-no-coincide") { nombreNoCuadra(); return; }
    if (res.ok === false && res.reason === "sin-cita") { sinCitaYa(); return; }
    if (!res.ok) { await botSay("No he podido cancelarla. Vuelve a intentarlo en un momento, por favor."); cierreGestion(); return; }

    step = "done";
    tarjetaCita("Reserva cancelada", [
      ["Clase", res.servicio],
      ["Fecha", res.fecha],
      ["Hora", res.hora],
      ["Estado", "Cancelada"],
    ]);
    setTimeout(() => addMsg(
      "Listo, esa plaza vuelve a estar libre. Cuando quieras volver, dímelo y te busco hueco.", "bot"), 700);
  };

  const confirmaCambio = async (iso, fecha) => {
    setInput(false); clearQuick();
    const t = typing();
    const res = await agenda({
      action: "reprogramar-cita",
      telefono: gestion.telefono,
      nombre: gestion.nombre,
      cita_at: iso,
    });
    t.remove();

    if (!res || res._neterr) {
      await botSay("No he podido conectar con la agenda. Tu reserva sigue en la hora de antes; inténtalo de nuevo en un momento.");
      cierreGestion();
      return;
    }
    if (res.ok === false && res.reason === "hueco-ocupado") {
      await botSay("Vaya, esa plaza la acaban de coger. Te enseño las horas que siguen libres ese día.");
      askHora(fecha);
      return;
    }
    if (res.ok === false && res.reason === "nombre-no-coincide") { nombreNoCuadra(); return; }
    if (res.ok === false && res.reason === "sin-cita") { sinCitaYa(); return; }
    if (!res.ok) { await botSay("No he podido cambiarla. Vuelve a intentarlo en un momento, por favor."); cierreGestion(); return; }

    step = "done";
    tarjetaCita("¡Reserva cambiada!", filasCita({
      nombre: gestion.nombre,
      telefono: gestion.telefono,
      servicio: res.servicio,
      fecha: res.fecha,
      hora: res.hora,
    }));
    setTimeout(() => addMsg(CIERRE_CITA, "bot"), 700);
  };

  const cierreGestion = (texto) => {
    step = "done";
    modo = "reserva";
    setInput(false); clearQuick(); quitaWidget();
    if (texto) addMsg(texto, "bot");
  };

  /* ---------- entrada de texto ---------- */
  /* Guard: mínimo 9 dígitos reales (admite prefijo +34 / 0034 y separadores). */
  const isPhone = (v) => {
    const d = String(v).replace(/\D/g, "").replace(/^(?:0034|34)(?=[6-9]\d{8})/, "");
    return d.length >= 9 && /^[6-9]\d{8,}$/.test(d);
  };
  const handleText = (raw) => {
    const v = raw.trim();
    if (!v) return;
    addMsg(v, "user");
    input.value = "";
    if (step === "name") {
      if (v.length < 2) { botSay("¿Me dices tu nombre, por favor?"); return; }
      lead.nombre = v; setInput(false); askPhone();
    } else if (step === "phone") {
      if (!isPhone(v)) { botSay("Ese teléfono no parece válido. Escríbelo con 9 dígitos, por favor."); return; }
      lead.telefono = v; setInput(false); askFecha();
    } else if (step === "g-tel") {
      if (!isPhone(v)) { botSay("Ese teléfono no parece válido. Escríbelo con 9 dígitos, por favor."); return; }
      gestion.telefono = v; setInput(false); buscaCita();
    } else if (step === "g-nombre") {
      if (v.length < 2) { botSay("¿Me dices el nombre de la reserva, por favor?"); return; }
      gestion.nombre = v; setInput(false); sigueGestion();
    }
  };

  form.addEventListener("submit", (e) => { e.preventDefault(); handleText(input.value); });

  /* Con nombre y teléfono ya tenemos un lead válido. Si se marcha en mitad
     del calendario, se manda igual al salir de la página: mejor un lead sin
     franja que ningún lead. */
  window.addEventListener("pagehide", () => {
    if (!enviado && lead.nombre && lead.telefono) enviarLead();
  });

  /* ---------- envío del lead ----------
     Patrón WhiteMoon: las dos cosas salen EN PARALELO, no encadenadas. Si
     una falla, la otra ni se entera.

       1) INSERT en leads_web con la clave PUBLICABLE (solo INSERT vía RLS).
          Va con keepalive para sobrevivir al cierre de la pestaña, y se
          reintenta UNA vez si PostgREST devuelve 503 (el proyecto acaba de
          despertar): con un solo reintento el lead se salva sin arriesgar
          duplicados por insistir.

       2) AVISO a `yoga-notify`, que notifica por Telegram. Va por
          navigator.sendBeacon, que el navegador se lleva aunque el visitante
          cierre la pestaña justo después de dejar el teléfono — que es
          exactamente cuando se pierden los avisos con fetch. sendBeacon exige
          un tipo CORS-safelisted, así que el cuerpo viaja como Blob
          text/plain;charset=UTF-8 y NO como application/json: ese content-type
          dispararía un preflight que sendBeacon no sabe hacer. La función lo
          parsea igual con req.json(), que no mira el content-type.

     Ningún token ni secreto vive en este fichero. */

  /* INSERT en leads_web. Un único reintento ante 503. */
  const insertaLead = (fila, reintentos) =>
    fetch(LEADS_URL, {
      method: "POST",
      keepalive: true,
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(fila),
    }).then((r) => {
      if (r.status === 503 && reintentos > 0) {
        console.warn("[zoe] leads_web 503, reintentando una vez");
        return new Promise((ok) => setTimeout(ok, 800))
          .then(() => insertaLead(fila, reintentos - 1));
      }
      if (!r.ok) console.warn("[zoe] leads_web:", r.status);
      return r.ok;
    }).catch((e) => {
      console.warn("[zoe] leads_web error:", e);
      return false;
    });

  /* Aviso a la Edge Function. sendBeacon devuelve false si el navegador no lo
     encola (cuerpo demasiado grande, o no existe la API); en ese caso se cae
     a un fetch normal con keepalive para no perder el aviso. */
  const avisa = (cuerpo) => {
    const texto = JSON.stringify(cuerpo);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([texto], { type: "text/plain;charset=UTF-8" });
        if (navigator.sendBeacon(NOTIFY_FN, blob)) return Promise.resolve(true);
      }
    } catch (e) {
      console.warn("[zoe] sendBeacon error:", e);
    }
    return fetch(NOTIFY_FN, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: texto,
      keepalive: true,
    }).then((r) => {
      if (!r.ok) console.warn("[zoe] notify:", r.status);
      return r.ok;
    }).catch((e) => {
      console.warn("[zoe] notify error:", e);
      return false;
    });
  };

  async function enviarLead() {
    if (enviado) return true;
    enviado = true;

    const cuando = lead.diaISO && lead.hora
      ? " · Clase: " + lead.dia + " a las " + lead.hora
      : "";

    const insert = insertaLead({
      nombre: lead.nombre,
      telefono: lead.telefono,
      empresa: EMPRESA,
      sector: SECTOR,
      interes: lead.interes,
      mensaje: "Clase: " + lead.servicio + cuando,
      origen: ORIGEN,
      cita_dia: lead.diaISO || null,
      cita_hora: lead.hora || null,
    }, 1);

    /* UN SOLO Telegram por evento. Cuando `reservar` sale bien, `yoga-cita`
       ya ha mandado su "🧘 NUEVA RESERVA": disparar aquí además el aviso de
       lead dejaría dos mensajes por la misma solicitud. Con cita_id el aviso
       ya está dado; sin él, este es el único. */
    const notify = lead.citaId ? Promise.resolve(true) : avisa({
      empresa: EMPRESA,
      nombre: lead.nombre,
      telefono: lead.telefono,
      sector: SECTOR,
      motivo: lead.servicio,
      interes: lead.interes,
      dia: lead.dia,
      hora: lead.hora,
      reservada: false,
      origen: ORIGEN,
    });

    const [inserted] = await Promise.all([insert, notify]);
    return inserted;
  }

  /* ---------- abrir / cerrar ---------- */
  const open = (servicio) => {
    panel.classList.add("open");
    /* Cerrado el panel es invisible pero sus botones seguirían siendo
       enfocables con el teclado: inert los saca del recorrido de tabulación. */
    panel.removeAttribute("inert");
    if (btn) btn.style.display = "none";
    /* Se cerró el chat con algo ya resuelto y se vuelve a abrir: el cierre de
       una cita invita justo a esto ("vuelve a hablar conmigo"), así que hay
       que dar salida en vez de dejar el campo bloqueado. */
    if (started && step === "done") {
      botSay("¿Te ayudo con algo más?", () => {
        setQuick([
          { label: "Cambiar o cancelar mi reserva", gestion: true },
          { label: "Reservar otra clase" },
        ], (o) => {
          addMsg(o.label, "user");
          if (o.gestion) askGestionTel(); else menuInicial();
        });
      });
      return;
    }
    start();
    /* Si vienen de una tarjeta de clase, saltamos la elección de categoría. */
    if (servicio && step === "work") {
      setTimeout(() => {
        if (step !== "work") return;
        addMsg(servicio, "user");
        pickWork(servicio);
      }, 900);
    }
  };
  const close = () => {
    panel.classList.remove("open");
    panel.setAttribute("inert", "");
    if (btn) btn.style.display = "";
    if (btn) btn.focus();
  };
  btn && btn.addEventListener("click", () => open());
  $(".zoe-head__close", panel).addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) close();
  });
  document.querySelectorAll("[data-zoe]").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); open(el.dataset.clase); })
  );
})();
