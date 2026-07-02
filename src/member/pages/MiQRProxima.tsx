import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { QrCode, CalendarPlus } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { supabase } from '@shared/lib/supabase';
import { EmptyState } from '@shared/components/EmptyState';

/**
 * /app/qr — resuelve el QR de la PRÓXIMA reserva confirmada del miembro (el
 * botón del menú abre acá). Si hay reserva → redirige a /app/qr/:id. Si no,
 * muestra un estado claro con acceso a reservar.
 */
export default function MiQRProxima() {
  const { usuario } = useAuth();
  const [reservaId, setReservaId] = useState<string | null>(null);
  const [estado, setEstado] = useState<'loading' | 'none'>('loading');

  useEffect(() => {
    if (!usuario) return;
    let mounted = true;
    // Reset por si cambió el usuario: no navegar con el reservaId del anterior.
    setReservaId(null);
    setEstado('loading');
    (async () => {
      const { data } = await supabase
        .from('reservas')
        .select('id')
        .eq('usuario_id', usuario.id)
        .eq('status', 'confirmada')
        .gte('slot_inicio', new Date().toISOString())
        .order('slot_inicio', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!mounted) return;
      if (data?.id) setReservaId(data.id);
      else setEstado('none');
    })();
    return () => {
      mounted = false;
    };
  }, [usuario]);

  if (reservaId) return <Navigate to={`/app/qr/${reservaId}`} replace />;

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
          title="No tenés una sesión próxima"
          hint="Tu QR de acceso aparece cuando tenés una reserva agendada."
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
