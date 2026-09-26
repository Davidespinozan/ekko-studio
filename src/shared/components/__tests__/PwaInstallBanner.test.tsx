import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PwaInstallBanner, { debeMostrarse, rutaAdmiteBanner } from '../PwaInstallBanner';

/**
 * Banner de instalación PWA: es una INVITACIÓN y no puede estorbar. Aparece
 * cuando el navegador ofrece instalar (beforeinstallprompt), pero solo en la
 * landing y en el inicio del miembro, solo en pantallas de teléfono, tras unos
 * segundos, y por debajo de cualquier modal. Un descarte dura 90 días.
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

function montar(ruta = '/') {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <PwaInstallBanner />
    </MemoryRouter>
  );
}
const pasarRetraso = () => act(() => { vi.advanceTimersByTime(4100); });
const ancho = (px: number) => Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mockMatchMedia(false);
  ancho(390);
  // Forzar rama no-iOS
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Linux; Android 14) Chrome/120', configurable: true
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PwaInstallBanner', () => {
  it('no muestra nada sin beforeinstallprompt', () => {
    montar();
    pasarRetraso();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('no salta encima de la primera impresión: espera unos segundos', () => {
    montar();
    fireBeforeInstallPrompt();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    pasarRetraso();
    expect(screen.getByText(/instala ekko en tu teléfono/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Instalar' })).toBeInTheDocument();
  });

  it('queda POR DEBAJO de los modales (backdrop = z 100) y, en /app, por encima de la barra de navegación', () => {
    montar('/app');
    fireBeforeInstallPrompt();
    pasarRetraso();
    const banner = screen.getByRole('dialog');
    expect(Number(banner.style.zIndex)).toBeLessThan(100);
    expect(banner.style.bottom).toContain('96px');
  });

  it.each(['/login', '/signup', '/app/reservar', '/app/perfil', '/admin', '/recepcion'])(
    'no aparece en %s (antes salía en todas partes, también sobre el pago)',
    (ruta) => {
      montar(ruta);
      fireBeforeInstallPrompt();
      pasarRetraso();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
  );

  it('no aparece en pantallas de escritorio', () => {
    ancho(1440);
    montar();
    fireBeforeInstallPrompt();
    pasarRetraso();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('al descartar guarda CUÁNDO (no un "1" eterno) y no reaparece', () => {
    const { unmount } = montar();
    fireBeforeInstallPrompt();
    pasarRetraso();
    act(() => { screen.getByRole('button', { name: /ahora no/i }).click(); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(Number(localStorage.getItem('ekko:pwa-install-dismissed'))).toBeGreaterThan(1_000_000_000_000);
    unmount();

    montar();
    fireBeforeInstallPrompt();
    pasarRetraso();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('no aparece si la app ya está instalada (standalone)', () => {
    mockMatchMedia(true);
    montar();
    fireBeforeInstallPrompt();
    pasarRetraso();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('debeMostrarse', () => {
  const base = { pathname: '/', anchoPantalla: 390, instalada: false, descartadoEn: null as string | null };
  const DIA = 86_400_000;
  const AHORA = 1_790_000_000_000;

  it('landing e inicio del miembro: sí', () => {
    expect(rutaAdmiteBanner('/')).toBe(true);
    expect(rutaAdmiteBanner('/app')).toBe(true);
    expect(rutaAdmiteBanner('/app/reservar')).toBe(false);
    expect(debeMostrarse(base)).toBe(true);
  });

  it('descartado hace 10 días → no; hace 91 → vuelve a invitar', () => {
    expect(debeMostrarse({ ...base, descartadoEn: String(AHORA - 10 * DIA), ahora: AHORA })).toBe(false);
    expect(debeMostrarse({ ...base, descartadoEn: String(AHORA - 91 * DIA), ahora: AHORA })).toBe(true);
  });

  it('descarte en el formato viejo ("1", sin fecha): se respeta', () => {
    expect(debeMostrarse({ ...base, descartadoEn: '1', ahora: AHORA })).toBe(false);
  });
});
