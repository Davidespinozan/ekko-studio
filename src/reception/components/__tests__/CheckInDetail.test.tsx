import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * CheckInDetail — toggle "¿Grabamos nosotros este material?": el único
 * momento cara a cara con el cliente para apagar la excepción (trae su
 * propio equipo). Default TRUE (EKKO-075: el estudio entrega).
 */

const h = vi.hoisted(() => ({ marcar: vi.fn(), toastError: vi.fn() }));
vi.mock('@shared/lib/material', () => ({ marcarMaterialRequerido: (...a: unknown[]) => h.marcar(...a) }));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => ({ error: h.toastError, success: vi.fn(), info: vi.fn() }) }));

import { CheckInDetail } from '../CheckInDetail';

const MIEMBRO = { id: 'm1', nombre: 'Ana', email: 'ana@e.mx', telefono: null, avatar_url: null, membresia_tier: 'starter', notas_admin: null };
const RECURSO = { id: 'r1', nombre: 'Estudio 1' };
const RESERVA = { id: 'res-1', folio: 'F-1', slot_inicio: '2026-01-01T10:00:00Z', slot_fin: '2026-01-01T11:00:00Z', duracion_min: 60, invitados_count: 0 };

function montar(props: Partial<ComponentProps<typeof CheckInDetail>> = {}) {
  return render(
    <CheckInDetail kind="success" miembro={MIEMBRO} recurso={RECURSO} reserva={RESERVA} onClose={() => {}} {...props} />
  );
}

describe('CheckInDetail — ¿grabamos nosotros?', () => {
  beforeEach(() => {
    h.marcar.mockReset().mockResolvedValue(undefined);
    h.toastError.mockReset();
  });

  it('nace en "Sí" cuando la reserva no trae el campo (default del backend)', () => {
    montar();
    expect(screen.getByRole('tab', { name: 'Sí' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /trae su equipo/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('nace en "No" si la reserva ya venía marcada material_requerido: false', () => {
    montar({ reserva: { ...RESERVA, material_requerido: false } });
    expect(screen.getByRole('tab', { name: /trae su equipo/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('clic en "No, trae su equipo" llama a marcarMaterialRequerido(reservaId, false) y cambia la pestaña activa', async () => {
    montar();
    fireEvent.click(screen.getByRole('tab', { name: /trae su equipo/ }));
    await waitFor(() => expect(h.marcar).toHaveBeenCalledWith('res-1', false));
    expect(screen.getByRole('tab', { name: /trae su equipo/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('si falla el guardado, muestra el error y NO cambia la pestaña activa', async () => {
    h.marcar.mockRejectedValue(new Error('no se pudo'));
    montar();
    fireEvent.click(screen.getByRole('tab', { name: /trae su equipo/ }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(screen.getByRole('tab', { name: 'Sí' })).toHaveAttribute('aria-selected', 'true');
  });

  it('clic repetido en la pestaña ya activa no vuelve a llamar al servidor', () => {
    montar();
    fireEvent.click(screen.getByRole('tab', { name: 'Sí' }));
    expect(h.marcar).not.toHaveBeenCalled();
  });
});
