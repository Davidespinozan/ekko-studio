import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * Búsqueda de miembros: debe ser INSENSIBLE a acentos y mayúsculas
 * (José ↔ jose) — bug reportado: "busco el nombre y no aparece".
 */

const hoisted = vi.hoisted(() => ({
  miembros: [] as Record<string, unknown>[]
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) b[m] = () => b;
      b.limit = () => Promise.resolve({ data: hoisted.miembros, error: null });
      return b;
    }
  }
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));

import BuscarMiembro from '../BuscarMiembro';

function renderBuscar() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <BuscarMiembro />
      </MemoryRouter>
    </ToastProvider>
  );
}

beforeEach(() => {
  hoisted.miembros = [
    { id: 'm-1', nombre: 'José Pérez', email: 'jose@ekko.mx', status: 'activo', membresia_tier: 'pro', bloqueado_hasta: '2999-01-01T00:00:00Z' },
    { id: 'm-2', nombre: 'Ana López', email: 'ana@ekko.mx', status: 'activo', membresia_tier: 'basica', bloqueado_hasta: null }
  ];
});

describe('BuscarMiembro · acentos/mayúsculas', () => {
  it('encuentra "José Pérez" buscando "jose perez" (sin acentos)', async () => {
    renderBuscar();
    fireEvent.change(screen.getByLabelText('Buscar miembro'), { target: { value: 'jose perez' } });
    expect(await screen.findByText('José Pérez')).toBeInTheDocument();
    expect(screen.queryByText('Ana López')).not.toBeInTheDocument();
  });

  it('busca también por email', async () => {
    renderBuscar();
    fireEvent.change(screen.getByLabelText('Buscar miembro'), { target: { value: 'ANA@ekko' } });
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
  });

  it('sin coincidencias muestra el estado vacío', async () => {
    renderBuscar();
    fireEvent.change(screen.getByLabelText('Buscar miembro'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Sin coincidencias')).toBeInTheDocument();
  });

  it('el toggle "Penalizados" lista solo a los bloqueados activos (Bloque D)', async () => {
    renderBuscar();
    fireEvent.click(await screen.findByRole('button', { name: /penalizados/i }));
    expect(await screen.findByText('José Pérez')).toBeInTheDocument();
    expect(screen.queryByText('Ana López')).not.toBeInTheDocument();
  });

  it('el botón "Registrar" abre el alta de miembro', async () => {
    renderBuscar();
    fireEvent.click(screen.getByRole('button', { name: 'Registrar' }));
    expect(await screen.findByText('Nuevo miembro')).toBeInTheDocument();
  });
});
