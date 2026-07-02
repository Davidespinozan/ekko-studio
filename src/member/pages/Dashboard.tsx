import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, AlertTriangle, CalendarPlus, LayoutGrid } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import type { Database } from '@shared/types/database';
import { BotonCancelarReserva } from '@member/components/BotonCancelarReserva';
import { EmptyState } from '@shared/components/EmptyState';
import { CarnetMembresia } from '@member/components/CarnetMembresia';
import { ResumenChips } from '@member/components/ResumenChips';
import { useResumenMiembro } from '@member/hooks/useResumenMiembro';
import { resumenCarnet } from '@member/logic/carnetMembresia';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
}

// ============================================================================
// Hooks locales
// ============================================================================

// Exportada para test (ERROR-UI-FIX E-02).
export function useProximasReservas(usuarioId: string | undefined) {
  const [reservas, setReservas] = useState<ReservaConRecurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    if (!usuarioId) {
      setReservas([]);
      setError(false);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(false);
    const { data, error: queryError } = await supabase
      .from('reservas')
      .select('*, recurso:recursos(id, nombre, slug)')
      .eq('usuario_id', usuarioId)
      .eq('status', 'confirmada')
      .gte('slot_inicio', new Date().toISOString())
      .order('slot_inicio', { ascending: true })
      .limit(5);

    // ERROR-UI-FIX E-02: distinguir "sin reservas" de "falló la carga".
    if (queryError) {
      console.error('[Dashboard] próximas reservas:', queryError);
      setError(true);
      setIsLoading(false);
      return;
    }
    setReservas((data ?? []) as unknown as ReservaConRecurso[]);
    setIsLoading(false);
  }, [usuarioId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!mounted) return;
      await refetch();
    })();
    return () => { mounted = false; };
  }, [refetch]);

  return { reservas, isLoading, error, refetch };
}

// ============================================================================
// Helpers
// ============================================================================

function formatearFecha(iso: string): string {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fecha} · ${hora}`;
}

function capitalizarNombre(nombre: string | null | undefined): string {
  if (!nombre) return '';
  return nombre
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ============================================================================
// Dashboard
// ============================================================================

export default function Dashboard() {
  const { usuario } = useAuth();
  const tenant = useTenant();
  const {
    reservas: proximasReservas,
    isLoading: loadingReservas,
    error: errorReservas,
    refetch: refetchReservas
  } = useProximasReservas(usuario?.id);
  const { resumen, isLoading: loadingResumen } = useResumenMiembro(
    usuario?.id,
    tenant?.id,
    usuario?.membresia_tier
  );

  const ahora = new Date();
  const bloqueado = usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > ahora;
  const nombreFormat = capitalizarNombre(usuario?.nombre) || 'creador';
  const proximaReserva = proximasReservas[0];

  // Carnet: status de la membresía es autoritativo; cae al del usuario.
  const carnetStatus = resumen.membresia?.status ?? usuario?.status ?? null;
  const carnet = resumenCarnet({
    tipo: resumen.tier?.tipo ?? 'tiempo',
    status: carnetStatus,
    creditosRestantes: resumen.membresia?.creditosRestantes ?? null,
    periodoActualFin: resumen.membresia?.periodoActualFin ?? null
  });
  const tierNombre = resumen.tier?.nombre ?? usuario?.membresia_tier ?? 'EKKO';
  // Solo mostramos el chip de créditos en planes por créditos/híbrido.
  const creditosChip =
    resumen.tier?.tipo === 'creditos' || resumen.tier?.tipo === 'hibrido'
      ? resumen.membresia?.creditosRestantes ?? 0
      : null;

  return (
    <div className="ek-container">
      {bloqueado && (
        <div className="ek-card ek-card--md" style={{
          borderColor: 'rgba(226, 85, 85, 0.3)',
          background: 'var(--ek-danger-soft)',
          marginBottom: '24px'
        }}>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={13} aria-hidden="true" /> RESTRICCIÓN ACTIVA
          </p>
          <p className="ek-body" style={{ marginTop: '8px' }}>
            Podrás reservar nuevamente el{' '}
            <strong>
              {new Date(usuario!.bloqueado_hasta!).toLocaleDateString('es-MX', {
                weekday: 'long', day: 'numeric', month: 'long'
              })}
            </strong>.
          </p>
          <p className="ek-body-faint" style={{ marginTop: '8px' }}>
            Esto puede deberse a una inasistencia o suspensión. Contactá a EKKO si tienes dudas.
          </p>
        </div>
      )}

      {/* Greeting */}
      <div style={{ marginBottom: '24px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '12px' }}>BIENVENIDA</p>
        <h1 className="ek-display-xl">
          Hola, {nombreFormat}.
        </h1>
      </div>

      {/* Carnet de membresía + chips de resumen (panel de "tu actividad") */}
      {loadingResumen ? (
        <>
          <div className="ek-skeleton" style={{ height: '150px', borderRadius: 'var(--ek-r-card)', marginBottom: '24px' }} />
          <div className="ek-skeleton" style={{ height: '90px', borderRadius: 'var(--ek-r-md)', marginBottom: '24px' }} />
        </>
      ) : (
        <>
          <CarnetMembresia tierNombre={tierNombre} resumen={carnet} />
          <ResumenChips
            proximasCount={resumen.proximasCount}
            sesionesEsteMes={resumen.sesionesEsteMes}
            creditosRestantes={creditosChip}
          />
        </>
      )}

      {/* Próxima sesión: cargando / error / hero / empty (ERROR-UI-FIX E-02) */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '12px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ margin: 0 }}>TU PRÓXIMA SESIÓN</p>
        <Link
          to="/app/reservas"
          style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ek-mustard)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
        >
          Ver todas <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </div>
      {loadingReservas ? (
        <div
          className="ek-skeleton"
          style={{ height: '220px', borderRadius: 'var(--ek-r-card)', marginBottom: '24px' }}
        />
      ) : errorReservas ? (
        <div className="ek-card" style={{ marginBottom: '24px', textAlign: 'center' }}>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', marginBottom: '12px' }}>
            NO SE PUDO CARGAR
          </p>
          <p className="ek-body" style={{ marginBottom: '20px' }}>
            No pudimos cargar tu próxima sesión. Verificá tu conexión.
          </p>
          <button type="button" onClick={() => void refetchReservas()} className="ek-cta">
            Reintentar
          </button>
        </div>
      ) : proximaReserva ? (
        <div className="ek-card--hero ek-lift" style={{ marginBottom: '24px' }}>
          <h2 className="ek-display-lg" style={{ marginBottom: '6px' }}>
            {proximaReserva.recurso?.nombre ?? 'Estudio'}
          </h2>
          <p className="ek-body-muted" style={{ marginBottom: '14px' }}>
            {formatearFecha(proximaReserva.slot_inicio)}
          </p>
          <p className="ek-body-faint" style={{ marginBottom: '20px' }}>
            Folio: <span style={{ fontFamily: 'var(--ek-font-mono)' }}>
              {proximaReserva.folio}
            </span>
          </p>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <Link to={`/app/qr/${proximaReserva.id}`} className="ek-cta">
              Ver QR <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <div style={{ marginTop: '14px' }}>
            <BotonCancelarReserva
              reserva={{
                id: proximaReserva.id,
                slot_inicio: proximaReserva.slot_inicio,
                folio: proximaReserva.folio,
                recurso_nombre: proximaReserva.recurso?.nombre ?? 'Estudio'
              }}
              onCancelada={refetchReservas}
            />
          </div>
        </div>
      ) : (
        <div className="ek-card" style={{ marginBottom: '24px' }}>
          <EmptyState
            icon={CalendarPlus}
            title="Sin sesiones agendadas"
            hint="Reserva tu próxima grabación y aparecerá acá."
          />
        </div>
      )}

      {/* Accesos rápidos */}
      <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '12px' }}>ACCESOS RÁPIDOS</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Link to="/app/reservar" className="ek-card ek-card-interactive ek-quick-action ek-card--gold">
          <span className="ek-empty-icon" style={{ width: 44, height: 44, margin: 0 }}>
            <CalendarPlus size={20} aria-hidden="true" />
          </span>
          <span className="ek-quick-action-label">Reservar sesión</span>
          <ArrowRight size={16} className="ek-quick-action-arrow" aria-hidden="true" />
        </Link>
        <Link to="/app/estudios" className="ek-card ek-card-interactive ek-quick-action">
          <span className="ek-empty-icon ek-empty-icon--neutral" style={{ width: 44, height: 44, margin: 0 }}>
            <LayoutGrid size={20} aria-hidden="true" />
          </span>
          <span className="ek-quick-action-label">Ver estudios</span>
          <ArrowRight size={16} className="ek-quick-action-arrow" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
