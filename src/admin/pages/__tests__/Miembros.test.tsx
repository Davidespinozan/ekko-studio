import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * PKG-02A (C02 · F04/F07) — /admin/miembros:
 *  - error al cargar miembros → estado de error, NUNCA "Todavía no hay miembros";
 *  - error al cargar membresías → columna "NO DISPONIBLE", NUNCA todos "SIN MEMBRESÍA";
 *  - success vacío → EmptyState real; cargando → ni vacío ni error.
 */

const h = vi.hoisted(() => ({
  miembros: { miembros: [] as Record<string, unknown>[], isLoading: false, error: false, refetch: vi.fn() },
  membresias: { porUsuario: new Map<string, unknown>(), isLoading: false, error: false, refetch: vi.fn() }
}));

vi.mock('../../hooks/useAdminData', () => ({
  useMiembros: () => h.miembros,
  useMembresiasVigentesPorUsuario: () => h.membresias
}));
vi.mock('../../components/NuevaPersonaModal', () => ({ NuevaPersonaModal: () => null }));

import Miembros from '../Miembros';

const ANA = { id: 'u1', nombre: 'Ana', email: 'ana@e.mx', membresia_tier: 'starter', status: 'activo', created_at: '2026-01-01T00:00:00Z', identidad_completa: true, contrato_firmado: true, no_shows_count: 0 };
const montar = (ruta = '/admin/miembros') => render(<MemoryRouter initialEntries={[ruta]}><Miembros /></MemoryRouter>);

describe('Miembros (PKG-02A)', () => {
  beforeEach(() => {
    h.miembros = { miembros: [], isLoading: false, error: false, refetch: vi.fn() };
    h.membresias = { porUsuario: new Map(), isLoading: false, error: false, refetch: vi.fn() };
  });

  it('success vacío → "Todavía no hay miembros" (vacío real)', () => {
    montar();
    expect(screen.getByText('Todavía no hay miembros')).toBeInTheDocument();
  });

  it('error al cargar miembros → "No pudimos cargar los miembros." + Reintentar; NO el vacío', () => {
    h.miembros.error = true;
    montar();
    expect(screen.queryByText('Todavía no hay miembros')).not.toBeInTheDocument();
    expect(screen.queryByText('Sin resultados')).not.toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar los miembros.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.miembros.refetch).toHaveBeenCalledTimes(1);
  });

  it('cargando → ni vacío ni error', () => {
    h.miembros.isLoading = true;
    montar();
    expect(screen.queryByText('Todavía no hay miembros')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('miembros OK + membresías OK sin filas → "SIN MEMBRESÍA" (ausencia real)', () => {
    h.miembros.miembros = [ANA];
    montar();
    expect(screen.getAllByText('SIN MEMBRESÍA').length).toBeGreaterThan(0);
    expect(screen.queryByText('NO DISPONIBLE')).not.toBeInTheDocument();
  });

  it('miembros OK + membresías en ERROR → lista conservada, columna "NO DISPONIBLE", aviso con Reintentar, y NUNCA "SIN MEMBRESÍA"', () => {
    h.miembros.miembros = [ANA];
    h.membresias.error = true;
    montar();
    expect(screen.getAllByText('Ana').length).toBeGreaterThan(0);
    expect(screen.queryByText('SIN MEMBRESÍA')).not.toBeInTheDocument();
    expect(screen.getAllByText('NO DISPONIBLE').length).toBeGreaterThan(0);
    expect(screen.getByText(/membresías no disponibles/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.membresias.refetch).toHaveBeenCalledTimes(1);
  });

  it('filtro ?filtro=vencidas con membresías en error → no se aplica (no produce una lista vacía falsa) y se avisa', () => {
    h.miembros.miembros = [ANA];
    h.membresias.error = true;
    montar('/admin/miembros?filtro=vencidas');
    expect(screen.getAllByText('Ana').length).toBeGreaterThan(0);
    expect(screen.queryByText('Sin resultados')).not.toBeInTheDocument();
    expect(screen.getByText(/no se puede aplicar/)).toBeInTheDocument();
  });
});
