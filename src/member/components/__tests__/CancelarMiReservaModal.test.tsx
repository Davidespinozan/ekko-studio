import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * M16 (paridad SALA): cancelar una reserva con invitados extra YA PAGADOS no
 * devuelve ese cobro solo. El modal lo avisa antes de confirmar y da el canal
 * (WhatsApp del estudio) con el folio ya escrito.
 */

const h = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock('@shared/providers/TenantProvider', () => ({ useTenantOpcional: () => ({ id: 't-1', config: h.config }) }));
vi.mock('@shared/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })
}));
vi.mock('@member/hooks/useReservas', () => ({ cancelarReserva: vi.fn() }));

import { CancelarMiReservaModal } from '../CancelarMiReservaModal';

const RESERVA = { id: 'r1', slot_inicio: '2026-10-01T16:00:00Z', recurso_nombre: 'Set Black', folio: 'EK-0042' };

function abrirConfirmacion(invitados: number | null | undefined) {
  render(<CancelarMiReservaModal reserva={{ ...RESERVA, invitados_extra_pagados: invitados }} onClose={vi.fn()} onCancelada={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /continuar/i }));
}

beforeEach(() => {
  h.config = { contacto: { whatsapp_e164: '5216671234567', whatsapp_mensaje_default: 'Hola' } };
});

describe('CancelarMiReservaModal · invitados extra pagados (M16)', () => {
  it('con invitados pagados avisa que el cobro no se devuelve solo y da el WhatsApp con el folio', () => {
    abrirConfirmacion(2);
    const aviso = screen.getByRole('note');
    expect(aviso).toHaveTextContent('2 invitados extra pagados');
    expect(aviso).toHaveTextContent(/no se devuelve automáticamente/i);
    const link = screen.getByRole('link', { name: /escríbele al estudio/i });
    expect(link.getAttribute('href')).toContain('wa.me/5216671234567');
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain('folio EK-0042');
  });

  it('singular con un solo invitado', () => {
    abrirConfirmacion(1);
    expect(screen.getByRole('note')).toHaveTextContent('1 invitado extra pagado');
  });

  it('sin invitados pagados no hay aviso', () => {
    abrirConfirmacion(0);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('el dato puede faltar (reservas viejas) y no truena', () => {
    abrirConfirmacion(undefined);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sí, cancelar/i })).toBeInTheDocument();
  });
});
