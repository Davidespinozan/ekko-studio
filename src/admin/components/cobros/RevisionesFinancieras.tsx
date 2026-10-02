import { useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Spinner } from '@shared/components/Spinner';
import { formatFechaHoraEnZona } from '@shared/lib/timezone';
import {
  LABEL_RESOLUCION,
  LABEL_TIPO_REVISION,
  useRevisionesFinancieras,
  type ResolucionHumana,
  type RevisionFinanciera
} from '../../hooks/useRevisionesFinancieras';

/**
 * PKG-01G · Lista de revisiones financieras para el ADMIN. Cada reembolso o
 * disputa de Stripe deja evidencia y abre una revisión; aquí se documenta la
 * resolución. Lo que NO hace, a propósito: quitar créditos, cancelar
 * membresías, revocar cuentas, revertir planes ni cancelar reservas. Si el
 * admin decide ajustar algo, lo hace desde la ficha del miembro con las
 * herramientas de siempre y aquí lo deja registrado.
 */

function pesos(centavos: number, moneda: string): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: moneda.toUpperCase() }).format(centavos / 100);
}

const LABEL_ESTADO_PROVEEDOR: Record<string, string> = {
  pending: 'pendiente en Stripe',
  succeeded: 'reembolsado',
  failed: 'reembolso fallido',
  canceled: 'reembolso cancelado',
  requires_action: 'requiere acción en Stripe',
  needs_response: 'requiere respuesta',
  warning_needs_response: 'alerta: requiere respuesta',
  under_review: 'en revisión por el banco',
  warning_under_review: 'alerta: en revisión',
  warning_closed: 'alerta cerrada',
  won: 'ganada',
  lost: 'perdida',
  charge_refunded: 'cargo reembolsado'
};

export function RevisionesFinancieras() {
  const { revisiones, error, resolver } = useRevisionesFinancieras();
  const [abriendo, setAbriendo] = useState<string | null>(null);
  const [resolucion, setResolucion] = useState<ResolucionHumana>('sin_efecto');
  const [nota, setNota] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [verResueltas, setVerResueltas] = useState(false);

  if (revisiones === null) return <div className="ek-card"><Spinner label="Cargando revisiones…" /></div>;
  if (error) return <p className="ek-error-text">No se pudieron cargar las revisiones financieras.</p>;

  const abiertas = revisiones.filter((r) => r.estado === 'abierta');
  const resueltas = revisiones.filter((r) => r.estado === 'resuelta');

  async function guardar(r: RevisionFinanciera) {
    setGuardando(true);
    setMensaje(null);
    const res = await resolver(r.id, resolucion, nota);
    setGuardando(false);
    if (res.error) {
      setMensaje(res.error);
      return;
    }
    setAbriendo(null);
    setNota('');
    setResolucion('sin_efecto');
  }

  return (
    <div className="ek-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} data-testid="revisiones-financieras">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>REVISIONES FINANCIERAS</p>
        <span style={{ fontSize: '13px', color: abiertas.length ? 'var(--ek-warning)' : 'var(--ek-ink-muted)', fontWeight: 600 }}>
          {abiertas.length ? `${abiertas.length} abierta${abiertas.length === 1 ? '' : 's'}` : 'sin pendientes'}
        </span>
      </div>
      <p className="ek-body-muted" style={{ margin: 0, fontSize: '13px' }}>
        Reembolsos y disputas registrados por Stripe. El sistema <strong>no</strong> quita créditos ni cancela membresías por su cuenta:
        revisa cada caso, actúa desde la ficha del miembro si hace falta y deja aquí la resolución.
      </p>

      {abiertas.length === 0 && <p className="ek-body-muted" style={{ margin: 0, fontSize: '13px' }}>No hay revisiones pendientes.</p>}

      {abiertas.map((r) => (
        <div key={r.id} style={{ borderTop: '1px solid var(--ek-line)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }} data-testid="revision-abierta">
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <AlertTriangle size={16} style={{ color: 'var(--ek-warning)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>{LABEL_TIPO_REVISION[r.tipo] ?? r.tipo}</p>
              <p className="ek-body-muted" style={{ margin: '2px 0 0', fontSize: '12.5px' }}>
                {formatFechaHoraEnZona(r.abierta_at, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {r.reversal && (
                  <>
                    {' · '}<span style={{ fontFamily: 'var(--ek-font-mono)' }}>{pesos(r.reversal.monto_centavos, r.reversal.moneda)}</span>
                    {' · '}{LABEL_ESTADO_PROVEEDOR[r.reversal.estado_proveedor] ?? r.reversal.estado_proveedor}
                    {r.reversal.motivo_proveedor ? ` · motivo Stripe: ${r.reversal.motivo_proveedor}` : ''}
                  </>
                )}
                {r.referencia && !r.reversal ? ` · ref ${r.referencia}` : ''}
              </p>
              {r.reversal && (
                <p style={{ margin: '4px 0 0', fontSize: '13px' }}>
                  {r.reversal.usuario_id ? (
                    <>
                      Miembro: <Link to={`/admin/miembros/${r.reversal.usuario_id}`} style={{ color: 'var(--ek-mustard)' }}>{r.miembro_nombre ?? 'ver ficha'}</Link>
                      {r.reversal.membresia_origen_id ? ' · pago de origen identificado' : ' · sin membresía de origen'}
                    </>
                  ) : (
                    <span style={{ color: 'var(--ek-warning)' }}>Pago de origen no identificado: revisa el cargo en Stripe.</span>
                  )}
                  {' · '}<span style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '12px', color: 'var(--ek-ink-muted)' }}>{r.reversal.stripe_object_id}</span>
                </p>
              )}
              {r.tipo === 'cuenta_desautorizada' && (
                <p style={{ margin: '4px 0 0', fontSize: '13px' }}>Reconecta la cuenta desde el botón de activación de esta página. Las membresías vigentes no cambian.</p>
              )}
            </div>
          </div>

          {abriendo === r.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingLeft: '24px' }}>
              <label className="ek-label" htmlFor={`res-${r.id}`}>Resolución</label>
              <select id={`res-${r.id}`} className="ek-input" value={resolucion} onChange={(e) => setResolucion(e.target.value as ResolucionHumana)}>
                <option value="sin_efecto">Revisada, sin efecto en el miembro</option>
                <option value="ajuste_manual_registrado">Ajusté créditos/membresía desde su ficha (lo dejo registrado)</option>
                <option value="otro">Otro</option>
              </select>
              <label className="ek-label" htmlFor={`nota-${r.id}`}>Nota (obligatoria)</label>
              <textarea id={`nota-${r.id}`} className="ek-input" rows={2} value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Qué revisaste y qué decidiste" />
              {mensaje && <p className="ek-error-text" style={{ margin: 0 }}>{mensaje}</p>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" className="ek-cta ek-cta--gold" onClick={() => void guardar(r)} disabled={guardando || nota.trim().length < 10}>
                  {guardando ? <Spinner size={14} /> : 'Guardar resolución'}
                </button>
                <button type="button" className="ek-cta ek-cta--secondary" onClick={() => { setAbriendo(null); setMensaje(null); }} disabled={guardando}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div style={{ paddingLeft: '24px' }}>
              <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px' }} onClick={() => { setAbriendo(r.id); setMensaje(null); }}>
                Marcar como revisada
              </button>
            </div>
          )}
        </div>
      ))}

      {resueltas.length > 0 && (
        <div style={{ borderTop: '1px solid var(--ek-line)', paddingTop: '10px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '32px', fontSize: '12.5px' }} onClick={() => setVerResueltas((v) => !v)}>
            {verResueltas ? 'Ocultar resueltas' : `Ver resueltas (${resueltas.length})`}
          </button>
          {verResueltas && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {resueltas.map((r) => (
                <li key={r.id} style={{ fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'flex-start' }} data-testid="revision-resuelta">
                  <CheckCircle2 size={14} style={{ color: 'var(--ek-success)', flexShrink: 0, marginTop: '3px' }} aria-hidden="true" />
                  <span>
                    <strong>{LABEL_TIPO_REVISION[r.tipo] ?? r.tipo}</strong>
                    {r.reversal ? ` · ${pesos(r.reversal.monto_centavos, r.reversal.moneda)}` : ''}
                    {' · '}{LABEL_RESOLUCION[r.resolucion ?? ''] ?? r.resolucion}
                    {r.actor_rol ? ` (${r.actor_rol})` : ''}
                    {r.nota ? <span className="ek-body-muted"> · {r.nota}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
