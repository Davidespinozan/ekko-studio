import { Link } from 'react-router-dom';
import {
  Home,
  CalendarDays,
  Clapperboard,
  User,
  Clock,
  Star,
  ArrowRight,
  Smartphone
} from 'lucide-react';

/**
 * Sección 2 de la landing — "Lleva tu estudio siempre contigo".
 * Showcase de la app del miembro con mockups de teléfono renderizados en CSS
 * (no imágenes): así no dependemos de capturas que se desactualizan y todo usa
 * los tokens de EKKO. EKKO es una PWA, por eso el encuadre es "se instala desde
 * el navegador" en vez de badges de App Store / Play Store (no hay apps nativas).
 */
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

          {/* Teléfono de atrás — "Reservar" */}
          <PhoneFrame className="ek-phone--back">
            <ScreenReservar />
          </PhoneFrame>

          {/* Teléfono de adelante — "Inicio" */}
          <PhoneFrame className="ek-phone--front">
            <ScreenInicio />
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

/* ---------- Barra de estado ---------- */
function StatusBar() {
  return (
    <div className="ek-mini-status">
      <span>9:41</span>
      <span style={{ display: 'inline-flex', gap: '3px', alignItems: 'center' }}>
        <i className="ek-mini-dot" />
        <i className="ek-mini-dot" />
        <i className="ek-mini-dot" style={{ opacity: 0.4 }} />
      </span>
    </div>
  );
}

/* ---------- Barra de navegación inferior ---------- */
function BottomNav({ active }: { active: 'inicio' | 'reservar' }) {
  const items = [
    { key: 'inicio', Icon: Home, label: 'Inicio' },
    { key: 'reservar', Icon: CalendarDays, label: 'Reservar' },
    { key: 'agenda', Icon: Clapperboard, label: 'Agenda' },
    { key: 'perfil', Icon: User, label: 'Perfil' }
  ] as const;
  return (
    <div className="ek-mini-nav">
      {items.map(({ key, Icon, label }) => (
        <span key={key} className={`ek-mini-nav-item ${key === active ? 'is-active' : ''}`}>
          <Icon size={16} aria-hidden="true" />
          <i>{label}</i>
        </span>
      ))}
    </div>
  );
}

/* ---------- Pantalla: Inicio ---------- */
function ScreenInicio() {
  return (
    <div className="ek-mini-app">
      <StatusBar />
      <div className="ek-mini-body">
        <p className="ek-mini-brand">EKKO</p>
        <p className="ek-mini-greeting">Hola, creador</p>

        <p className="ek-mini-eyebrow">PRÓXIMA RESERVA</p>
        <div className="ek-mini-card ek-mini-card--hero">
          <div className="ek-mini-row" style={{ justifyContent: 'space-between' }}>
            <strong className="ek-mini-card-title">Estudio Black</strong>
            <span className="ek-mini-badge">
              <Star size={9} fill="currentColor" aria-hidden="true" /> PRO
            </span>
          </div>
          <span className="ek-mini-when">
            <Clock size={12} aria-hidden="true" /> Hoy · 16:00
          </span>
          <div className="ek-mini-progress"><i style={{ width: '64%' }} /></div>
          <span className="ek-mini-foot">Faltan 2 h · equipo listo</span>
        </div>

        <p className="ek-mini-eyebrow">ESTA SEMANA</p>
        {[
          { d: 'Jue', e: 'Loft', h: '14:00' },
          { d: 'Sáb', e: 'Set', h: '11:00' }
        ].map((r) => (
          <div key={r.d} className="ek-mini-card ek-mini-line">
            <span className="ek-mini-day">{r.d}</span>
            <span style={{ flex: 1 }}>Estudio {r.e}</span>
            <span className="ek-mini-hour">{r.h}</span>
          </div>
        ))}
      </div>
      <BottomNav active="inicio" />
    </div>
  );
}

/* ---------- Pantalla: Reservar ---------- */
function ScreenReservar() {
  return (
    <div className="ek-mini-app">
      <StatusBar />
      <div className="ek-mini-body">
        <p className="ek-mini-greeting" style={{ marginTop: '2px' }}>Reservar</p>
        <p className="ek-mini-eyebrow">ELIGE ESTUDIO</p>

        <div className="ek-mini-card ek-mini-card--media">
          <div className="ek-mini-thumb" />
          <strong className="ek-mini-card-title">Estudio Loft</strong>
          <span className="ek-mini-foot">Hasta 4 personas · Pódcast</span>
          <div className="ek-mini-chips">
            <span className="ek-mini-chip">12:00</span>
            <span className="ek-mini-chip is-active">14:00</span>
            <span className="ek-mini-chip">16:00</span>
          </div>
        </div>

        <div className="ek-mini-card ek-mini-line">
          <span style={{ flex: 1 }}>Estudio Set</span>
          <span className="ek-mini-hour">3 horarios</span>
        </div>
      </div>
      <BottomNav active="reservar" />
    </div>
  );
}
