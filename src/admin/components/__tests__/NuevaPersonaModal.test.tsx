import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/** PKG-02A (C02 · F12) — el selector de plan con los planes en error no se interpreta como "sin planes". */

const h = vi.hoisted(() => ({
  planes: { planes: [] as { slug: string; nombre: string }[], isLoading: false, error: false, recargar: vi.fn() }
}));
vi.mock('@shared/hooks/usePlanesActivos', () => ({ usePlanesActivos: () => h.planes }));
vi.mock('../../hooks/useAdminData', () => ({ adminCreateUser: vi.fn() }));

import { NuevaPersonaModal } from '../NuevaPersonaModal';

const montar = () => render(<NuevaPersonaModal onClose={vi.fn()} onCreated={vi.fn().mockResolvedValue(undefined)} />);

describe('NuevaPersonaModal · planes (PKG-02A)', () => {
  beforeEach(() => {
    h.planes = { planes: [], isLoading: false, error: false, recargar: vi.fn() };
  });

  it('success → los planes aparecen como opciones y el selector está habilitado', () => {
    h.planes.planes = [{ slug: 'pro', nombre: 'Pro' }];
    montar();
    const select = screen.getByLabelText(/Plan inicial/) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(screen.getByRole('option', { name: 'Pro' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('success vacío → "— sin plan asignado —" sin aviso (no hay planes de verdad)', () => {
    montar();
    expect(screen.getByRole('option', { name: '— sin plan asignado —' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('error → selector deshabilitado con "planes no disponibles" + aviso con Reintentar', () => {
    h.planes.error = true;
    h.planes.planes = [{ slug: 'pro', nombre: 'Pro' }]; // aunque hubiera dato previo, no se asigna con datos desconocidos
    montar();
    const select = screen.getByLabelText(/Plan inicial/) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByRole('option', { name: '— planes no disponibles —' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Pro' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/No pudimos cargar los planes/);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.planes.recargar).toHaveBeenCalledTimes(1);
  });
});
