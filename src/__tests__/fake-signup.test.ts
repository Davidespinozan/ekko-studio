import { describe, it, expect, vi } from 'vitest';

/**
 * `fake-signup` quedó RETIRADO en PKG-06C (FR-24): creaba la cuenta con el correo
 * auto-confirmado, sin límite, delatando cuentas existentes y reescribiendo el
 * perfil vinculado. Ahora es un stub inerte: no crea cliente de Supabase, no toca
 * Auth ni la base y responde 410 con un texto escrito a mano (la copia vieja de la
 * app en caché lo muestra tal cual). El registro vive en `alta-publica`.
 */

const mockCreateClient = vi.fn();
vi.mock('@supabase/supabase-js', () => ({ createClient: (...a: unknown[]) => mockCreateClient(...a) }));

import { handler } from '../../netlify/functions/fake-signup';

type AnyEvent = Parameters<typeof handler>[0];

describe('fake-signup · retirado (PKG-06C)', () => {
  it('cualquier llamada (aun con datos válidos o privilegiados) → 410 seguro, sin Supabase', async () => {
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    for (const body of [
      { nombre: 'Cliente', email: 'nuevo@x.com', password: 'password123', tier: 'pro' },
      { nombre: 'X', email: 'a@b.mx', password: 'p', tier: 'pro', rol: 'admin', status: 'activo' }
    ]) {
      const res = (await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) } as unknown as AnyEvent, {} as never, () => {})) as {
        statusCode: number;
        body: string;
      };
      expect(res.statusCode).toBe(410);
      expect(JSON.parse(res.body)).toEqual({ error: 'El registro se actualizó. Recarga la página para continuar.', seguro: true });
    }
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
