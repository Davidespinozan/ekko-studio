import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { validarStatusStaff } from '@shared/lib/validarStatusCuenta';

/**
 * Redirige a /login si no hay sesión, o a /app si el usuario no es admin.
 * Espera a que `usuario` esté hidratado antes de decidir (evita redirect
 * prematuro mientras `setTimeout(0)` del fix de deadlock Supabase v2 corre).
 *
 * Un admin cuya cuenta ya no está `activo` (revocado/suspendido) se saca del
 * panel aunque conserve su sesión: "Revocar acceso" solo cambia el status, y
 * Login valida al entrar pero no a la sesión que ya estaba abierta.
 */
export function useAdminGuard() {
  const { authUser, usuario, isLoading, errorSesion, reintentarSesion, signOut } = useAuth();
  const navigate = useNavigate();
  const yaCerrado = useRef(false);

  useEffect(() => {
    // 1. Auth aún cargando (restaurando sesión inicial)
    if (isLoading) return;

    // 2. No hay sesión → login
    if (!authUser) {
      navigate('/login', { replace: true });
      return;
    }

    // PKG-06D (E-16): la hidratación falló → el layout muestra el error, no redirige.
    if (errorSesion) return;

    // 3. Hay sesión pero usuario aún no hidratado → esperar
    //    (la query a `usuarios` corre dentro de setTimeout(0) por el
    //    fix de deadlock Supabase v2, así que hay una ventana de unos
    //    ms donde authUser existe pero usuario todavía es null)
    if (!usuario) return;

    // 4. Usuario hidratado pero rol incorrecto → redirect a app
    if (usuario.rol !== 'admin') {
      navigate('/app', { replace: true });
      return;
    }

    // 5. Admin con la cuenta inactiva → fuera, con el motivo en el login.
    const validacion = validarStatusStaff(usuario);
    if (!validacion.permitido && !yaCerrado.current) {
      yaCerrado.current = true;
      // Primero al login CON el motivo y después se cierra la sesión (mismo
      // orden que MemberLayout): al revés, el paso 2 gana la carrera y el
      // mensaje se pierde.
      navigate('/login', { replace: true, state: { mensaje: validacion.mensaje } });
      void signOut();
    }
  }, [authUser, usuario, isLoading, errorSesion, navigate, signOut]);

  // El layout muestra LoadingScreen hasta que tengamos certeza de admin ACTIVO
  const isReady =
    !isLoading && !!usuario && usuario.rol === 'admin' && validarStatusStaff(usuario).permitido;
  return { usuario, isLoading: !isReady && !errorSesion, errorSesion, reintentarSesion, signOut };
}
