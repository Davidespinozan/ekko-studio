import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * ERROR-UI-FIX E-01 — ante un error de Supabase al cargar el tenant, la
 * pantalla pública de arranque muestra copy fijo human-friendly + botón
 * Recargar, nunca el mensaje crudo de Postgres.
 *
 * Mock estable (vi.hoisted): el resultado de la query `tenants` se controla
 * por test. El builder devuelve referencias fijas (lección RP-3a).
 */

const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown }
}));

vi.mock('@shared/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = () => Promise.resolve(h.result);
  return { supabase: { from: () => builder } };
});

import { TenantProvider } from '../TenantProvider';

beforeEach(() => {
  h.result = { data: null, error: null };
});

describe('TenantProvider · ERROR-UI-FIX E-01', () => {
  it('queryError → copy fijo + botón Recargar, NO el mensaje crudo de Postgres', async () => {
    h.result = { data: null, error: { message: 'relation "tenants" does not exist' } };

    render(
      <TenantProvider>
        <div>contenido protegido</div>
      </TenantProvider>
    );

    await waitFor(() =>
      expect(screen.getByText(/No pudimos cargar la configuración del estudio/i)).toBeInTheDocument()
    );
    // El detalle técnico de Postgres NO llega a la UI.
    expect(screen.queryByText(/relation "tenants"/)).not.toBeInTheDocument();
    // Hay una salida para el usuario.
    expect(screen.getByRole('button', { name: /recargar/i })).toBeInTheDocument();
  });
});
