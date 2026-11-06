import { useEffect, useState } from 'react';
import { ReservasHoyView } from '../components/ReservasHoyView';
import { CheckInDetail } from '../components/CheckInDetail';
import { CumpleanosCard } from '@shared/components/CumpleanosCard';
import { ActivarAvisosPush } from '@shared/components/ActivarAvisosPush';
import { useAuth } from '@shared/hooks/useAuth';
import { BienvenidaPanel } from '@shared/components/BienvenidaPanel';
import { resumenDelDia } from '@shared/lib/bienvenida';
import { useReservasHoy } from '../hooks/useReservasHoy';

/** Retorno de `check_in_manual_atomic` (misma forma que el `data` de qr-verify). */
export interface CheckInManualData {
  // Tipos laxos a propósito (como en Checkin.tsx): es el jsonb crudo del RPC y
  // CheckInDetail ya lo tipa.
  miembro?: any;
  recurso?: any;
  reserva?: any;
  stats?: { check_ins_hoy: number; check_ins_semana: number };
  membresia_estado?: string;
}

/**
 * "Hoy" — panel del día de recepción (Bloque B/C). El check-in QR vive ahora
 * en su propio tab (Checkin); aquí queda lo accionable del día: ocupación,
 * llegadas, resto del día, faltantes y check-in manual.
 *
 * Tras un check-in manual se abre el MISMO detalle que tras un QR. No es
 * cosmético: el check-in manual no bloquea por membresía (decisión del Sprint 5:
 * "QR bloquea, manual avisa") y ese aviso —vencida, sin plan, pago rechazado—
 * solo se pinta en `CheckInDetail`, igual que el acceso a los invitados. Sin
 * esto el RPC avisaba y nadie lo veía.
 */
export default function Hoy() {
  const [detalle, setDetalle] = useState<CheckInManualData | null>(null);
  const { usuario } = useAuth();
  // Bienvenida (patrón Renovacell/Fukuroll): una lectura sin polling, solo para el resumen;
  // la lista viva la lleva ReservasHoyView. Si la lectura falla, no se afirma ningún número.
  const hoy = useReservasHoy(undefined, false);
  const { refetch: leerHoy } = hoy;
  // Sin polling el hook no lee solo: una lectura al entrar.
  useEffect(() => { void leerHoy(); }, [leerHoy]);
  const vivas = hoy.error ? [] : hoy.reservas.filter((r) => r.status === 'confirmada' || r.status === 'completada');
  const resumen = hoy.error || hoy.isLoading
    ? { texto: 'Aquí tienes el día: llegadas, check‑ins y faltantes.', urgente: false }
    : resumenDelDia({ sesionesHoy: vivas.length, checkIns: vivas.filter((r) => r.status === 'completada').length });

  return (
    <div className="rec-main">
      <BienvenidaPanel nombre={usuario?.nombre} rol={usuario?.rol} avatarUrl={usuario?.avatar_url} resumen={resumen.texto} urgente={resumen.urgente} />
      <CumpleanosCard dias={0} compacto />
      {usuario && (
        <ActivarAvisosPush
          usuarioId={usuario.id}
          tenantId={usuario.tenant_id}
          descripcion="Avisos del mostrador (cobros rechazados, novedades) en este teléfono."
          ocultarSiActivo
        />
      )}
      <ReservasHoyView
        onManualCheckInSuccess={(data: CheckInManualData) => setDetalle(data ?? null)}
        pausarPolling={detalle !== null}
      />

      {detalle && (
        <div className="rec-detail-backdrop">
          <CheckInDetail
            kind="success"
            miembro={detalle.miembro}
            recurso={detalle.recurso}
            reserva={detalle.reserva}
            stats={detalle.stats}
            membresiaEstado={detalle.membresia_estado}
            onClose={() => setDetalle(null)}
          />
        </div>
      )}
    </div>
  );
}
