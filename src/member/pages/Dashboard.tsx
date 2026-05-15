import { Link } from 'react-router-dom';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useReservasDelUsuario } from '../hooks/useReservas';
import { formatHora } from '../logic/reservaLogic';

export default function Dashboard() {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const { reservas, isLoading } = useReservasDelUsuario();

  const ahora = new Date();
  const proximaReserva = reservas.find(
    (r) => r.status === 'confirmada' && new Date(r.slot_inicio) >= ahora
  );
  const bloqueado = usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > ahora;

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">DASHBOARD</p>
          <h1 className="ek-h1">Hola, {usuario?.nombre ?? 'creador'}.</h1>
          <p className="ek-body">Tu espacio en {tenant.nombre} está listo.</p>
        </div>

        {bloqueado && (
          <div style={{
            background: 'rgba(212, 80, 80, 0.1)',
            border: '1px solid var(--ek-danger)',
            borderRadius: 'var(--ek-radius-lg)',
            padding: '1rem 1.25rem'
          }}>
            <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)' }}>RESTRICCIÓN ACTIVA</p>
            <p style={{ fontSize: '0.9375rem', marginTop: '0.25rem' }}>
              Podrás reservar nuevamente el{' '}
              <strong>
                {new Date(usuario!.bloqueado_hasta!).toLocaleDateString('es-MX', {
                  weekday: 'long', day: 'numeric', month: 'long'
                })}
              </strong>
              .
            </p>
            <p style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)', marginTop: '0.5rem' }}>
              Esto puede deberse a una inasistencia o suspensión. Contactá a EKKO si tienes dudas.
            </p>
          </div>
        )}

        {!isLoading && proximaReserva && (
          <div className="ek-card ek-card--elevated">
            <p className="ek-eyebrow" style={{ marginBottom: '0.5rem' }}>PRÓXIMA SESIÓN</p>
            <h3 className="ek-h3" style={{ marginBottom: '0.25rem' }}>
              {proximaReserva.recurso?.nombre ?? 'Recurso'}
            </h3>
            <p style={{ fontSize: '0.9375rem', color: 'var(--ek-ink-muted)' }}>
              {new Date(proximaReserva.slot_inicio).toLocaleDateString('es-MX', {
                weekday: 'long',
                day: 'numeric',
                month: 'long'
              })}{' '}
              · {formatHora(new Date(proximaReserva.slot_inicio))}
            </p>
            <p style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)', marginTop: '0.75rem' }}>
              Folio: <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{proximaReserva.folio}</code>
            </p>
          </div>
        )}

        {!isLoading && !proximaReserva && (
          <div className="ek-card">
            <p className="ek-eyebrow" style={{ marginBottom: '0.5rem' }}>SIN RESERVAS PRÓXIMAS</p>
            <h3 className="ek-h3" style={{ marginBottom: '0.75rem' }}>
              ¿Listo para grabar?
            </h3>
            <Link to="/app/reservar" className="ek-cta">Reservar estudio</Link>
          </div>
        )}

        {usuario?.status === 'pendiente_onboarding' && (
          <div
            style={{
              padding: '1rem',
              background: '#FFF4D9',
              border: '1px solid var(--ek-warning)',
              borderRadius: 'var(--ek-radius)',
              fontSize: '0.875rem'
            }}
          >
            <strong>Onboarding pendiente:</strong> aún no completas tu perfil ni
            activas tu membresía. (Esto se construye en el siguiente prompt.)
          </div>
        )}
      </div>
    </div>
  );
}
