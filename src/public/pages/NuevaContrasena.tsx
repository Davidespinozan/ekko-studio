import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AccesoLayout } from '../components/AccesoLayout';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { CambiarPasswordForm } from '@shared/components/CambiarPasswordForm';

type EstadoEnlace = 'verificando' | 'listo' | 'invalido';

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
          <span className="ek-kicker" style={{ color: 'var(--ek-danger)' }}>Enlace no válido</span>
          <h2 className="ek-acceso-h1">El enlace expiró o no es válido</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Los enlaces de recuperación caducan por seguridad. Pide uno nuevo.
          </p>
          <Link to="/recuperar" className="ek-cta ek-cta--gold ek-cta--full" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Pedir un enlace nuevo
          </Link>
          <Link to="/login" className="ek-acceso-enlace">
            <ArrowLeft size={14} strokeWidth={2.25} aria-hidden="true" /> Volver al login
          </Link>
        </div>
      );
    }
    if (exito) {
      return (
        <div className="ek-stack-md">
          <span className="ek-kicker">Listo</span>
          <h2 className="ek-acceso-h1">Contraseña actualizada</h2>
          <p className="ek-body-muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Tu contraseña se cambió correctamente. Ya puedes entrar con la nueva.
          </p>
          <button type="button" onClick={() => navigate('/', { replace: true })} className="ek-cta ek-cta--gold ek-cta--full">
            Ir a mi cuenta
          </button>
        </div>
      );
    }
    return (
      <div className="ek-stack-md">
        <span className="ek-kicker">Nueva contraseña</span>
        <h2 className="ek-acceso-h1">Elige tu nueva contraseña</h2>
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
    <AccesoLayout>{contenido()}</AccesoLayout>
  );
}
