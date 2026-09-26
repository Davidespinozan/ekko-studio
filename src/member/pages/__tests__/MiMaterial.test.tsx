import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@shared/providers/ToastProvider';
import type { MaterialConSesion } from '@shared/lib/material';

const h = vi.hoisted(() => ({
  lista: [] as unknown[],
  falla: false,
  url: vi.fn()
}));

vi.mock('@shared/lib/material', async (orig) => ({
  ...(await orig<typeof import('@shared/lib/material')>()),
  listarMiMaterial: () => (h.falla ? Promise.reject(new Error('x')) : Promise.resolve(h.lista)),
  urlDeDescarga: (...a: unknown[]) => h.url(...a)
}));

import MiMaterial from '../MiMaterial';

const enDias = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const item = (o: Partial<MaterialConSesion>): MaterialConSesion => ({
  id: 'm1', reserva_id: 'r1', tipo: 'archivo', titulo: 'Episodio 12', storage_path: 't/u/r1/x.mp4', url_externa: null,
  nombre_archivo: 'ep12.mp4', tamano_bytes: 320 * 1024 ** 2, mime: 'video/mp4', disponible_hasta: enDias(20), created_at: '2026-09-10T00:00:00Z',
  reserva: { slot_inicio: '2026-09-09T00:00:00.000Z', folio: 'EKK-000123', recurso: { nombre: 'Set Podcast' } },
  ...o
});

const montar = () => render(<ToastProvider><MemoryRouter><MiMaterial /></MemoryRouter></ToastProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  h.lista = [];
  h.falla = false;
  h.url.mockResolvedValue('https://storage.test/firmada');
});

describe('MiMaterial', () => {
  it('sin material: lo explica e invita a reservar', async () => {
    montar();
    expect(await screen.findByText('Todavía no hay material')).toBeInTheDocument();
  });

  it('identifica el material por SESIÓN: fecha y hora del estudio, set y folio', async () => {
    h.lista = [item({})];
    montar();
    // 2026-09-09T00:00Z = martes 8 de septiembre, 17:00 en Mazatlán.
    expect(await screen.findByText(/martes, 8 de septiembre de 2026 · 17:00/i)).toBeInTheDocument();
    expect(screen.getByText(/Set Podcast/)).toBeInTheDocument();
    expect(screen.getByText('EKK-000123')).toBeInTheDocument();
    expect(screen.getByText(/320 MB · Disponible 20 días más/)).toBeInTheDocument();
  });

  it('agrupa varios archivos de la misma sesión y separa las sesiones', async () => {
    h.lista = [
      item({ id: 'a', titulo: 'Video final' }),
      item({ id: 'b', titulo: 'Audio WAV' }),
      item({ id: 'c', reserva_id: 'r2', titulo: 'Otra sesión', reserva: { slot_inicio: '2026-08-01T00:00:00Z', folio: 'EKK-000099', recurso: { nombre: 'Set Black' } } })
    ];
    montar();
    await screen.findByText('Video final');
    const sesiones = screen.getAllByRole('region');
    expect(sesiones).toHaveLength(2);
    expect(within(sesiones[0]).getByText('Audio WAV')).toBeInTheDocument();
    expect(within(sesiones[1]).getByText('Otra sesión')).toBeInTheDocument();
  });

  it('avisa cuando está por vencer', async () => {
    h.lista = [item({ disponible_hasta: enDias(0.5) })];
    montar();
    expect(await screen.findByText(/Vence HOY: descárgalo ya/)).toBeInTheDocument();
  });

  it('Descargar pide la URL firmada de ESE archivo', async () => {
    h.lista = [item({})];
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Descargar Episodio 12' }));
    await waitFor(() => expect(h.url).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', storage_path: 't/u/r1/x.mp4' })));
  });

  it('un ENLACE se abre en otra pestaña, sin pasar por Storage', async () => {
    const abrir = vi.spyOn(window, 'open').mockReturnValue(null);
    h.url.mockResolvedValue('https://drive.google.com/x');
    h.lista = [item({ tipo: 'enlace', storage_path: null, url_externa: 'https://drive.google.com/x', tamano_bytes: null, titulo: 'Material en bruto' })];
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir Material en bruto' }));
    await waitFor(() => expect(abrir).toHaveBeenCalledWith('https://drive.google.com/x', '_blank', 'noopener,noreferrer'));
  });

  it('si la descarga falla (p. ej. acaba de vencer) lo dice, y no se queda colgado', async () => {
    h.url.mockRejectedValue(new Error('No se pudo preparar la descarga. Puede que el material haya vencido.'));
    h.lista = [item({})];
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Descargar Episodio 12' }));
    expect(await screen.findByText(/Puede que el material haya vencido/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar Episodio 12' })).not.toBeDisabled();
  });

  it('falló la carga ≠ "no hay material": ofrece reintentar', async () => {
    h.falla = true;
    montar();
    expect(await screen.findByText('No se pudo cargar tu material')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });
});
