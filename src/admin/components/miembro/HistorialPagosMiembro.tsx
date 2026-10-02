import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { formatFechaHoraEnZona } from '@shared/lib/timezone';

interface Pago {
  id: string;
  created_at: string;
  monto_centavos: number | null;
  moneda: string | null;
  status: string | null;
  stripe_event_type: string;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
}

const LABEL_STATUS: Record<string, { texto: string; color: string }> = {
  succeeded: { texto: 'Cobrado', color: 'var(--ek-success)' },
  failed: { texto: 'Rechazado', color: 'var(--ek-danger)' },
  refunded: { texto: 'Reembolsado', color: 'var(--ek-mustard)' },
  // PKG-01G: reversals con identidad propia (reversales_pago).
  'reembolso:pending': { texto: 'Reembolso en proceso', color: 'var(--ek-mustard)' },
  'reembolso:succeeded': { texto: 'Reembolsado', color: 'var(--ek-mustard)' },
  'reembolso:failed': { texto: 'Reembolso fallido', color: 'var(--ek-danger)' },
  'reembolso:canceled': { texto: 'Reembolso cancelado', color: 'var(--ek-ink-muted)' },
  'reembolso:requires_action': { texto: 'Reembolso requiere acción', color: 'var(--ek-warning)' },
  'disputa:won': { texto: 'Disputa ganada', color: 'var(--ek-success)' },
  'disputa:lost': { texto: 'Disputa perdida', color: 'var(--ek-danger)' },
  'disputa:warning_closed': { texto: 'Alerta de disputa cerrada', color: 'var(--ek-ink-muted)' }
};

/** Fila unificada: cobro (payment_events) o reversal (reversales_pago). */
interface Fila {
  id: string;
  fecha: string;
  concepto: string;
  monto_centavos: number | null;
  moneda: string | null;
  statusKey: string;
  statusFallback: string;
}

function pesos(centavos: number | null, moneda: string | null): string {
  if (centavos === null) return '—';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: (moneda ?? 'mxn').toUpperCase() }).format(centavos / 100);
}

function concepto(tipo: string): string {
  if (tipo === 'invoice.paid') return 'Mensualidad';
  if (tipo === 'invoice.payment_failed') return 'Mensualidad (cobro rechazado)';
  if (tipo === 'payment_intent.succeeded') return 'Pago único (paquete / invitados)';
  if (tipo === 'charge.refunded') return 'Reembolso';
  return tipo;
}

/**
 * Historial de cobros del miembro para el ADMIN, desde `payment_events` (la
 * tabla la llena el webhook; RLS admin-only). El miembro ya veía el suyo vía
 * stripe-billing-info; el admin no tenía ninguna vista. (SALA a49c0a8.)
 */
export function HistorialPagosMiembro({ usuarioId }: { usuarioId: string }) {
  const [pagos, setPagos] = useState<Fila[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [{ data, error: err }, { data: reversales, error: errRv }] = await Promise.all([
          supabase
            .from('payment_events')
            .select('id, created_at, monto_centavos, moneda, status, stripe_event_type, stripe_invoice_id, stripe_payment_intent_id')
            .eq('usuario_id', usuarioId)
            .order('created_at', { ascending: false })
            .limit(24),
          supabase
            .from('reversales_pago')
            .select('id, tipo, monto_centavos, moneda, estado_proveedor, stripe_created_at, created_at')
            .eq('usuario_id', usuarioId)
            .order('created_at', { ascending: false })
            .limit(24)
        ]);
        if (!mounted) return;
        if (err || errRv) {
          console.error('[HistorialPagosMiembro]', err ?? errRv);
          setError(true);
          setPagos([]);
          return;
        }
        const filas: Fila[] = [
          ...((data ?? []) as Pago[]).map((p) => ({
            id: p.id,
            fecha: p.created_at,
            concepto: concepto(p.stripe_event_type),
            monto_centavos: p.monto_centavos,
            moneda: p.moneda,
            statusKey: p.status ?? '',
            statusFallback: p.status ?? '—'
          })),
          ...((reversales ?? []) as Array<{ id: string; tipo: string; monto_centavos: number; moneda: string; estado_proveedor: string; stripe_created_at: string | null; created_at: string }>).map((r) => ({
            id: `rv-${r.id}`,
            fecha: r.stripe_created_at ?? r.created_at,
            concepto: r.tipo === 'reembolso' ? 'Reembolso (Stripe)' : 'Disputa del cobro',
            monto_centavos: r.monto_centavos,
            moneda: r.moneda,
            statusKey: `${r.tipo}:${r.estado_proveedor}`,
            statusFallback: r.tipo === 'disputa' ? `Disputa: ${r.estado_proveedor}` : r.estado_proveedor
          }))
        ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
        setPagos(filas);
      } catch (e) {
        if (!mounted) return;
        console.error('[HistorialPagosMiembro]', e instanceof Error ? e.message : e);
        setError(true);
        setPagos([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [usuarioId]);

  if (pagos === null) return <p className="adm-body" style={{ fontSize: '13px' }}>Cargando cobros…</p>;
  if (error) return <p className="ek-error-text">No se pudo cargar el historial de cobros.</p>;
  if (pagos.length === 0) {
    return <p className="adm-body" style={{ fontSize: '13px' }}>Sin cobros registrados por Stripe todavía.</p>;
  }

  return (
    <div className="adm-table-wrapper">
      <table className="adm-table" data-testid="historial-pagos">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Concepto</th>
            <th>Monto</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {pagos.map((p) => {
            const st = LABEL_STATUS[p.statusKey] ?? { texto: p.statusFallback, color: 'var(--ek-ink-muted)' };
            return (
              <tr key={p.id}>
                <td style={{ whiteSpace: 'nowrap', color: 'var(--ek-ink-muted)', fontSize: '13px' }}>
                  {formatFechaHoraEnZona(p.fecha, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td>{p.concepto}</td>
                <td style={{ fontFamily: 'var(--ek-font-mono)' }}>{pesos(p.monto_centavos, p.moneda)}</td>
                <td style={{ color: st.color, fontWeight: 600, fontSize: '13px' }}>{st.texto}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
