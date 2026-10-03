import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PKG-01H · UI de invitados:
 *  - InvitadosModal muestra lo CUBIERTO por la reserva (incluidos + extras
 *    pagados) y deshabilita "Agregar" al llegar al tope; el servidor manda.
 *  - Check-in / detalle: titular + incluidos + extras pagados, desglosado.
 *  - Etiqueta de la revisión nueva y texto de ayuda sin "se cobra en caja".
 */

const h = vi.hoisted(() => ({ resp: null as Record<string, unknown> | null }));
vi.mock('../../lib/invitados', () => ({
  listarInvitados: () => Promise.resolve(h.resp),
  agregarInvitado: vi.fn(),
  quitarInvitado: vi.fn()
}));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));

import { InvitadosModal } from '../InvitadosModal';
import { desglosePersonas } from '../CheckInDetail';
import { LABEL_TIPO_REVISION } from '../../../admin/hooks/useRevisionesFinancieras';

const base = { invitados: [], max_incluidos: 2, invitados_extra_pagados: 1, precio_invitado_extra_centavos: 10000, extras: 0, cubiertos: 3, disponibles: 3, total: 0 };

beforeEach(() => { h.resp = { ...base }; });

describe('InvitadosModal (PKG-01H)', () => {
  it('muestra la cobertura de la reserva: 0 de 3 · 2 incluidos + 1 extra pagado; Agregar habilitado', async () => {
    render(<InvitadosModal reservaId="r1" miembroNombre="Ana" onClose={() => {}} />);
    expect(await screen.findByTestId('cobertura-invitados')).toHaveTextContent('0 de 3 registrados · 2 incluidos + 1 extra pagado');
    expect(screen.getByRole('button', { name: /Agregar invitado/ })).not.toBeDisabled();
  });

  it('al tope (3 de 3) → "Todo cubierto" y Agregar deshabilitado, con la explicación de cómo pagar extras', async () => {
    h.resp = {
      ...base, total: 3, disponibles: 0,
      invitados: [
        { id: 'g1', nombre: 'Uno', es_extra: false, foto_url: null, created_at: 'x' },
        { id: 'g2', nombre: 'Dos', es_extra: false, foto_url: null, created_at: 'x' },
        { id: 'g3', nombre: 'Tres', es_extra: true, foto_url: null, created_at: 'x' }
      ]
    };
    render(<InvitadosModal reservaId="r1" miembroNombre="Ana" onClose={() => {}} />);
    expect(await screen.findByText('Todo cubierto')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Agregar invitado/ })).toBeDisabled();
    expect(screen.getByText(/Ya están registrados todos los invitados que cubre la reserva/)).toBeInTheDocument();
    expect(screen.getAllByText('EXTRA')).toHaveLength(1);
  });

  it('reserva sin invitados (0 cubiertos) → Agregar deshabilitado', async () => {
    h.resp = { ...base, max_incluidos: 0, invitados_extra_pagados: 0, cubiertos: 0, disponibles: 0 };
    render(<InvitadosModal reservaId="r1" miembroNombre="Ana" onClose={() => {}} />);
    expect(await screen.findByText(/Esta reserva no incluye invitados/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Agregar invitado/ })).toBeDisabled();
  });
});

describe('desglose de personas (check-in)', () => {
  it('titular + incluidos + extras pagados', () => {
    expect(desglosePersonas(0, 0)).toBe('1');
    expect(desglosePersonas(2, 0)).toBe('3 (titular + 2 incluidos)');
    expect(desglosePersonas(2, 1)).toBe('4 (titular + 2 incluidos + 1 extra pagado)');
    expect(desglosePersonas(0, 2)).toBe('3 (titular + 2 extras pagados)');
  });
});

describe('textos (PKG-01H)', () => {
  it('la revisión nueva tiene etiqueta legible', () => {
    expect(LABEL_TIPO_REVISION.invitados_extra_no_aplicado).toBe('Pago de invitados extra sin aplicar');
  });

  it('la ayuda del precio de extras ya no dice que se cobra en caja', () => {
    const src = readFileSync(resolve(__dirname, '../../../admin/pages/AjustesReglas.tsx'), 'utf8');
    expect(src).not.toMatch(/Se cobra en caja/);
    expect(src).toMatch(/El miembro lo paga con tarjeta desde su app/);
  });
});
