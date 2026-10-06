import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, AlertTriangle } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import { COLUMNAS_RESERVA_CLIENTE } from '@shared/lib/columnas';
import type { Database } from '@shared/types/database';
import { ProximaSesionHero } from '@member/components/ProximaSesionHero';
import { ResumenHome } from '@member/components/ResumenHome';
import { useResumenMiembro } from '@member/hooks/useResumenMiembro';
import { resumenCarnet } from '@member/logic/carnetMembresia';
import { desdeReservasVigentesISO } from '@member/logic/reservasVigentes';
import { formatFechaEnZona } from '@shared/lib/timezone';
import { ContactoEstudio } from '@shared/components/ContactoEstudio';
import { ErrorCarga } from '@shared/components/ErrorCarga';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type Reserva = Database['public']['Tables']['reservas']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre' | 'foto_url' | 'max_invitados_extra'> | null;
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
      .select(`${COLUMNAS_RESERVA_CLIENTE}, recurso:recursos(id, nombre, slug, foto_url, max_invitados_extra)`)
      .eq('usuario_id', usuarioId)
      .eq('status', 'confirmada')
      // Por slot_fin + gracia de check-in: la sesión en curso sigue siendo "la próxima".
      .gte('slot_fin', desdeReservasVigentesISO())
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
  const { resumen, isLoading: loadingResumen, error: errorResumen, refetch: refetchResumen } = useResumenMiembro(
    usuario?.id,
    tenant?.id,
    usuario?.membresia_tier
  );

  // Al cancelar una reserva, refrescar TANTO el hero como los chips (proximasCount
  // se quedaba stale antes).
  const onReservaCancelada = useCallback(() => {
    void refetchReservas();
    void refetchResumen();
  }, [refetchReservas, refetchResumen]);

  const ahora = new Date();
  const bloqueado = usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > ahora;
  const nombreFormat = capitalizarNombre(usuario?.nombre) || 'creador';
  const saludo = (() => {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return 'Buenos días';
    if (h >= 12 && h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  })();
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
              {formatFechaEnZona(usuario!.bloqueado_hasta!, { weekday: 'long', day: 'numeric', month: 'long' })}
            </strong>.
          </p>
          <p className="ek-body-faint" style={{ marginTop: '8px' }}>
            Esto puede deberse a una inasistencia o suspensión.{' '}
            <ContactoEstudio enLinea etiqueta="Escríbenos si tienes dudas" mensaje="Hola, mi cuenta de EKKO tiene una restricción activa y quiero entender por qué." />
          </p>
        </div>
      )}

      {/* Greeting — banner cálido, saludo según la hora. Le da vida al inicio. */}
      <div className="ek-card ek-card--cream" style={{ marginBottom: '20px' }}>
        <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'rgba(10, 10, 10, 0.55)' }}>
          {saludo},
        </p>
        <h1 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(28px, 8vw, 42px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          margin: '2px 0 0',
          color: 'var(--ek-bg)'
        }}>
          {nombreFormat} <span aria-hidden="true">👋</span>
        </h1>
        <div style={{ width: '44px', height: '4px', borderRadius: '2px', background: 'var(--ek-mustard)', marginTop: '12px' }} />
      </div>

      {/* Próxima sesión — ARRIBA, imagen fija, SIEMPRE visible (le da imagen al
          inicio). Con sesión → datos + Ver QR; sin sesión → mensaje + Reservar. */}
      {loadingReservas ? (
        <div className="ek-skeleton" style={{ height: '260px', borderRadius: 'var(--ek-r-card)', marginBottom: '24px' }} />
      ) : errorReservas ? (
        <div className="ek-card" style={{ marginBottom: '24px', textAlign: 'center' }}>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', marginBottom: '12px' }}>NO SE PUDO CARGAR</p>
          <p className="ek-body" style={{ marginBottom: '20px' }}>No pudimos cargar tu próxima sesión. Verifica tu conexión.</p>
          <button type="button" onClick={() => void refetchReservas()} className="ek-cta">Reintentar</button>
        </div>
      ) : (
        <>
          <ProximaSesionHero reserva={proximaReserva ?? null} onCancelada={onReservaCancelada} />
          {proximaReserva && (
            <div style={{ marginTop: '-14px', marginBottom: '16px', textAlign: 'center' }}>
              <Link
                to="/app/reservas"
                style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--ek-mustard)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
              >
                Ver todas mis reservas <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </div>
          )}
        </>
      )}

      {/* Resumen compacto: Próximas · Sesiones · Membresía · (Créditos) */}
      {loadingResumen ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="ek-skeleton" style={{ height: '92px', borderRadius: 'var(--ek-r-md)' }} />
          ))}
        </div>
      ) : errorResumen ? (
        // PKG-02A (C02): la lectura falló → NO pintar carnet "sin plan", 0 créditos
        // ni 0 sesiones como si fueran reales.
        <div className="ek-card" style={{ marginBottom: '20px' }}>
          <ErrorCarga
            titulo="No pudimos cargar tu membresía."
            hint="Tu plan, créditos y sesiones siguen ahí; solo no pudimos leerlos. Revisa tu conexión e intenta de nuevo."
            onReintentar={() => void refetchResumen()}
          />
        </div>
      ) : (
        <ResumenHome
          tierNombre={tierNombre}
          carnet={carnet}
          proximasCount={resumen.proximasCount}
          sesionesEsteMes={resumen.sesionesEsteMes}
          creditosRestantes={creditosChip}
        />
      )}
    </div>
  );
}
