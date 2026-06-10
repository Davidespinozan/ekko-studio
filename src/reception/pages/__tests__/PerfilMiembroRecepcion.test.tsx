import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * Recepción Plus: el perfil de recepción ahora es un panel de GESTIÓN del
 * front-desk (foto, datos, credenciales, desbloqueo, reservas), no una vista
 * read-only. Este test cubre que se muestran los datos, las acciones de
 * cuenta y que "Crear reserva" respeta el status del miembro.
 */

const hoisted = vi.hoisted(() => ({
  miembro: {} as Record<string, unknown>,
  reservas: [] as Record<string, unknown>[]
}));

const RESERVA_PROXIMA = {
  id: 'res-1',
  slot_inicio: '2030-01-01T10:00:00.000Z',
  slot_fin: '2030-01-01T11:00:00.000Z',
  status: 'confirmada',
  folio: 'EKK-000001',
  recurso_id: 'rec-1',
  recurso: { nombre: 'Estudio A' }
};

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
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: hoisted.reservas, error: null })
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
    <ToastProvider>
      <MemoryRouter initialEntries={['/recepcion/miembros/m-1']}>
        <Routes>
          <Route path="/recepcion/miembros/:id" element={<PerfilMiembroRecepcion />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('PerfilMiembroRecepcion · gestión front-desk', () => {
  beforeEach(() => {
    hoisted.miembro = {
      id: 'm-1',
      nombre: 'ana lópez',
      email: 'ana@cravia.mx',
      telefono: '6661234567',
      avatar_url: null,
      membresia_tier: 'pro',
      status: 'activo',
      no_shows_count: 0,
      bloqueado_hasta: null,
      created_at: '2026-01-10T12:00:00Z'
    };
    hoisted.reservas = [];
  });

  it('muestra los datos del miembro', async () => {
    renderPerfil();
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
    expect(screen.getByText('ana@cravia.mx')).toBeInTheDocument();
  });

  it('ofrece las acciones de cuenta del front-desk', async () => {
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /editar datos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tomar foto/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resetear acceso/i })).toBeInTheDocument();
  });

  it('un miembro suspendido muestra la alerta de estado', async () => {
    hoisted.miembro = { ...hoisted.miembro, status: 'suspendido' };
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getAllByText(/suspendido/i).length).toBeGreaterThan(0);
  });

  it('miembro bloqueado: ofrece "Desbloquear ahora"', async () => {
    hoisted.miembro = { ...hoisted.miembro, bloqueado_hasta: '2099-01-01T00:00:00Z' };
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /desbloquear/i })).toBeInTheDocument();
  });

  it('miembro activo: "Crear reserva" habilitado', async () => {
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /crear reserva/i })).not.toBeDisabled();
  });

  it('miembro no-activo: "Crear reserva" deshabilitado', async () => {
    hoisted.miembro = { ...hoisted.miembro, status: 'suspendido' };
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /crear reserva/i })).toBeDisabled();
  });

  it('miembro activo: acción "Reprogramar" habilitada', async () => {
    hoisted.reservas = [RESERVA_PROXIMA];
    renderPerfil();
    await screen.findByText('Ana López');
    expect(await screen.findByRole('button', { name: /reprogramar/i })).not.toBeDisabled();
  });
});
