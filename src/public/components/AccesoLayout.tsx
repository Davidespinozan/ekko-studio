import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import '../../styles/acceso.css';

/**
 * Marco de las pantallas de acceso (login, recuperar y nueva contraseña), Fase 2
 * premium. Pantalla partida: a la izquierda la marca (foto del estudio, auroras
 * mostaza, kicker mono, bienvenida y tres garantías); a la derecha el formulario
 * que recibe como hijos. En teléfono la marca queda como cabecera compacta.
 * El logo y el nombre son fijos (EKKO): estas pantallas no dependen del tenant.
 */

const EKKO_LOGO = 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/EKKO_STUDIO_logo_transparente.png';

export const GARANTIAS_ACCESO: readonly string[] = [
  'Reserva desde tu teléfono',
  'Tu material entregado en MP4',
  'Acceso seguro y cifrado'
];

export function AccesoLayout({ children }: { children: ReactNode }) {
  return (
    <div className="ek-acceso">
      <aside className="ek-acceso-brand" data-testid="acceso-brand">
        <div className="ek-acceso-aurora" aria-hidden="true"><i /><i /></div>
        <div className="ek-acceso-top">
          <Link to="/" aria-label="EKKO Studio, inicio">
            <img src={EKKO_LOGO} alt="" />
          </Link>
        </div>
        <div className="ek-acceso-mid">
          <span className="ek-kicker">Acceso a tu cuenta</span>
          <h2>Bienvenido a <em className="ek-grad">EKKO</em></h2>
          <p>Reserva tu sesión, revisa tu agenda y descarga tu material desde un solo lugar.</p>
        </div>
        <ul className="ek-acceso-trust">
          {GARANTIAS_ACCESO.map((g) => (
            <li key={g}><span className="ek-acceso-dot" aria-hidden="true" />{g}</li>
          ))}
        </ul>
      </aside>
      <main className="ek-acceso-panel">
        <div className="ek-acceso-card">{children}</div>
      </main>
    </div>
  );
}
