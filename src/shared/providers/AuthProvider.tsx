import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@shared/lib/supabase';
import { COLUMNAS_USUARIO_CLIENTE, type UsuarioCliente } from '@shared/lib/columnas';
import { setSentryUser } from '@shared/lib/sentry';
import type { TipoErrorSesion } from '@shared/components/ErrorSesion';

type Usuario = UsuarioCliente;

interface AuthContextValue {
  session: Session | null;
  authUser: User | null;
  usuario: Usuario | null;
  isLoading: boolean;
  /**
   * PKG-06D (E-16): la hidratación del perfil falló (`carga`) o la sesión es
   * válida pero no hay perfil (`sin_perfil`). Nunca se queda en "cargando".
   */
  errorSesion: TipoErrorSesion | null;
  /** Vuelve a intentar la hidratación (solo tiene sentido con `errorSesion === 'carga'`). */
  reintentarSesion: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-hidrata `usuario` desde la BD (tras editar el perfil, p. ej.). */
  refreshUsuario: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  authUser: null,
  usuario: null,
  isLoading: true,
  errorSesion: null,
  reintentarSesion: async () => {},
  signOut: async () => {},
  refreshUsuario: async () => {}
});

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Provee sesión + usuario hidratado desde la tabla `usuarios`.
 *
 * IMPORTANTE — Auth deadlock fix de Supabase JS v2:
 * Dentro del callback de onAuthStateChange, hacer `await supabase.from(...)`
 * causa deadlock porque ambos pelean el mismo lock interno.
 * La query de hidratación se difiere con `setTimeout(() => {...}, 0)`
 * para salir del auth lock.
 *
 * Ver docs/DECISIONS.md D-006.
 *
 * PKG-06D: la lectura pide SOLO las columnas que el cliente puede leer
 * (`COLUMNAS_USUARIO_CLIENTE`; `select('*')` ya no es válido sobre `usuarios`), y
 * `isLoading` dura hasta que la primera hidratación termina: un fallo deja
 * `errorSesion` (reintentable) en vez de una pantalla de carga infinita.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorSesion, setErrorSesion] = useState<TipoErrorSesion | null>(null);
  const sessionRef = useRef<Session | null>(null);

  // Función para hidratar usuario por auth_id
  const hydrateUsuario = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('usuarios')
        .select(COLUMNAS_USUARIO_CLIENTE)
        .eq('auth_id', userId)
        .maybeSingle();

      if (error) {
        console.error('[auth] Error hidratando usuario:', error);
        setErrorSesion('carga');
        return;
      }
      if (!data) {
        // Sesión válida en Auth, sin perfil en el estudio: no es "cargando".
        setUsuario(null);
        setErrorSesion('sin_perfil');
        setSentryUser(null);
        return;
      }
      const perfil = data as unknown as Usuario;
      setUsuario(perfil);
      setErrorSesion(null);
      // Atar el usuario a los errores de Sentry (id + email): sin esto cada error
      // llegaba anónimo y no se podía saber a quién le pasó.
      setSentryUser(perfil.id, perfil.email ?? undefined);
    } catch (e) {
      // Red caída / excepción del cliente: tampoco es "cargando".
      console.error('[auth] Error hidratando usuario:', e);
      setErrorSesion('carga');
    }
  }, []);

  useEffect(() => {
    // 1. Restaurar sesión al mount
    supabase.auth
      .getSession()
      .then(({ data: { session: initialSession } }) => {
        setSession(initialSession);
        sessionRef.current = initialSession;

        if (initialSession?.user) {
          // Diferir hidratación para no bloquear el primer paint. `isLoading`
          // se apaga cuando la hidratación TERMINA (con perfil o con error).
          setTimeout(() => {
            void hydrateUsuario(initialSession.user.id).finally(() => setIsLoading(false));
          }, 0);
        } else {
          setIsLoading(false);
        }
      })
      .catch((e) => {
        console.error('[auth] Error restaurando la sesión:', e);
        setErrorSesion('carga');
        setIsLoading(false);
      });

    // 2. Listener de cambios de auth
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, newSession) => {
        // Sincrónico: actualizar sesión inmediatamente
        setSession(newSession);
        sessionRef.current = newSession;

        if (event === 'SIGNED_OUT' || !newSession) {
          setUsuario(null);
          setErrorSesion(null);
          setSentryUser(null);
          return;
        }

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          // CRÍTICO: diferir la query con setTimeout para evitar deadlock
          setTimeout(() => {
            if (newSession.user) {
              void hydrateUsuario(newSession.user.id);
            }
          }, 0);
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [hydrateUsuario]);

  async function signOut() {
    await supabase.auth.signOut();
    setUsuario(null);
    setSession(null);
    sessionRef.current = null;
    setErrorSesion(null);
  }

  async function refreshUsuario() {
    const actual = sessionRef.current;
    if (actual?.user) await hydrateUsuario(actual.user.id);
  }

  const reintentarSesion = useCallback(async () => {
    const actual = sessionRef.current;
    if (!actual?.user) {
      setErrorSesion(null);
      return;
    }
    setIsLoading(true);
    await hydrateUsuario(actual.user.id);
    setIsLoading(false);
  }, [hydrateUsuario]);

  return (
    <AuthContext.Provider
      value={{
        session,
        authUser: session?.user ?? null,
        usuario,
        isLoading,
        errorSesion,
        reintentarSesion,
        signOut,
        refreshUsuario
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
