import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * PKG-02A (C02 · F13/F22) — /admin/planes:
 *  - error al cargar la lista → ErrorCarga, nunca "No hay planes activos.";
 *  - conteo de miembros desconocido (null) → la fila lo dice y el archivado queda bloqueado.
 */

const h = vi.hoisted(() => ({
  tiers: { tiers: [] as Record<string, unknown>[], isLoading: false, error: false, refetch: vi.fn() },
  count: null as number | null,
  archive: vi.fn()
}));
vi.mock('../../hooks/useAdminData', () => ({
  useTiersAdmin: () => h.tiers,
  updateTier: vi.fn(),
  insertTier: vi.fn()
}));
vi.mock('../../lib/crudHelpers', async (orig) => ({
  ...(await orig<typeof import('../../lib/crudHelpers')>()),
  countActiveMembersInTier: () => Promise.resolve(h.count),
  archiveRecord: (...a: unknown[]) => h.archive(...a),
  restoreRecord: vi.fn(),
  hardDeleteRecord: vi.fn(),
  canHardDeleteTier: vi.fn()
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));

import Tiers from '../Tiers';

const TIER = { id: 'tier-1', tenant_id: 't-1', slug: 'pro', nombre: 'Pro', precio_centavos: 120000, moneda: 'MXN', activo: true, en_venta: true, tipo: 'tiempo', clases_incluidas: null, duracion_dias: 30, beneficios: [], reglas: {}, descripcion: null, orden: 1, created_at: '2026-01-01', updated_at: '2026-01-01' };
const montar = () => render(<ToastProvider><Tiers /></ToastProvider>);

describe('Tiers (PKG-02A)', () => {
  beforeEach(() => {
    h.tiers = { tiers: [], isLoading: false, error: false, refetch: vi.fn() };
    h.count = 0;
    h.archive = vi.fn();
  });

  it('success vacío → "No hay planes activos." (vacío real)', () => {
    montar();
    expect(screen.getByText('No hay planes activos.')).toBeInTheDocument();
  });

  it('error de lista → "No pudimos cargar los planes." + Reintentar; NO el vacío', () => {
    h.tiers.error = true;
    montar();
    expect(screen.queryByText('No hay planes activos.')).not.toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar los planes.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.tiers.refetch).toHaveBeenCalledTimes(1);
  });

  it('conteo OK → "Sin miembros activos" en la fila', async () => {
    h.tiers.tiers = [TIER];
    montar();
    expect(await screen.findByText('Sin miembros activos')).toBeInTheDocument();
  });

  it('conteo DESCONOCIDO (null) → la fila dice "no disponible" y al eliminar el diálogo bloquea sin botón Eliminar', async () => {
    h.tiers.tiers = [TIER];
    h.count = null;
    montar();
    expect(await screen.findByText('Miembros activos: no disponible')).toBeInTheDocument();
    expect(screen.queryByText('Sin miembros activos')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acciones' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));

    const dialogo = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialogo).getByText(/No pudimos verificar cuántos miembros/)).toBeInTheDocument());
    expect(within(dialogo).queryByRole('button', { name: /^Eliminar$/ })).not.toBeInTheDocument();
    expect(h.archive).not.toHaveBeenCalled();
  });
});
