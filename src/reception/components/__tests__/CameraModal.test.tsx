import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CameraModal } from '../CameraModal';

// @zxing/browser: el reader no debe romper; nunca llega a decodificar
// porque getUserMedia rechaza en estos tests.
vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    decodeFromVideoElement = vi.fn().mockResolvedValue(undefined);
  }
}));

describe('CameraModal · permiso de cámara rechazado', () => {
  const getUserMedia = vi.fn();

  beforeEach(() => {
    getUserMedia.mockReset();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('muestra retry + salida a manual cuando se rechaza el permiso', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));

    render(<CameraModal onClose={vi.fn()} onScan={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/no pudimos acceder a la cámara/i)).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /usar check-in manual/i })).toBeInTheDocument();
  });

  it('"Reintentar" vuelve a pedir acceso a la cámara', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));

    render(<CameraModal onClose={vi.fn()} onScan={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument()
    );

    const llamadasAntes = getUserMedia.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));

    await waitFor(() =>
      expect(getUserMedia.mock.calls.length).toBeGreaterThan(llamadasAntes)
    );
  });

  it('"Usar check-in manual" cierra el modal', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const onClose = vi.fn();

    render(<CameraModal onClose={onClose} onScan={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /usar check-in manual/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /usar check-in manual/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
