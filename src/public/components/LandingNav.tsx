import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { navSolida } from '../lib/landingFx';

/**
 * Navegación flotante de la landing (Fase 1 premium): píldora de vidrio con el
 * logo chico, enlaces a las secciones y dos acciones. Transparente sobre el hero
 * y sólida (blur + hairline) al hacer scroll. En teléfono se pliega en una
 * hamburguesa que abre la píldora hacia abajo. Patrón de la landing de Peptivera.
 */

const EKKO_LOGO = 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/EKKO_STUDIO_logo_transparente.png';

export const ENLACES_LANDING: ReadonlyArray<readonly [string, string]> = [
  ['#estudios', 'Estudios'],
  ['#como-funciona', 'Cómo funciona'],
  ['#membresias', 'Planes'],
  ['#faq', 'Preguntas'],
  ['#contacto', 'Contacto']
];

export function LandingNav() {
  const { authUser, signOut } = useAuth();
  const tenant = useTenant();
  const [solida, setSolida] = useState(false);
  const [abierto, setAbierto] = useState(false);

  useEffect(() => {
    const actualizar = () => setSolida(navSolida(window.scrollY));
    actualizar();
    window.addEventListener('scroll', actualizar, { passive: true });
    return () => window.removeEventListener('scroll', actualizar);
  }, []);

  const branding = (tenant.branding ?? {}) as Record<string, unknown>;
  const logoUrl =
    typeof branding.logo_url_dark === 'string'
      ? branding.logo_url_dark
      : typeof branding.logo_url === 'string'
        ? (branding.logo_url as string)
        : EKKO_LOGO;
  const cerrar = () => setAbierto(false);

  return (
    <header
      className={`ek-nav${solida || abierto ? ' ek-nav--solid' : ''}${abierto ? ' ek-nav--open' : ''}`}
      data-testid="landing-nav"
    >
      <div className="ek-nav-in">
        <a href="#inicio" className="ek-nav-logo" aria-label={`${tenant.nombre || 'EKKO Studio'}, inicio`} onClick={cerrar}>
          <img src={logoUrl} alt="" />
        </a>
        <nav className="ek-nav-links" aria-label="Secciones">
          {ENLACES_LANDING.map(([href, texto]) => (
            <a key={href} href={href} onClick={cerrar}>{texto}</a>
          ))}
        </nav>
        <div className="ek-nav-cta">
          {authUser ? (
            <>
              <Link to="/app" className="ek-cta ek-cta--gold">Mi cuenta</Link>
              <button type="button" className="ek-cta ek-cta--ghost" onClick={() => void signOut()}>Salir</button>
            </>
          ) : (
            <>
              <Link to="/login" className="ek-cta ek-cta--ghost">Iniciar sesión</Link>
              <a href="#membresias" className="ek-cta ek-cta--gold" onClick={cerrar}>Ver planes</a>
            </>
          )}
        </div>
        <button
          type="button"
          className="ek-burger"
          aria-label={abierto ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={abierto}
          onClick={() => setAbierto((v) => !v)}
        >
          <span /><span /><span />
        </button>
      </div>
    </header>
  );
}
