import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * PKG-06C (FR-24) · /signup solo PIDE el alta: no pide contraseña, no inicia
 * sesión, manda nombre/correo/plan/aceptación a `alta-publica` y muestra el texto
 * neutro del servidor. Un error sin `seguro` en 5xx nunca se muestra crudo.
 */

const h = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    auth: { signInWithPassword: h.signIn, signUp: h.signUp },
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.maybeSingle = () =>
        Promise.resolve({
          data: { slug: 'esencial', nombre: 'Esencial', precio_centavos: 85000, beneficios: [], tipo: 'mensual', clases_incluidas: null, duracion_dias: null },
          error: null
        });
      return c;
    }
  }
}));

import Signup from '../Signup';

const fetchMock = vi.fn();
const NEUTRO = 'Si el correo puede usarse para una cuenta nueva, te enviamos un enlace…';

function respuesta(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

async function abrir() {
  render(
    <MemoryRouter initialEntries={['/signup?tier=esencial']}>
      <Routes>
        <Route path="/signup" element={<Signup />} />
        <Route path="/" element={<p>landing</p>} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByLabelText('Nombre completo');
}

function llenar(email = 'ana@ekko.mx') {
  fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: '  Ana Núñez ' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Confirmar email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Signup · PKG-06C', () => {
  it('no pide contraseña: el formulario solo tiene nombre, correo, confirmación y términos', async () => {
    await abrir();
    expect(screen.queryByLabelText(/contraseña/i)).toBeNull();
  });

  it('manda solo nombre/correo/plan/acepto a alta-publica, no inicia sesión y muestra el texto neutro', async () => {
    fetchMock.mockReturnValue(respuesta(202, { ok: true, mensaje: NEUTRO }));
    await abrir();
    llenar();
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi cuenta' }));
    expect(await screen.findByText(NEUTRO)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/.netlify/functions/alta-publica');
    expect(JSON.parse(init.body)).toEqual({ nombre: 'Ana Núñez', email: 'ana@ekko.mx', tier: 'esencial', acepto: true });
    expect(h.signIn).not.toHaveBeenCalled();
    expect(h.signUp).not.toHaveBeenCalled();
  });

  it('reenviar se habilita al minuto y vuelve a pedir el mismo alta', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockReturnValue(respuesta(202, { ok: true, mensaje: NEUTRO }));
    await abrir();
    llenar();
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi cuenta' }));
    const espera = await screen.findByRole('button', { name: 'Podrás pedir otro enlace en un minuto' });
    expect((espera as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    const reenviar = await screen.findByRole('button', { name: 'Enviar el enlace de nuevo' });
    fireEvent.click(reenviar);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body).email).toBe('ana@ekko.mx');
  });

  it('429 / 4xx muestran el texto escrito a mano del servidor', async () => {
    fetchMock.mockReturnValue(respuesta(429, { error: 'Recibimos demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' }));
    await abrir();
    llenar();
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi cuenta' }));
    expect(await screen.findByText('Recibimos demasiadas solicitudes. Espera unos minutos e intenta de nuevo.')).toBeTruthy();
  });

  it('5xx sin `seguro` nunca se muestra crudo; con `seguro` sí', async () => {
    fetchMock.mockReturnValue(respuesta(500, { error: 'relation "usuarios" does not exist' }));
    await abrir();
    llenar();
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi cuenta' }));
    expect(await screen.findByText('No pudimos procesar tu registro. Intenta de nuevo.')).toBeTruthy();
    expect(screen.queryByText(/relation/)).toBeNull();
    fetchMock.mockReturnValue(respuesta(503, { error: 'No pudimos enviarte el correo de confirmación en este momento.', seguro: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi cuenta' }));
    expect(await screen.findByText('No pudimos enviarte el correo de confirmación en este momento.')).toBeTruthy();
  });

  it('validación local: correos distintos o sin términos no llaman al servidor', async () => {
    await abrir();
    llenar();
    fireEvent.change(screen.getByLabelText('Confirmar email'), { target: { value: 'otro@ekko.mx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi cuenta' }));
    expect(await screen.findByText('Los emails no coinciden. Verifica que estén iguales.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
