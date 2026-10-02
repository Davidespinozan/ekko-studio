import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useRevisionesFinancieras, LABEL_TIPO_REVISION } from '../../hooks/useRevisionesFinancieras';

/**
 * PKG-01G · Banner en la ficha del miembro: revisiones financieras ABIERTAS
 * cuyo reversal (reembolso/disputa) se atribuyó a este miembro. Solo informa y
 * enlaza a Cobros; no ofrece ninguna acción sobre créditos o membresía.
 */
export function AvisoRevisionFinanciera({ usuarioId }: { usuarioId: string }) {
  const { revisiones } = useRevisionesFinancieras({ soloAbiertas: true, usuarioId });
  if (!revisiones || revisiones.length === 0) return null;
  const tipos = Array.from(new Set(revisiones.map((r) => LABEL_TIPO_REVISION[r.tipo] ?? r.tipo)));
  return (
    <div
      className="ek-card"
      role="status"
      data-testid="aviso-revision-financiera"
      style={{ borderColor: 'var(--ek-warning)', display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '16px' }}
    >
      <AlertTriangle size={18} style={{ color: 'var(--ek-warning)', flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
      <div style={{ fontSize: '13.5px' }}>
        <strong>
          {revisiones.length === 1 ? 'Hay una revisión financiera abierta' : `Hay ${revisiones.length} revisiones financieras abiertas`}
        </strong>{' '}
        ({tipos.join(', ')}). El sistema no cambió sus créditos ni su membresía.{' '}
        <Link to="/admin/cobros" style={{ color: 'var(--ek-mustard)' }}>Revisar en Cobros</Link>
      </div>
    </div>
  );
}
