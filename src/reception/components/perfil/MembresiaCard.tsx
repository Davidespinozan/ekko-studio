import { BadgeCheck, RefreshCw, Repeat, PauseCircle, PlayCircle, Coins, CircleSlash } from 'lucide-react';
import type { MembresiaVigente } from '@shared/hooks/useMembresiaVigente';
import { ESTADO_MEMBRESIA_LABEL, esPaqueteDeCreditos } from '@shared/lib/membresiaEstado';
import { accionesDeMembresia, ACCION_MEMBRESIA_LABEL, type AccionMembresia } from '@shared/lib/membresiaAcciones';
import { formatFechaEnZona } from '@shared/lib/timezone';
import { ErrorCarga } from '@shared/components/ErrorCarga';

const ICONO: Record<AccionMembresia, typeof BadgeCheck> = {
  asignar: BadgeCheck,
  renovar: RefreshCw,
  cambiar: Repeat,
  pausar: PauseCircle,
  reanudar: PlayCircle,
  ajustar_creditos: Coins,
  dar_de_baja: CircleSlash
};

/** Qué le dice la tarjeta a recepción en cada estado: la frase que explica el botón. */
function explicacion(estado: string, sinCreditos: boolean, m: MembresiaVigente | null): string | null {
  if (!m) return 'No tiene un plan vigente: no puede reservar hasta que se le asigne uno.';
  if (estado === 'pausada') return 'En pausa: no se le cobra ni puede reservar hasta reanudarla.';
  if (sinCreditos) return 'Se le acabaron los créditos: no puede reservar hasta renovar.';
  if (estado === 'vencida') {
    return m.stripe_subscription_id
      ? 'La fecha ya pasó, pero tiene suscripción: Stripe la renueva sola cuando entra el cobro.'
      : 'Venció: no puede reservar hasta renovar.';
  }
  if (estado === 'pago_pendiente') return 'La tarjeta rechazó el último cobro. Stripe reintenta; mientras tanto conserva el acceso.';
  if (m.cancel_at_period_end) return 'Pidió la baja: no se renovará al terminar el periodo.';
  return null;
}

/**
 * Tarjeta de MEMBRESÍA de la ficha de recepción: estado real (desde `membresias`)
 * y las acciones que corresponden a ESE estado — ver `accionesDeMembresia`.
 * Sustituye al "Activar membresía" que dependía del status de la cuenta.
 */
export function MembresiaCard({
  membresia,
  cargando,
  error = false,
  onReintentar,
  onAccion
}: {
  membresia: MembresiaVigente | null;
  cargando: boolean;
  /** PKG-02A: la lectura falló. NO es "sin membresía": sin acciones basadas en ausencia. */
  error?: boolean;
  onReintentar?: () => void;
  onAccion: (a: AccionMembresia) => void;
}) {
  if (cargando) {
    return <div className="ek-skeleton" style={{ height: '96px', borderRadius: 'var(--ek-r-md)', marginBottom: '16px' }} />;
  }

  // Error de lectura: no se sabe si tiene plan. Ni "SIN MEMBRESÍA" ni "Asignar
  // plan" (vendería/negaría con datos falsos). Solo el fallo y reintentar.
  if (error) {
    return (
      <section className="ek-card" data-testid="membresia-card" style={{ marginBottom: '16px', borderLeft: '3px solid var(--ek-danger)' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 8px' }}>MEMBRESÍA</p>
        <ErrorCarga
          titulo="No pudimos cargar la membresía."
          hint="No sabemos si tiene un plan vigente. Reintenta antes de asignar, renovar o dar de baja."
          onReintentar={onReintentar}
        />
      </section>
    );
  }

  const { estado, sinCreditos, principal, secundarias } = accionesDeMembresia(membresia);
  const etiqueta = ESTADO_MEMBRESIA_LABEL[sinCreditos && estado !== 'pausada' ? 'vencida' : estado];
  const paquete = esPaqueteDeCreditos(membresia?.tier?.tipo);
  const fin = membresia?.periodo_actual_fin
    ? formatFechaEnZona(membresia.periodo_actual_fin, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const nota = explicacion(estado, sinCreditos, membresia);
  const atencion = principal !== null;

  return (
    <section
      className="ek-card"
      data-testid="membresia-card"
      style={{
        marginBottom: '16px',
        borderLeft: `3px solid ${atencion ? etiqueta.color : 'var(--ek-line)'}`
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>MEMBRESÍA</p>
        <span style={{ color: etiqueta.color, fontWeight: 700, letterSpacing: '0.08em', fontSize: '11px' }}>
          {sinCreditos && estado !== 'pausada' ? 'SIN CRÉDITOS' : etiqueta.texto}
        </span>
      </div>

      {membresia && (
        <p style={{ fontSize: '15px', fontWeight: 600, margin: '8px 0 2px' }}>
          {membresia.tier?.nombre ?? 'Plan'}
          {paquete && (
            <span style={{ fontWeight: 500, color: 'var(--ek-ink-muted)' }}>
              {' '}· {membresia.creditos_restantes ?? 0} {membresia.creditos_restantes === 1 ? 'crédito' : 'créditos'}
            </span>
          )}
        </p>
      )}
      {membresia && fin && (
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          {paquete ? 'Caducan el ' : estado === 'vencida' ? 'Venció el ' : membresia.stripe_subscription_id && !membresia.cancel_at_period_end ? 'Se renueva el ' : 'Vence el '}
          {fin}
        </p>
      )}
      {nota && (
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '8px 0 0', lineHeight: 1.45 }}>{nota}</p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
        {principal && (
          <BotonAccion accion={principal} principal onClick={() => onAccion(principal)} />
        )}
        {secundarias.map((a) => (
          <BotonAccion key={a} accion={a} onClick={() => onAccion(a)} />
        ))}
      </div>
    </section>
  );
}

function BotonAccion({ accion, principal = false, onClick }: { accion: AccionMembresia; principal?: boolean; onClick: () => void }) {
  const Icono = ICONO[accion];
  return (
    <button
      type="button"
      onClick={onClick}
      className={principal ? 'ek-cta ek-cta--gold' : 'ek-cta ek-cta--secondary'}
      style={{
        minHeight: '40px',
        padding: '8px 14px',
        fontSize: '13px',
        ...(accion === 'dar_de_baja' ? { color: 'var(--ek-ink-muted)' } : {})
      }}
    >
      <Icono size={15} aria-hidden="true" /> {ACCION_MEMBRESIA_LABEL[accion]}
    </button>
  );
}
