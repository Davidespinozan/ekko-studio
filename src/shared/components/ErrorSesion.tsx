import { AlertTriangle, UserX } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { HINT_ERROR_CARGA } from './ErrorCarga';

export type TipoErrorSesion = 'carga' | 'sin_perfil';

/**
 * PKG-06D (E-16) · Un fallo al cargar la cuenta NUNCA se parece a "cargando".
 *
 *  - `carga`: la sesión existe pero el perfil no se pudo leer (red, 5xx). Se
 *    ofrece reintentar y, como salida, cerrar sesión.
 *  - `sin_perfil`: la sesión es válida en Auth pero no hay perfil en el estudio
 *    (cuenta eliminada, identidad sin finalizar). No hay nada que reintentar:
 *    se cierra sesión con el motivo claro.
 *
 * No decide autorización: eso sigue siendo del servidor (RLS/RPC). Solo evita la
 * pantalla de carga infinita y da una salida honesta.
 */
export function ErrorSesion({ tipo, onReintentar, onCerrarSesion }: {
  tipo: TipoErrorSesion;
  onReintentar: () => void;
  onCerrarSesion: () => void;
}) {
  const sinPerfil = tipo === 'sin_perfil';
  return (
    <div
      data-testid="error-sesion"
      role="alert"
      style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--ek-cream)', padding: '24px' }}
    >
      <EmptyState
        icon={sinPerfil ? UserX : AlertTriangle}
        title={sinPerfil ? 'Esta cuenta ya no tiene un perfil en el estudio.' : 'No pudimos cargar tu cuenta.'}
        hint={sinPerfil ? 'Cierra sesión y, si crees que es un error, acércate a recepción.' : HINT_ERROR_CARGA}
        tone="danger"
        action={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {!sinPerfil && (
              <button type="button" className="ek-cta" style={{ minHeight: '44px' }} onClick={onReintentar}>
                Reintentar
              </button>
            )}
            <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '44px' }} onClick={onCerrarSesion}>
              Cerrar sesión
            </button>
          </div>
        }
      />
    </div>
  );
}
