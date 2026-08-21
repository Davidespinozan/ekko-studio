import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { CambiarPasswordForm } from '@shared/components/CambiarPasswordForm';

type EstadoEnlace = 'verificando' | 'listo' | 'invalido';

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
 * /nueva-contrasena — destino del enlace de recuperación (y del "email de
 * recuperación" que manda el admin). Supabase (detectSessionInUrl) deja una
 * sesión de recuperación; aquí el usuario fija su nueva clave.
 */
export default function NuevaContrasena() {
  const navigate = useNavigate();
  const [enlace, setEnlace] = useState<EstadoEnlace>('verificando');
  const [exito, setExito] = useState(false);
  const exitoRef = useRef(false);

  // Sesión efímera: si abandona sin cambiar la clave, cerramos sesión al salir
  // (en un dispositivo compartido quedaría logueado con el enlace del correo).
  useEffect(() => {
    return () => {
      if (!exitoRef.current) void supabase.auth.signOut();
    };
  }, []);

  useEffect(() => {
    let cancelado = false;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelado && session) setEnlace('listo');
    });
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelado) return;
      if (session) {
        setEnlace('listo');
      } else {
        // Margen para que detectSessionInUrl procese el hash del enlace.
        setTimeout(() => {
          if (!cancelado) setEnlace((e) => (e === 'verificando' ? 'invalido' : e));
        }, 2500);
      }
    });
    return () => {
      cancelado = true;
      subscription.unsubscribe();
    };
  }, []);

  function contenido() {
    if (enlace === 'verificando') {
      return <p className="ek-body-muted" style={{ margin: 0, textAlign: 'center' }}>Verificando el enlace…</p>;
    }
    if (enlace === 'invalido') {
      return (
        <div className="ek-stack-md">
          <p className="ek-eyebrow" style={{ margin: 0, color: 'var(--ek-danger)' }}>ENLACE NO VÁLIDO</p>
          <h2 className="ek-h3" style={{ margin: 0 }}>El enlace expiró o no es válido</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Los enlaces de recuperación caducan por seguridad. Pide uno nuevo.
          </p>
          <Link to="/recuperar" className="ek-cta ek-cta--full" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Pedir un enlace nuevo
          </Link>
          <Link to="/login" style={VOLVER}>
            <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" /> Volver al login
          </Link>
        </div>
      );
    }
    if (exito) {
      return (
        <div className="ek-stack-md">
          <p className="ek-eyebrow" style={{ margin: 0 }}>LISTO</p>
          <h2 className="ek-h3" style={{ margin: 0 }}>Contraseña actualizada</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Tu contraseña se cambió correctamente. Ya puedes entrar con la nueva.
          </p>
          <button type="button" onClick={() => navigate('/', { replace: true })} className="ek-cta ek-cta--full">
            Ir a mi cuenta
          </button>
        </div>
      );
    }
    return (
      <div className="ek-stack-md">
        <p className="ek-eyebrow" style={{ margin: 0 }}>NUEVA CONTRASEÑA</p>
        <h2 className="ek-h3" style={{ margin: 0 }}>Elige tu nueva contraseña</h2>
        <CambiarPasswordForm
          autoFocus
          onSuccess={() => {
            exitoRef.current = true; // cambio completado → la sesión ya no es efímera
            setExito(true);
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
