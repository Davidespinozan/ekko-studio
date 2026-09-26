import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * FichaIdentidadModal (Fase 1 identidad): si la ficha actual no carga, NO se
 * puede guardar (antes un formulario vacío borraba la ficha); se envía solo lo
 * que cambió; un contrato ya firmado no se reenvía ni se puede desmarcar.
 */

const h = vi.hoisted(() => ({ get: vi.fn(), guardar: vi.fn() }));
vi.mock('../../lib/fichaIdentidad', () => ({
  getFichaIdentidad: (...a: unknown[]) => h.get(...a),
  guardarFichaIdentidad: (...a: unknown[]) => h.guardar(...a)
}));
vi.mock('../../lib/accionesMiembro', () => ({ imagenABase64Jpeg: vi.fn() }));

import { FichaIdentidadModal } from '../FichaIdentidadModal';

const FICHA = {
  fecha_nacimiento: '1990-05-05',
  domicilio: 'Calle 1',
  ine_folio: 'ABC123',
  ine_foto_url: null,
  tiene_foto: true,
  identidad_completa: false,
  contrato_firmado: false
};

function montar() {
  return render(
    <ToastProvider>
      <FichaIdentidadModal miembroId="m1" miembroNombre="Ana" tieneFoto onClose={vi.fn()} onGuardada={vi.fn()} />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guardar.mockResolvedValue({ success: true, identidad_completa: true, contrato_firmado: false, cambios: [] });
});

describe('FichaIdentidadModal', () => {
  it('si la carga falla no hay botón de guardar, se explica y se puede reintentar; nada se envía', async () => {
    h.get.mockRejectedValueOnce(new Error('red caída')).mockResolvedValueOnce(FICHA);
    montar();
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se puede guardar/i);
    expect(screen.queryByRole('button', { name: /guardar ficha/i })).not.toBeInTheDocument();
    expect(h.guardar).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));
    expect(await screen.findByRole('button', { name: /guardar ficha/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Calle 1')).toBeInTheDocument();
  });

  it('envía SOLO lo que cambió (PATCH), nunca los campos intactos', async () => {
    h.get.mockResolvedValue(FICHA);
    montar();
    const domicilio = await screen.findByDisplayValue('Calle 1');
    fireEvent.change(domicilio, { target: { value: 'Calle 2' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar ficha/i }));
    await waitFor(() => expect(h.guardar).toHaveBeenCalledTimes(1));
    expect(h.guardar.mock.calls[0][0]).toEqual({ usuario_id: 'm1', domicilio: 'Calle 2' });
  });

  it('vaciar un campo NO lo manda (se conserva en el servidor)', async () => {
    h.get.mockResolvedValue(FICHA);
    montar();
    const folio = await screen.findByDisplayValue('ABC123');
    fireEvent.change(folio, { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('Calle 1'), { target: { value: 'Calle 9' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar ficha/i }));
    await waitFor(() => expect(h.guardar).toHaveBeenCalledTimes(1));
    expect(h.guardar.mock.calls[0][0]).toEqual({ usuario_id: 'm1', domicilio: 'Calle 9' });
  });

  it('sin cambios no llama al servidor', async () => {
    h.get.mockResolvedValue(FICHA);
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /guardar ficha/i }));
    await waitFor(() => expect(screen.getByText(/no hay cambios/i)).toBeInTheDocument());
    expect(h.guardar).not.toHaveBeenCalled();
  });

  it('contrato ya firmado: checkbox bloqueado y no se reenvía; firmar por primera vez sí se manda', async () => {
    h.get.mockResolvedValue({ ...FICHA, contrato_firmado: true });
    montar();
    const check = await screen.findByLabelText(/firmó el contrato/i);
    expect(check).toBeChecked();
    expect(check).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue('Calle 1'), { target: { value: 'Calle 2' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar ficha/i }));
    await waitFor(() => expect(h.guardar).toHaveBeenCalledTimes(1));
    expect(h.guardar.mock.calls[0][0]).not.toHaveProperty('contrato_firmado');
  });

  it('firmar el contrato por primera vez se envía como true', async () => {
    h.get.mockResolvedValue(FICHA);
    montar();
    fireEvent.click(await screen.findByLabelText(/firmó el contrato/i));
    fireEvent.click(screen.getByRole('button', { name: /guardar ficha/i }));
    await waitFor(() => expect(h.guardar).toHaveBeenCalledTimes(1));
    expect(h.guardar.mock.calls[0][0]).toEqual({ usuario_id: 'm1', contrato_firmado: true });
  });
});
