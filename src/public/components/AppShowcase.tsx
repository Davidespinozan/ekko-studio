import { Link } from 'react-router-dom';
import { ArrowRight, Smartphone } from 'lucide-react';

/**
 * Sección 2 de la landing — "Lleva tu estudio siempre contigo".
 * Showcase de la app del miembro con dos mockups de teléfono que muestran
 * capturas reales (Supabase Storage). EKKO es una PWA, por eso el encuadre es
 * "se instala desde el navegador" en vez de badges de App Store / Play Store.
 */

// Capturas reales de la app (Supabase Storage). Front = la de enfrente.
const SHOT_FRONT = 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/1.webp';
const SHOT_BACK = 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/2.webp';

export default function AppShowcase() {
  return (
    <section className="ek-showcase" aria-labelledby="ek-showcase-title">
      <div className="ek-showcase-grid">
        {/* ---------- Copy ---------- */}
        <div className="ek-showcase-copy">
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>
            TU ESTUDIO EN EL BOLSILLO
          </p>
          <h2
            id="ek-showcase-title"
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: 'clamp(34px, 6vw, 56px)',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              lineHeight: 1.05,
              margin: 0,
              marginBottom: '18px'
            }}
          >
            Lleva tu estudio<br />
            <span style={{ color: 'var(--ek-mustard)' }}>siempre contigo.</span>
          </h2>
          <p
            className="ek-body-muted"
            style={{ fontSize: 'clamp(15px, 2vw, 18px)', lineHeight: 1.55, maxWidth: '440px', marginBottom: '28px' }}
          >
            Reserva sesiones, revisa tu agenda y recibe tu material — todo desde
            el teléfono. Se instala en tu pantalla de inicio y funciona como una
            app nativa.
          </p>

          {/* "Badges" — PWA, no tiendas. Honesto con lo que EKKO es hoy. */}
          <div className="ek-showcase-actions">
            <Link
              to="/app"
              className="ek-cta ek-cta--gold"
              style={{
                padding: '14px 26px',
                fontSize: '15px',
                minHeight: '50px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              Abrir la app
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
            <span className="ek-showcase-install">
              <Smartphone size={15} aria-hidden="true" />
              Se instala desde el navegador. Sin tiendas, sin descargas.
            </span>
          </div>
        </div>

        {/* ---------- Mockups ---------- */}
        <div className="ek-showcase-phones" aria-hidden="true">
          <div className="ek-showcase-glow" />

          {/* Teléfono de atrás */}
          <PhoneFrame className="ek-phone--back">
            <img className="ek-phone-shot" src={SHOT_BACK} alt="" loading="lazy" />
          </PhoneFrame>

          {/* Teléfono de adelante */}
          <PhoneFrame className="ek-phone--front">
            <img className="ek-phone-shot" src={SHOT_FRONT} alt="" loading="lazy" />
          </PhoneFrame>
        </div>
      </div>
    </section>
  );
}

/* ---------- Marco del dispositivo ---------- */
function PhoneFrame({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`ek-phone ${className ?? ''}`}>
      <span className="ek-phone-notch" />
      <div className="ek-phone-screen">{children}</div>
    </div>
  );
}
