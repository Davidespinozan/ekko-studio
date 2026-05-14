import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';

/**
 * Redirige a /app si el usuario actual NO es admin.
 * Llamar en AdminLayout para proteger toda la sección.
 */
export function useAdminGuard() {
  const { usuario, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading) return;
    if (!usuario) {
      navigate('/login', { replace: true });
      return;
    }
    if (usuario.rol !== 'admin') {
      navigate('/app', { replace: true });
    }
  }, [usuario, isLoading, navigate]);

  return { usuario, isLoading };
}
