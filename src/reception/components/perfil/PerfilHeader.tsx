import { Link } from 'react-router-dom';
import { ArrowLeft, Camera } from 'lucide-react';
import { capitalizar, iniciales } from './perfilUtils';
import type { MiembroPerfil } from './types';

/** Cabecera del perfil: volver + avatar editable + nombre. */
export function PerfilHeader({ miembro, onFoto }: { miembro: MiembroPerfil; onFoto: () => void }) {
  return (
    <>
      <Link
        to="/recepcion/miembros"
        className="adm-link"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Volver a búsqueda
      </Link>

      <div style={{ marginTop: '12px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '14px' }}>
        <button
          type="button"
          onClick={onFoto}
          aria-label="Cambiar foto"
          style={{
            position: 'relative', width: '64px', height: '64px', flexShrink: 0,
            borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', background: 'none'
          }}
        >
          {miembro.avatar_url ? (
            <img src={miembro.avatar_url} alt={miembro.nombre ?? 'Miembro'} style={{ width: '64px', height: '64px', borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
          ) : (
            <span style={{
              width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--ek-bg-elevated)', color: 'var(--ek-mustard)',
              fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, border: '0.5px solid var(--ek-line)'
            }}>{iniciales(miembro.nombre, miembro.email)}</span>
          )}
          <span className="ek-media-ctrl" style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '26px', height: '26px', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
            <Camera size={13} aria-hidden="true" />
          </span>
        </button>
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '24px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              margin: 0,
              color: 'var(--ek-ink)'
            }}
          >
            {capitalizar(miembro.nombre) || miembro.email}
          </h1>
        </div>
      </div>
    </>
  );
}
