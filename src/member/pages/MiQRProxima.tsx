import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { QrCode, CalendarPlus } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { supabase } from '@shared/lib/supabase';
import { EmptyState } from '@shared/components/EmptyState';
import { ErrorCarga } from '@shared/components/ErrorCarga';
import { desdeReservasVigentesISO } from '@member/logic/reservasVigentes';

/**
 * /app/qr — resuelve el QR de la PRÓXIMA reserva confirmada del miembro (el
 * botón del menú abre aquí). Si hay reserva → redirige a /app/qr/:id. Si no,
 * muestra un estado claro con acceso a reservar.
 */
export default function MiQRProxima() {
  const { usuario } = useAuth();
  const [reservaId, setReservaId] = useState<string | null>(null);
  // PKG-02A (C02): 'error' es distinto de 'none'. Un fallo al consultar no puede
  // decirle al miembro, en la puerta, que no tiene sesión.
  const [estado, setEstado] = useState<'loading' | 'none' | 'error'>('loading');
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!usuario) return;
    let mounted = true;
    // Reset por si cambió el usuario: no navegar con el reservaId del anterior.
    setReservaId(null);
    setEstado('loading');
    (async () => {
      const { data, error } = await supabase
        .from('reservas')
        .select('id')
        .eq('usuario_id', usuario.id)
        .eq('status', 'confirmada')
        .gte('slot_fin', desdeReservasVigentesISO())
        .order('slot_inicio', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!mounted) return;
      if (error) {
        console.error('[MiQRProxima]', error);
        setEstado('error');
        return;
      }
      if (data?.id) setReservaId(data.id);
      else setEstado('none');
    })();
    return () => {
      mounted = false;
    };
  }, [usuario, intento]);

  if (reservaId) return <Navigate to={`/app/qr/${reservaId}`} replace />;

  if (estado === 'error') {
    return (
      <div className="ek-container">
        <div className="ek-card" style={{ marginTop: '24px' }}>
          <ErrorCarga
            titulo="No pudimos cargar tu próxima sesión."
            hint="Si tienes una reserva, sigue ahí. Revisa tu conexión e intenta de nuevo."
            onReintentar={() => setIntento((n) => n + 1)}
          />
        </div>
      </div>
    );
  }

  if (estado === 'loading') {
    return (
      <div className="ek-container">
        <div className="ek-skeleton" style={{ height: '320px', borderRadius: 'var(--ek-r-card)', marginTop: '24px' }} />
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div className="ek-card" style={{ marginTop: '24px' }}>
        <EmptyState
          icon={QrCode}
          title="No tienes una sesión próxima"
          hint="Tu QR de acceso aparece cuando tienes una reserva agendada."
          action={
            <Link to="/app/reservar" className="ek-cta ek-cta--gold">
              Reservar sesión <CalendarPlus size={15} aria-hidden="true" />
            </Link>
          }
        />
      </div>
    </div>
  );
}
