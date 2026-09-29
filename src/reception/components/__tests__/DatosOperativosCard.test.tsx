import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/** PKG-02A (C02 · F12) — la ficha no afirma "Sin plan" cuando los planes no se pudieron leer. */

const h = vi.hoisted(() => ({
  planes: { planes: [] as { slug: string; nombre: string }[], isLoading: false, error: false, recargar: vi.fn() }
}));
vi.mock('@shared/hooks/usePlanesActivos', () => ({ usePlanesActivos: () => h.planes }));
vi.mock('@shared/components/PlanChip', () => ({ PlanChip: (p: { slug: string | null }) => <span>CHIP:{p.slug}</span> }));

import { DatosOperativosCard } from '../perfil/DatosOperativosCard';

const MIEMBRO = { id: 'u1', nombre: 'Ana', email: 'ana@e.mx', telefono: null, avatar_url: null, membresia_tier: 'pro', status: 'activo', no_shows_count: 0, bloqueado_hasta: null, identidad_completa: true, contrato_firmado: true, created_at: '2026-01-01T00:00:00Z' };

describe('DatosOperativosCard · plan (PKG-02A)', () => {
  beforeEach(() => {
    h.planes = { planes: [], isLoading: false, error: false, recargar: vi.fn() };
  });

  it('plan activo → chip', () => {
    h.planes.planes = [{ slug: 'pro', nombre: 'Pro' }];
    render(<DatosOperativosCard miembro={MIEMBRO as never} membresia={null} />);
    expect(screen.getByText('CHIP:pro')).toBeInTheDocument();
  });

  it('planes OK pero el tier ya no existe → "Sin plan" (ausencia real)', () => {
    render(<DatosOperativosCard miembro={MIEMBRO as never} membresia={null} />);
    expect(screen.getByText('Sin plan')).toBeInTheDocument();
  });

  it('planes en error → "No disponible", nunca "Sin plan"', () => {
    h.planes.error = true;
    render(<DatosOperativosCard miembro={MIEMBRO as never} membresia={null} />);
    expect(screen.getByText('No disponible')).toBeInTheDocument();
    expect(screen.queryByText('Sin plan')).not.toBeInTheDocument();
  });
});
