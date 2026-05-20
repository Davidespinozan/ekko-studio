import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Test de SEGURIDAD (RP-2): el perfil de recepción es READ-ONLY.
 * Verifica que NO renderiza controles de edición — recepción consulta,
 * no edita (riesgo R3 del RECEPCION_PLUS_PLAN). Si un sprint futuro
 * mete por error un control de edición acá, este test lo atrapa.
 */

const hoisted = vi.hoisted(() => ({
  miembro: {
    id: 'm-1',
    nombre: 'ana lópez',
    email: 'ana@cravia.mx',
    telefono: '6661234567',
    membresia_tier: 'pro',
    status: 'activo',
    no_shows_count: 0,
    bloqueado_hasta: null as string | null,
    created_at: '2026-01-10T12:00:00Z'
  } as Record<string, unknown>
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'usuarios') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: hoisted.miembro, error: null })
            })
          })
        };
      }
      // reservas
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null })
            })
          })
        })
      };
    })
  }
}));

import PerfilMiembroRecepcion from '../PerfilMiembroRecepcion';

function renderPerfil() {
  return render(
    <MemoryRouter initialEntries={['/recepcion/miembros/m-1']}>
      <Routes>
        <Route path="/recepcion/miembros/:id" element={<PerfilMiembroRecepcion />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('PerfilMiembroRecepcion · read-only', () => {
  beforeEach(() => {
    hoisted.miembro = {
      id: 'm-1',
      nombre: 'ana lópez',
      email: 'ana@cravia.mx',
      telefono: '6661234567',
      membresia_tier: 'pro',
      status: 'activo',
      no_shows_count: 0,
      bloqueado_hasta: null,
      created_at: '2026-01-10T12:00:00Z'
    };
  });

  it('muestra los datos del miembro', async () => {
    renderPerfil();
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
    expect(screen.getByText('ana@cravia.mx')).toBeInTheDocument();
  });

  it('NO renderiza controles de edición (recepción no edita)', async () => {
    const { container } = renderPerfil();
    await screen.findByText('Ana López');

    // Ningún control de edición de los que sí tiene MiembroDetalle (admin).
    expect(screen.queryByText(/reset/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cambiar rol/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/eliminar/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/guardar/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/suspender/i)).not.toBeInTheDocument();

    // Sin inputs ni selects editables — es una vista de pura lectura.
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('un miembro suspendido muestra la alerta de estado', async () => {
    hoisted.miembro = { ...hoisted.miembro, status: 'suspendido' };
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getAllByText(/suspendido/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/derivá al cliente con administración/i)).toBeInTheDocument();
  });
});
