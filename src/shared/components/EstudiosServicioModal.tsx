import { useCallback, useEffect, useState } from 'react';
import { X, Wrench, CheckCircle2, AlertTriangle } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { setRecursoServicio } from '@shared/lib/recursoServicio';

/**
 * Bloque F: gestión de estudios "fuera de servicio" (temporal). Lista los
 * estudios del tenant y permite marcar/reactivar cada uno. Compartido por
 * recepción (desde Agenda) y admin (desde Recursos). Marcar fuera de servicio
 * auto-cancela las reservas futuras del estudio y avisa a los miembros, así que
 * cada acción pide confirmación.
 */

interface RecursoRow {
  id: string;
  nombre: string;
  fuera_de_servicio: boolean;
  fuera_de_servicio_motivo: string | null;
}

interface AccionTarget {
  recurso: RecursoRow;
  fuera: boolean; // true = marcar fuera de servicio; false = reactivar
}

export function EstudiosServicioModal({ onClose }: { onClose: () => void }) {
  const tenant = useTenant();
  const toast = useToast();
  const [recursos, setRecursos] = useState<RecursoRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [target, setTarget] = useState<AccionTarget | null>(null);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  const cargar = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const { data, error: err } = await supabase
      .from('recursos')
      .select('id, nombre, fuera_de_servicio, fuera_de_servicio_motivo')
      .eq('tenant_id', tenant.id)
      .eq('activo', true)
      .order('nombre', { ascending: true });
    if (err) {
      console.error('[EstudiosServicioModal]', err);
      setError(true);
      setRecursos([]);
    } else {
      setRecursos((data ?? []) as RecursoRow[]);
    }
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function abrirConfirm(recurso: RecursoRow, fuera: boolean) {
    setMotivo('');
    setTarget({ recurso, fuera });
  }

  async function confirmar() {
    if (!target) return;
    setSaving(true);
    try {
      const res = await setRecursoServicio(target.recurso.id, target.fuera, motivo.trim() || undefined);
      if (target.fuera) {
        toast.success(
          res.reservas_canceladas > 0
            ? `Estudio fuera de servicio. Se cancelaron ${res.reservas_canceladas} reserva(s) y se avisó.`
            : 'Estudio fuera de servicio.'
        );
      } else {
        toast.success('Estudio reactivado.');
      }
      setTarget(null);
      await cargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo actualizar el estudio.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ek-backdrop" onClick={() => !saving && onClose()} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '460px', width: '100%', maxHeight: '90vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">ESTUDIOS · FUERA DE SERVICIO</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Sub-paso de confirmación */}
        {target ? (
          <div>
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'flex-start',
                background: target.fuera ? 'var(--ek-danger-soft)' : 'var(--ek-bg-soft)',
                border: `0.5px solid ${target.fuera ? 'var(--ek-danger)' : 'var(--ek-line)'}`,
                borderRadius: 'var(--ek-r-sm)',
                padding: '12px 14px',
                marginBottom: '14px'
              }}
            >
              <AlertTriangle size={16} style={{ color: target.fuera ? 'var(--ek-danger)' : 'var(--ek-mustard)', flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
              <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, lineHeight: 1.45 }}>
                {target.fuera ? (
                  <>
                    <strong>{target.recurso.nombre}</strong> quedará fuera de servicio. Se
                    <strong> cancelan las reservas futuras</strong> de este estudio y se les avisa a
                    los miembros. No se puede deshacer la cancelación.
                  </>
                ) : (
                  <><strong>{target.recurso.nombre}</strong> vuelve a estar disponible para reservar.</>
                )}
              </p>
            </div>

            {target.fuera && (
              <div className="ek-form-field" style={{ marginBottom: '16px' }}>
                <label className="ek-label" htmlFor="fs-motivo">Motivo (opcional)</label>
                <input
                  id="fs-motivo"
                  className="ek-input"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ej. mantenimiento de equipo"
                  maxLength={200}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={() => setTarget(null)} disabled={saving}>
                Volver
              </button>
              <button
                type="button"
                onClick={confirmar}
                disabled={saving}
                className="ek-cta"
                style={
                  target.fuera
                    ? { flex: 1, background: 'var(--ek-danger-soft)', color: 'var(--ek-danger)', border: '0.5px solid var(--ek-danger)' }
                    : { flex: 1 }
                }
              >
                {saving ? <Spinner size={16} /> : target.fuera ? 'Marcar fuera de servicio' : 'Reactivar'}
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div className="ek-skeleton" style={{ height: '120px', borderRadius: 'var(--ek-r-sm)' }} />
        ) : error ? (
          <p className="ek-body-faint">No se pudieron cargar los estudios.</p>
        ) : recursos.length === 0 ? (
          <p className="ek-body-faint">No hay estudios activos.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {recursos.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 14px',
                  background: 'var(--ek-bg-soft)',
                  border: `0.5px solid ${r.fuera_de_servicio ? 'var(--ek-danger)' : 'var(--ek-line)'}`,
                  borderRadius: 'var(--ek-r-sm)'
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ek-ink)', margin: 0 }}>{r.nombre}</p>
                  <p style={{ fontSize: '12px', margin: '2px 0 0', color: r.fuera_de_servicio ? 'var(--ek-danger)' : 'var(--ek-success)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    {r.fuera_de_servicio ? <Wrench size={12} aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
                    {r.fuera_de_servicio ? 'Fuera de servicio' : 'Operativo'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => abrirConfirm(r, !r.fuera_de_servicio)}
                  className="ek-cta ek-cta--secondary"
                  style={{ minHeight: '40px', padding: '0 12px', fontSize: '12px', flexShrink: 0, color: r.fuera_de_servicio ? 'var(--ek-success)' : 'var(--ek-danger)' }}
                >
                  {r.fuera_de_servicio ? 'Reactivar' : 'Fuera de servicio'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
