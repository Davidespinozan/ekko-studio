import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { CambiarPasswordForm } from '@shared/components/CambiarPasswordForm';
import { leerEnlaceConfirmacion } from '@public/lib/confirmacionCorreo';

type Estado = 'verificando' | 'contrasena' | 'listo' | 'invalido';

const WRAP: React.CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  padding: '0 20px',
  paddingTop: 'clamp(56px, 10vh, 120px)',
  paddingBottom: 'calc(48px + env(safe-area-inset-bottom, 0px))'
};

const VOLVER: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--ek-mustard)',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '5px'
};

/**
 * /confirmar-correo — destino del enlace del alta pública (PKG-06C · FR-24).
 *
 * 1. El proveedor de Auth verifica el token (`verifyOtp`): ESE es el momento en
 *    que el correo queda probado, y el servidor (trigger) crea o vincula la
 *    identidad EKKO. La app no decide nada de eso.
 * 2. Quien controla el buzón elige su contraseña (antes no había ninguna).
 * El token se quita de la barra de direcciones al leerlo y se usa una sola vez
 * (también en StrictMode). Si abandona sin fijar contraseña, se cierra la sesión
 * del enlace; volver a registrarse le manda un enlace nuevo.
 */
export default function ConfirmarCorreo() {
  const location = useLocation();
  const navigate = useNavigate();
  const [estado, setEstado] = useState<Estado>('verificando');
  const intentado = useRef(false);
  const verificado = useRef(false);
  const conContrasena = useRef(false);

  useEffect(() => {
    return () => {
      if (verificado.current && !conContrasena.current) void supabase.auth.signOut();
    };
  }, []);

  useEffect(() => {
    if (intentado.current) return;
    intentado.current = true;
    const enlace = leerEnlaceConfirmacion(location.search);
    // El token no se queda en la barra ni en el historial.
    navigate(location.pathname, { replace: true });
    if (!enlace) {
      setEstado('invalido');
      return;
    }
    supabase.auth
      .verifyOtp({ token_hash: enlace.tokenHash, type: enlace.tipo })
      .then(({ data, error }) => {
        if (error || !data?.session) {
          setEstado('invalido');
          return;
        }
        verificado.current = true;
        setEstado('contrasena');
      })
      .catch(() => setEstado('invalido'));
    // Solo al montar: el enlace se lee una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function contenido() {
    if (estado === 'verificando') {
      return <p className="ek-body-muted" style={{ margin: 0, textAlign: 'center' }}>Confirmando tu correo…</p>;
    }
    if (estado === 'invalido') {
      return (
        <div className="ek-stack-md">
          <p className="ek-eyebrow" style={{ margin: 0, color: 'var(--ek-danger)' }}>ENLACE NO VÁLIDO</p>
          <h2 className="ek-h3" style={{ margin: 0 }}>El enlace expiró o ya se usó</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Los enlaces de confirmación duran 1 hora y solo funcionan una vez. Si ya creaste tu contraseña, inicia
            sesión. Si no, vuelve a registrarte y te mandamos otro. Si el problema sigue, acércate a recepción.
          </p>
          <Link to="/login" className="ek-cta ek-cta--full" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Iniciar sesión
          </Link>
          <Link to="/#membresias" style={VOLVER}>
            <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" /> Volver a los planes
          </Link>
        </div>
      );
    }
    if (estado === 'listo') {
      return (
        <div className="ek-stack-md">
          <p className="ek-eyebrow" style={{ margin: 0 }}>LISTO</p>
          <h2 className="ek-h3" style={{ margin: 0 }}>Tu cuenta está lista</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Tu correo quedó confirmado y ya tienes contraseña. Sigue para pagar tu plan.
          </p>
          <button type="button" onClick={() => navigate('/app', { replace: true })} className="ek-cta ek-cta--full">
            Continuar
          </button>
        </div>
      );
    }
    return (
      <div className="ek-stack-md">
        <p className="ek-eyebrow" style={{ margin: 0 }}>CORREO CONFIRMADO</p>
        <h2 className="ek-h3" style={{ margin: 0 }}>Elige tu contraseña</h2>
        <CambiarPasswordForm
          autoFocus
          ctaLabel="Crear mi contraseña"
          onSuccess={() => {
            conContrasena.current = true;
            setEstado('listo');
          }}
        />
      </div>
    );
  }

  return (
    <div style={WRAP}>
      <div style={{ maxWidth: '400px', width: '100%' }}>
        <div className="ek-card">{contenido()}</div>
      </div>
    </div>
  );
}
