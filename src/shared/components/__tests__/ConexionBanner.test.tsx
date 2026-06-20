import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ConexionBanner from '../ConexionBanner';

/**
 * El banner aparece cuando se cae la red (evento 'offline') y desaparece al
 * volver ('online').
 */
function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, writable: true, configurable: true });
}

describe('ConexionBanner', () => {
  beforeEach(() => setOnline(true));

  it('online: no muestra nada', () => {
    render(<ConexionBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('al caerse la red muestra el aviso; al volver, desaparece', () => {
    render(<ConexionBanner />);
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status')).toHaveTextContent(/sin conexión/i);

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
