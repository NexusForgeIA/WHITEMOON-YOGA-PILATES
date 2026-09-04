-- =====================================================================
-- Agenda de la demo Whitemoon · Yoga & Pilates.
--
-- Espeja tabla a tabla el esquema de la demo de peluquería (_peluqueria),
-- con el vocabulario del sector: la columna `servicio` guarda el nombre de
-- la clase (Yoga, Yoga suave, Pilates suelo, Pilates máquina, Meditación).
--
-- RLS: igual que en _peluqueria — activada y SIN ninguna policy. Nadie que
-- llegue con la clave publicable puede leer ni escribir; la única vía es la
-- Edge Function `yoga-cita`, que usa la service role y salta RLS. El chat de
-- la web no toca estas tablas: solo INSERTa en leads_web.
-- =====================================================================

-- ---------- CLIENTES ----------
create table if not exists public.clientes_yoga (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  nombre      text not null,
  telefono    text not null,
  telefono_norm text not null,
  notas       text,
  updated_at  timestamptz not null default now()
);
-- Clave de teléfono: los últimos 9 dígitos. Quien reserva como "600 123 456"
-- y luego busca su reserva como "+34 600123456" es la misma persona.
create unique index if not exists clientes_yoga_tel_norm_idx
  on public.clientes_yoga (telefono_norm);

-- ---------- CITAS ----------
create table if not exists public.citas_yoga (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  cliente_nombre   text not null,
  cliente_telefono text not null,
  cliente_id       uuid references public.clientes_yoga(id) on delete set null,
  servicio         text not null,
  duracion_min     integer not null default 60,
  cita_at          timestamptz not null,
  estado           text not null default 'agendada',
  resena_enviada   boolean not null default false,
  notas            text,
  origen           text not null default 'chatbot',
  -- Columna generada: los últimos 9 dígitos del teléfono. Es lo que usan
  -- buscar-cita / cancelar-cita / reprogramar-cita para resolver la reserva
  -- por número sin que el visitante escriba nada más en el chat.
  cliente_telefono_norm text generated always as
    (right(regexp_replace(cliente_telefono, '\D', '', 'g'), 9)) stored
);
create index if not exists citas_yoga_cita_at_idx  on public.citas_yoga (cita_at);
create index if not exists citas_yoga_cliente_idx  on public.citas_yoga (cliente_id);
create index if not exists citas_yoga_tel_norm_idx on public.citas_yoga (cliente_telefono_norm, cita_at);

-- ---------- LOG ----------
create table if not exists public.citas_yoga_log (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  cita_id    uuid,
  accion     text not null,
  detalle    text
);

-- ---------- CLASES (catálogo con precio y duración) ----------
create table if not exists public.servicios_yoga (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null unique,
  duracion_min integer not null default 60,
  precio_eur   numeric not null default 0,
  activo       boolean not null default true,
  orden        integer not null default 0,
  updated_at   timestamptz not null default now()
);

-- ---------- CONFIG DEL ESTUDIO ----------
-- Se mantienen los nombres de columna de _peluqueria (salon_nombre, …) para
-- que el panel y la Edge Function sean clones exactos.
create table if not exists public.yoga_config (
  id             smallint primary key default 1,
  salon_nombre   text not null default '',
  gerente_nombre text not null default '',
  wa_number      text not null default '',
  gmb_url        text not null default '',
  updated_at     timestamptz not null default now()
);

-- ---------- VISTA DE RESUMEN DE CLIENTES ----------
create or replace view public.clientes_yoga_resumen as
  select p.id,
         p.nombre,
         p.telefono,
         p.notas,
         p.created_at,
         count(c.id)     as n_citas,
         max(c.cita_at)  as ultima_cita
    from public.clientes_yoga p
    left join public.citas_yoga c
      on c.cliente_id = p.id and c.estado <> 'cancelada'
   group by p.id;

-- ---------- RLS ----------
alter table public.clientes_yoga  enable row level security;
alter table public.citas_yoga     enable row level security;
alter table public.citas_yoga_log enable row level security;
alter table public.servicios_yoga enable row level security;
alter table public.yoga_config    enable row level security;

-- ---------- SEMILLA ----------
insert into public.yoga_config (id, salon_nombre, gerente_nombre)
values (1, 'Whitemoon · Yoga & Pilates', '')
on conflict (id) do nothing;

insert into public.servicios_yoga (nombre, duracion_min, precio_eur, orden) values
  ('Yoga',            60, 14, 1),
  ('Yoga suave',      60, 14, 2),
  ('Pilates suelo',   55, 16, 3),
  ('Pilates máquina', 55, 24, 4),
  ('Meditación',      45, 10, 5)
on conflict (nombre) do nothing;
