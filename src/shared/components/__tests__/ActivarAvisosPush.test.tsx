import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

const estado = vi.hoisted(() => ({ valor: 'inactivo' as string }));
vi.mock('@shared/lib/push', () => ({
  estadoPush: () => Promise.resolve(estado.valor),
  activarPush: vi.fn(),
  desactivarPush: vi.fn()
}));

import { ActivarAvisosPush } from '../ActivarAvisosPush';

function montar(props: Partial<React.ComponentProps<typeof ActivarAvisosPush>> = {}) {
  return render(
    <ToastProvider>
      <ActivarAvisosPush usuarioId="u1" tenantId="t1" {...props} />
    </ToastProvider>
  );
}

beforeEach(() => {
  estado.valor = 'inactivo';
});

/**
 * El opt-in de push vivía solo en el perfil del MIEMBRO: admin y recepción no
 * tenían dónde suscribirse, así que los avisos de "cobro rechazado" no llegaban a
 * ningún teléfono. Ahora es compartido, con texto propio para el staff.
 */
describe('ActivarAvisosPush', () => {
  it('sin activar: invita, con el texto de quien lo monta', async () => {
    montar({ descripcion: 'Entérate de un cobro rechazado.' });
    expect(await screen.findByText('Entérate de un cobro rechazado.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activar' })).toBeInTheDocument();
  });

  it('miembro (sin ocultarSiActivo): ya activo → se sigue mostrando, para poder desactivar', async () => {
    estado.valor = 'activo';
    montar();
    expect(await screen.findByRole('button', { name: 'Desactivar' })).toBeInTheDocument();
  });

  it('staff (ocultarSiActivo): ya activo → la invitación desaparece del panel', async () => {
    estado.valor = 'activo';
    const { container } = montar({ ocultarSiActivo: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('.ek-card')).toBeNull();
  });

  it('navegador sin push → no se muestra nada', async () => {
    estado.valor = 'no-soportado';
    const { container } = montar();
    await Promise.resolve();
    expect(container.querySelector('.ek-card')).toBeNull();
  });
});
