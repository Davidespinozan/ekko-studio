import type { MembresiaActualAdmin } from '../../hooks/useAdminData';
import { estadoMembresia as estadoDe, ESTADO_MEMBRESIA_LABEL as LABEL, esPaqueteDeCreditos } from '@shared/lib/membresiaEstado';

// Re-export: la lógica de estado vive en shared (la usan admin y recepción).
export { estadoMembresia, type EstadoMembresiaUI } from '@shared/lib/membresiaEstado';

interface Props {
  membresia: MembresiaActualAdmin | null;
  isLoading: boolean;
  /** usuarios.membresia_tier — lo que el miembro debe pagar; puede no estar activado aún. */
  planAsignado: string | null;
}

/**
 * La membresía del miembro tal como la ven recepción, reportes y el webhook
 * (tabla `membresias`), no el `membresia_tier` suelto de `usuarios`. Si el plan
 * asignado no coincide con la membresía vigente, lo dice: esa divergencia era
 * invisible para el admin.
 */
export function MembresiaActualCard({ membresia, isLoading, planAsignado }: Props) {
  if (isLoading) return <p className="adm-body" style={{ fontSize: '13px' }}>Cargando membresía…</p>;

  const estado = estadoDe(membresia);
  const { texto, color } = LABEL[estado];
  const esPaquete = esPaqueteDeCreditos(membresia?.tier?.tipo);
  const desfase = membresia && planAsignado && membresia.tier?.slug !== planAsignado;

  return (
    <div className="adm-info-grid" data-testid="membresia-actual">
      <Dato label="Estado">
        <span style={{ color, fontWeight: 700, letterSpacing: '0.08em', fontSize: '12px' }}>{texto}</span>
      </Dato>
      <Dato label="Plan vigente">
        {membresia?.tier?.nombre ?? '—'}
        {desfase && (
          <span style={{ display: 'block', fontSize: '11px', color: 'var(--ek-mustard)' }}>
            Plan asignado distinto ({planAsignado}): pendiente de pago/activación
          </span>
        )}
        {!membresia && planAsignado && (
          <span style={{ display: 'block', fontSize: '11px', color: 'var(--ek-mustard)' }}>
            Plan asignado ({planAsignado}) sin activar todavía
          </span>
        )}
      </Dato>
      <Dato label={esPaquete ? 'Créditos restantes' : 'Vence / renueva'}>
        {esPaquete
          ? `${membresia?.creditos_restantes ?? 0}${membresia?.periodo_actual_fin ? ` · caducan ${fecha(membresia.periodo_actual_fin)}` : ''}`
          : membresia?.periodo_actual_fin
            ? fecha(membresia.periodo_actual_fin)
            : '—'}
      </Dato>
      <Dato label="Cobro">
        {!membresia
          ? '—'
          : membresia.stripe_subscription_id
            ? `Stripe${membresia.cancel_at_period_end ? ' · cancela al final del periodo' : ''}`
            : 'Manual / mostrador'}
      </Dato>
    </div>
  );
}

function fecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { timeZone: 'America/Mazatlan', day: 'numeric', month: 'short', year: 'numeric' });
}

function Dato({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="ek-eyebrow" style={{ fontSize: '10px', marginBottom: '4px' }}>{label}</p>
      <div style={{ fontSize: '14px' }}>{children}</div>
    </div>
  );
}
