import { useMembresiaVigente, type MembresiaVigente } from '@shared/hooks/useMembresiaVigente';
import { estadoMembresia, ESTADO_MEMBRESIA_LABEL, esPaqueteDeCreditos } from '@shared/lib/membresiaEstado';
import { formatFechaEnZona } from '@shared/lib/timezone';

interface Props {
  usuarioId: string;
  /** 'linea' = una línea compacta (check-in); 'detalle' = estado + vence/créditos (ficha). */
  variante?: 'linea' | 'detalle';
  /**
   * Membresía ya cargada por la pantalla (`null` = sin membresía). Si se pasa, el
   * componente NO consulta por su cuenta: la ficha tiene UNA sola fuente y se
   * refresca junta. Antes esta instancia solo cargaba al montar y, tras activar o
   * pausar, seguía diciendo "sin membresía" → recepción repetía la acción.
   */
  membresia?: MembresiaVigente | null;
}

/**
 * Vigencia real de la membresía (desde `membresias`): estado derivado por
 * fecha, vence/renueva o créditos restantes. Antes recepción solo veía el chip
 * del tier de `usuarios`, que no dice si el plan sigue vigente ni cuántos
 * créditos quedan. (SALA f4ea7ac / bca45ce.)
 */
export function VigenciaMembresia({ usuarioId, variante = 'detalle', membresia: controlada }: Props) {
  const esControlada = controlada !== undefined;
  const propia = useMembresiaVigente(esControlada ? null : usuarioId);
  const membresia = esControlada ? controlada : propia.membresia;
  const isLoading = esControlada ? false : propia.isLoading;
  if (isLoading) return <span style={{ fontSize: '12px', color: 'var(--ek-ink-faint)' }}>…</span>;
  // PKG-02A (C02): la consulta falló → "no disponible", nunca "SIN MEMBRESÍA".
  if (!esControlada && propia.error) {
    return (
      <span data-testid="vigencia-membresia" role="alert" style={{ fontSize: '11px', color: 'var(--ek-danger)', fontWeight: 700, letterSpacing: '0.08em' }}>
        MEMBRESÍA NO DISPONIBLE
      </span>
    );
  }

  const estado = estadoMembresia(membresia);
  const { texto, color } = ESTADO_MEMBRESIA_LABEL[estado];
  const paquete = esPaqueteDeCreditos(membresia?.tier?.tipo);
  const fin = membresia?.periodo_actual_fin
    ? formatFechaEnZona(membresia.periodo_actual_fin, { day: 'numeric', month: 'short' })
    : null;
  const detalle = !membresia
    ? null
    : paquete
      ? `${membresia.creditos_restantes ?? 0} crédito${(membresia.creditos_restantes ?? 0) === 1 ? '' : 's'}${fin ? ` · caducan ${fin}` : ''}`
      : fin
        ? `${estado === 'vencida' ? 'venció' : 'vence'} ${fin}`
        : null;

  if (variante === 'linea') {
    return (
      <span data-testid="vigencia-membresia" style={{ fontSize: '12px', display: 'inline-flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ color, fontWeight: 700, letterSpacing: '0.08em', fontSize: '11px' }}>{texto}</span>
        {detalle && <span style={{ color: 'var(--ek-ink-muted)' }}>{detalle}</span>}
      </span>
    );
  }

  return (
    <div data-testid="vigencia-membresia" style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-end' }}>
      <span style={{ color, fontWeight: 700, letterSpacing: '0.08em', fontSize: '11px' }}>{texto}</span>
      {detalle && <span style={{ fontSize: '12px', color: 'var(--ek-ink-muted)' }}>{detalle}</span>}
    </div>
  );
}
