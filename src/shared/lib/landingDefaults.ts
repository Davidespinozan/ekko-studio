// ============================================================================
// Contenido editable del landing: secciones que antes estaban hardcodeadas en
// el JSX (encabezado de membresías, "Cómo funciona", FAQ, CTA del modal de
// estudio). Ahora viven en tenant.config.landing.* y se editan en
// Admin → Ajustes del Landing.
//
// Los DEFAULT de aquí NO son "hardcode oculto": son el contenido de arranque
// (fallback) de un campo editable, para que el landing nunca se vea vacío antes
// de que el admin lo toque. Se eligieron para el modelo de SOLO CRÉDITOS.
//
// Un parser por sección hace merge no destructivo: lo que el admin guardó gana;
// lo que falte cae al default. Las listas (pasos, faq) usan el array guardado si
// existe (aunque sea vacío = decisión del admin) y el default solo si nunca se
// configuró.
// ============================================================================

export interface PasoComoFunciona {
  titulo: string;
  texto: string;
}

export interface FaqItem {
  q: string;
  a: string;
}

export interface MembresiasConfig {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
}

export interface ComoFuncionaConfig {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  pasos: PasoComoFunciona[];
}

export interface FaqConfig {
  eyebrow: string;
  titulo: string;
  items: FaqItem[];
}

export interface EstudioModalConfig {
  cta_texto: string;
  cta_link: string;
}

export interface EstudiosConfig {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
}

export const MEMBRESIAS_DEFAULT: MembresiasConfig = {
  eyebrow: 'PLANES',
  titulo: 'Elige tu paquete.',
  titulo_accent: 'Graba cuando quieras.'
};

export const COMO_FUNCIONA_DEFAULT: ComoFuncionaConfig = {
  eyebrow: 'CÓMO FUNCIONA',
  titulo: 'De la idea al contenido.',
  titulo_accent: 'En tres pasos.',
  pasos: [
    {
      titulo: 'Reserva tu sesión',
      texto: 'Elige estudio, fecha y horario desde la app. Sin llamadas, sin esperas.'
    },
    {
      titulo: 'Llega y graba',
      texto: 'Equipo profesional ya montado: cámaras, micrófonos, iluminación. Tú solo traés tu contenido.'
    },
    {
      titulo: 'Recibe tu material',
      texto: 'Te entregamos los archivos limpios después de cada sesión. Tú decides cómo publicarlo.'
    }
  ]
};

export const FAQ_DEFAULT: FaqConfig = {
  eyebrow: 'PREGUNTAS FRECUENTES',
  titulo: 'Lo que probablemente quieres saber.',
  items: [
    {
      q: '¿Cómo funcionan los créditos?',
      a: 'Compras un paquete de créditos y cada crédito equivale a una sesión. Los estudios básicos cuestan 1 crédito y los Pro 2. Reservas desde la app cuando quieras.'
    },
    {
      q: '¿Los créditos vencen?',
      a: 'Sí. Cada paquete tiene una vigencia (por ejemplo 90 días) que ves al comprar y en tu cuenta. Aprovecha tus sesiones antes de esa fecha.'
    },
    {
      q: '¿Qué incluye cada sesión?',
      a: 'El estudio con todo el equipo profesional ya montado (cámaras, micrófonos, iluminación), espacio para invitados y la reserva vía app.'
    },
    {
      q: '¿Puedo cancelar una reserva?',
      a: 'Sí. Puedes cancelarla con anticipación a través de WhatsApp para evitar una amonestación por inasistencia.'
    },
    {
      q: '¿Qué pasa si no llego a mi reserva?',
      a: 'Las inasistencias sin aviso pueden bloquear tu cuenta temporalmente. Si avisas con anticipación, cancelas sin penalidad.'
    },
    {
      q: '¿Necesito traer mi propio equipo?',
      a: 'No. Cada estudio tiene su equipo profesional completo. Solo traes tu contenido y tu disco duro para llevarte el material.'
    },
    {
      q: '¿Cómo pago?',
      a: 'Pagas tu paquete de créditos en línea con tarjeta, en un solo cobro. Sin mensualidades ni compromisos a largo plazo.'
    }
  ]
};

export const ESTUDIO_MODAL_DEFAULT: EstudioModalConfig = {
  cta_texto: 'Ver planes y reservar',
  cta_link: '/signup'
};

// Encabezado de la sección de estudios. Default genérico (no atado a un número
// de estudios) para que no quede desfasado si agregás o quitás estudios.
export const ESTUDIOS_DEFAULT: EstudiosConfig = {
  eyebrow: 'NUESTROS ESPACIOS',
  titulo: 'Nuestros estudios.',
  titulo_accent: 'Una personalidad para cada visión.',
  subtitulo: 'Cada uno diseñado para un tipo de contenido. Elige el que va con tu visión.'
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

export function parseMembresias(raw: unknown): MembresiasConfig {
  const o = asRecord(raw);
  if (!o) return MEMBRESIAS_DEFAULT;
  return {
    eyebrow: str(o.eyebrow, MEMBRESIAS_DEFAULT.eyebrow),
    titulo: str(o.titulo, MEMBRESIAS_DEFAULT.titulo),
    titulo_accent: str(o.titulo_accent, MEMBRESIAS_DEFAULT.titulo_accent)
  };
}

export function parseComoFunciona(raw: unknown): ComoFuncionaConfig {
  const o = asRecord(raw);
  if (!o) return COMO_FUNCIONA_DEFAULT;
  // El array guardado gana (aunque sea vacío); si nunca se configuró → default.
  const pasos = Array.isArray(o.pasos)
    ? o.pasos.map((p) => {
        const po = asRecord(p) ?? {};
        return { titulo: str(po.titulo, ''), texto: str(po.texto, '') };
      })
    : COMO_FUNCIONA_DEFAULT.pasos;
  return {
    eyebrow: str(o.eyebrow, COMO_FUNCIONA_DEFAULT.eyebrow),
    titulo: str(o.titulo, COMO_FUNCIONA_DEFAULT.titulo),
    titulo_accent: str(o.titulo_accent, COMO_FUNCIONA_DEFAULT.titulo_accent),
    pasos
  };
}

export function parseFaq(raw: unknown): FaqConfig {
  const o = asRecord(raw);
  if (!o) return FAQ_DEFAULT;
  const items = Array.isArray(o.items)
    ? o.items.map((it) => {
        const io = asRecord(it) ?? {};
        return { q: str(io.q, ''), a: str(io.a, '') };
      })
    : FAQ_DEFAULT.items;
  return {
    eyebrow: str(o.eyebrow, FAQ_DEFAULT.eyebrow),
    titulo: str(o.titulo, FAQ_DEFAULT.titulo),
    items
  };
}

export function parseEstudioModal(raw: unknown): EstudioModalConfig {
  const o = asRecord(raw);
  if (!o) return ESTUDIO_MODAL_DEFAULT;
  return {
    cta_texto: str(o.cta_texto, ESTUDIO_MODAL_DEFAULT.cta_texto),
    cta_link: str(o.cta_link, ESTUDIO_MODAL_DEFAULT.cta_link)
  };
}

export function parseEstudios(raw: unknown): EstudiosConfig {
  const o = asRecord(raw);
  if (!o) return ESTUDIOS_DEFAULT;
  return {
    eyebrow: str(o.eyebrow, ESTUDIOS_DEFAULT.eyebrow),
    titulo: str(o.titulo, ESTUDIOS_DEFAULT.titulo),
    titulo_accent: str(o.titulo_accent, ESTUDIOS_DEFAULT.titulo_accent),
    subtitulo: str(o.subtitulo, ESTUDIOS_DEFAULT.subtitulo)
  };
}
