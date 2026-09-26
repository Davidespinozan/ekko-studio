import { useEffect, useState } from 'react';
import { Bell, BellOff, Smartphone } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import {
  estadoPush,
  activarPush,
  desactivarPush,
  type EstadoPush
} from '@shared/lib/push';

interface Props {
  usuarioId: string;
  tenantId: string;
  /** Qué le va a llegar a ESTA persona (miembro: recordatorios; staff: cobros rechazados…). */
  descripcion?: string;
  /**
   * Oculta la tarjeta cuando ya están activos. Para los paneles de admin y
   * recepción: es una invitación que desaparece al aceptarla, no un ajuste fijo
   * (desde el perfil del miembro sí se muestra siempre, para poder desactivar).
   */
  ocultarSiActivo?: boolean;
}

/**
 * Toggle de notificaciones push: los avisos llegan al teléfono aunque la app
 * esté cerrada. Vivía solo en el Perfil del MIEMBRO, así que admin y recepción no
 * tenían dónde suscribirse: `avisarStaff` y `cron-push` mandaban "cobro
 * rechazado" y "reembolso" a teléfonos que nunca pudieron activarse.
 */
export function ActivarAvisosPush({ usuarioId, tenantId, descripcion, ocultarSiActivo = false }: Props) {
  const toast = useToast();
  const [estado, setEstado] = useState<EstadoPush | null>(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    let mounted = true;
    estadoPush().then((e) => { if (mounted) setEstado(e); });
    return () => { mounted = false; };
  }, []);

  async function toggle() {
    setCargando(true);
    try {
      if (estado === 'activo') {
        setEstado(await desactivarPush());
        toast.info('Avisos desactivados en este dispositivo.');
      } else {
        const r = await activarPush({ id: usuarioId, tenant_id: tenantId });
        setEstado(r);
        if (r === 'activo') toast.success('¡Listo! Vas a recibir avisos y recordatorios.');
        else if (r === 'denegado') toast.error('Bloqueaste los avisos. Habilítalos en los ajustes del navegador.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos cambiar los avisos.');
    } finally {
      setCargando(false);
    }
  }

  if (estado === null) return null; // resolviendo estado inicial
  if (estado === 'no-soportado') return null; // navegador sin push → no mostramos nada

  const activo = estado === 'activo';
  if (activo && ocultarSiActivo) return null;

  return (
    <div className="ek-card" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
      <span className="ek-empty-icon" style={{ width: 40, height: 40, margin: 0, flexShrink: 0 }}>
        {activo ? <Bell size={18} aria-hidden="true" /> : <BellOff size={18} aria-hidden="true" />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>Avisos en el teléfono</p>
        <p className="ek-body-muted" style={{ margin: '2px 0 0', fontSize: '12.5px', lineHeight: 1.4 }}>
          {descripcion ?? 'Recordatorios de tu reserva y avisos del estudio.'}
        </p>
      </div>

      {estado === 'necesita-instalar' ? (
        <span className="ek-helper-text" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', maxWidth: '150px', textAlign: 'right' }}>
          <Smartphone size={13} aria-hidden="true" /> Instala la app primero
        </span>
      ) : (
        <button
          type="button"
          className={activo ? 'ek-cta ek-cta--secondary' : 'ek-cta ek-cta--gold'}
          style={{ padding: '9px 16px', fontSize: '13px', minHeight: '38px', flexShrink: 0 }}
          onClick={toggle}
          disabled={cargando}
        >
          {cargando ? <Spinner size={15} /> : activo ? 'Desactivar' : 'Activar'}
        </button>
      )}
    </div>
  );
}
