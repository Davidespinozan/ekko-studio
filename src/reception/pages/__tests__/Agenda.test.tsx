import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Bloque B/C: Agenda alterna Semana/Lista, default Lista en mobile, y usa el
 * Detalle en modo read-only (sin onCancelar). Stubeamos los hijos pesados.
 */

vi.mock('@shared/components/calendario/VistaSemana', () => ({
  default: () => <div>SEMANA_STUB</div>
}));
vi.mock('@admin/components/ReservasVistaLista', () => ({
  default: () => <div>LISTA_STUB</div>
}));
vi.mock('@admin/components/DetalleReservaModal', () => ({
  default: ({ reservaId }: { reservaId: string | null }) => (
    <div>DETALLE:{reservaId ?? 'cerrado'}</div>
  )
}));

import Agenda from '../Agenda';

function setMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
}

describe('Agenda · toggle Semana/Lista (read-only)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('default en mobile = Lista', () => {
    setMatchMedia(false); // no es desktop
    render(<Agenda />);
    expect(screen.getByText('LISTA_STUB')).toBeInTheDocument();
    expect(screen.queryByText('SEMANA_STUB')).not.toBeInTheDocument();
  });

  it('default en desktop = Semana', () => {
    setMatchMedia(true);
    render(<Agenda />);
    expect(screen.getByText('SEMANA_STUB')).toBeInTheDocument();
  });

  it('el toggle cambia de Lista a Semana', () => {
    setMatchMedia(false);
    render(<Agenda />);
    expect(screen.getByText('LISTA_STUB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));
    expect(screen.getByText('SEMANA_STUB')).toBeInTheDocument();
  });

  it('monta el detalle cerrado (read-only, sin onCancelar)', () => {
    setMatchMedia(false);
    render(<Agenda />);
    expect(screen.getByText('DETALLE:cerrado')).toBeInTheDocument();
  });
});
