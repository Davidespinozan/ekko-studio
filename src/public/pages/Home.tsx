import { Link } from 'react-router-dom';
import { useTenant } from '@shared/hooks/useTenant';

export default function Home() {
  const tenant = useTenant();

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">{tenant.slug.toUpperCase()} STUDIO</p>
          <h1 className="ek-h1">
            Tu espacio para crear<br />
            contenido profesional.
          </h1>
          <p className="ek-body" style={{ maxWidth: '32rem' }}>
            Club de creadores en Culiacán. Membresía mensual, 3 estudios,
            reservas digitales. Llega, graba y publica.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Link to="/login" className="ek-cta">
            Iniciar sesión
          </Link>
        </div>

        <div className="ek-card ek-card--elevated">
          <p className="ek-eyebrow" style={{ marginBottom: '0.5rem' }}>TENANT ACTIVO</p>
          <h3 className="ek-h3" style={{ marginBottom: '0.25rem' }}>{tenant.nombre}</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
            Vertical: <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{tenant.vertical}</code>
          </p>
          <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
            Slug: <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{tenant.slug}</code>
          </p>
        </div>
      </div>
    </div>
  );
}
