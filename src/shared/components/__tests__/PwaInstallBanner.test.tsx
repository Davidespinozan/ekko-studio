import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import PwaInstallBanner from '../PwaInstallBanner';

/**
 * Banner de instalación PWA: aparece cuando el navegador ofrece instalar
 * (evento beforeinstallprompt), NO aparece si ya se descartó, y al descartarlo
 * recuerda la decisión en localStorage.
 */

function mockMatchMedia(standalone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: standalone && query.includes('standalone'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  });
}

function fireBeforeInstallPrompt() {
  const e = new Event('beforeinstallprompt') as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  e.prompt = vi.fn().mockResolvedValue(undefined);
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  act(() => { window.dispatchEvent(e); });
  return e;
}

beforeEach(() => {
  localStorage.clear();
  mockMatchMedia(false);
  // Forzar rama no-iOS
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', configurable: true
  });
});
afterEach(() => cleanup());

describe('PwaInstallBanner', () => {
  it('no muestra nada sin beforeinstallprompt', () => {
    render(<PwaInstallBanner />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('aparece al beforeinstallprompt y ofrece instalar', () => {
    render(<PwaInstallBanner />);
    fireBeforeInstallPrompt();
    expect(screen.getByText(/instalá ekko en tu teléfono/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Instalar' })).toBeInTheDocument();
  });

  it('al descartar recuerda la decisión (no reaparece)', () => {
    const { unmount } = render(<PwaInstallBanner />);
    fireBeforeInstallPrompt();
    act(() => { screen.getByRole('button', { name: /ahora no/i }).click(); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem('ekko:pwa-install-dismissed')).toBe('1');
    unmount();

    // Nuevo montaje: aunque llegue el evento, ya no aparece.
    render(<PwaInstallBanner />);
    fireBeforeInstallPrompt();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('no aparece si la app ya está instalada (standalone)', () => {
    mockMatchMedia(true);
    render(<PwaInstallBanner />);
    fireBeforeInstallPrompt();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
