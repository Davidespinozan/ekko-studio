import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * Recepción Plus: el perfil de recepción ahora es un panel de GESTIÓN del
 * front-desk (foto, datos, credenciales, desbloqueo, reservas), no una vista
 * read-only. Este test cubre que se muestran los datos, las acciones de
 * cuenta y que "Crear reserva" respeta el status del miembro.
 */

const hoisted = vi.hoisted(() => ({
  miembro: {} as Record<string, unknown>,
  reservas: [] as Record<string, unknown>[],
  audit: [] as Record<string, unknown>[],
  membresia: null as Record<string, unknown> | null,
  membresiaError: null as unknown,
  reservasError: null as unknown
}));

const RESERVA_PROXIMA = {
  id: 'res-1',
  slot_inicio: '2030-01-01T10:00:00.000Z',
  slot_fin: '2030-01-01T11:00:00.000Z',
  status: 'confirmada',
  folio: 'EKK-000001',
  recurso_id: 'rec-1',
  recurso: { nombre: 'Estudio A' }
};

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'usuarios') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: hoisted.miembro, error: null })
            })
          })
        };
      }
      if (table === 'membresias') {
        // useMembresiaVigente: select().eq().in().order().limit().maybeSingle()
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
        c.maybeSingle = () => Promise.resolve({ data: hoisted.membresiaError ? null : hoisted.membresia, error: hoisted.membresiaError });
        return c;
      }
      if (table === 'audit_log') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: hoisted.audit, error: null })
                })
              })
            })
          })
        };
      }
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve(hoisted.reservasError ? { data: null, error: hoisted.reservasError } : { data: hoisted.reservas, error: null })
            })
          })
        })
      };
    })
  }
}));

import PerfilMiembroRecepcion from '../PerfilMiembroRecepcion';

function renderPerfil() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/recepcion/miembros/m-1']}>
        <Routes>
          <Route path="/recepcion/miembros/:id" element={<PerfilMiembroRecepcion />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('PerfilMiembroRecepcion · gestión front-desk', () => {
  beforeEach(() => {
    hoisted.miembro = {
      id: 'm-1',
      nombre: 'ana lópez',
      email: 'ana@cravia.mx',
      telefono: '6661234567',
      avatar_url: null,
      membresia_tier: 'pro',
      status: 'activo',
      no_shows_count: 0,
      bloqueado_hasta: null,
      created_at: '2026-01-10T12:00:00Z'
    };
    hoisted.reservas = [];
    hoisted.audit = [];
    hoisted.membresia = null;
    hoisted.membresiaError = null;
    hoisted.reservasError = null;
  });

  it('muestra los datos del miembro', async () => {
    renderPerfil();
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
    expect(screen.getByText('ana@cravia.mx')).toBeInTheDocument();
  });

  it('ofrece las acciones de cuenta del front-desk', async () => {
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /editar datos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tomar foto/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resetear acceso/i })).toBeInTheDocument();
  });

  it('un miembro suspendido muestra la alerta de estado', async () => {
    hoisted.miembro = { ...hoisted.miembro, status: 'suspendido' };
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getAllByText(/suspendido/i).length).toBeGreaterThan(0);
  });

  it('miembro bloqueado: ofrece "Desbloquear ahora"', async () => {
    hoisted.miembro = { ...hoisted.miembro, bloqueado_hasta: '2099-01-01T00:00:00Z' };
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /desbloquear/i })).toBeInTheDocument();
  });

  it('miembro activo: "Crear reserva" habilitado', async () => {
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /crear reserva/i })).not.toBeDisabled();
  });

  it('miembro no-activo: "Crear reserva" deshabilitado', async () => {
    hoisted.miembro = { ...hoisted.miembro, status: 'suspendido' };
    renderPerfil();
    await screen.findByText('Ana López');
    expect(screen.getByRole('button', { name: /crear reserva/i })).toBeDisabled();
  });

  it('miembro activo: acción "Reprogramar" habilitada', async () => {
    hoisted.reservas = [RESERVA_PROXIMA];
    renderPerfil();
    await screen.findByText('Ana López');
    expect(await screen.findByRole('button', { name: /reprogramar/i })).not.toBeDisabled();
  });

  /**
   * La ficha decide por el estado de la MEMBRESÍA, no por `usuarios.status`. Antes:
   * un miembro en pausa veía "Activar membresía" (→ segunda membresía) y a uno
   * activo al que se le acabó el paquete no se le ofrecía nada.
   */
  describe('tarjeta de membresía', () => {
    const futuro = '2099-01-01T00:00:00Z';
    const paquete = {
      id: 'mem-1', status: 'activa', periodo_actual_fin: futuro, creditos_restantes: 5,
      stripe_subscription_id: null, cancel_at_period_end: false, created_at: '2026-01-01T00:00:00Z',
      tier: { slug: 'pro-pack', nombre: 'Pro-pack', tipo: 'hibrido' }
    };
    const tarjeta = async () => within(await screen.findByTestId('membresia-card'));

    it('PKG-02A · la consulta de membresía FALLA → "No pudimos cargar la membresía"; ni "SIN MEMBRESÍA" ni "Asignar plan"', async () => {
      hoisted.membresiaError = { message: 'permission denied for table membresias' };
      vi.spyOn(console, 'error').mockImplementation(() => {});
      renderPerfil();
      const t = await tarjeta();
      expect(t.getByText('No pudimos cargar la membresía.')).toBeInTheDocument();
      expect(t.queryByText('SIN MEMBRESÍA')).not.toBeInTheDocument();
      expect(t.queryByRole('button', { name: /asignar plan/i })).not.toBeInTheDocument();
      expect(t.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/permission denied/);
    });

    it('sin membresía (aunque la cuenta esté "activo") → ofrece "Asignar plan"', async () => {
      renderPerfil();
      const t = await tarjeta();
      expect(t.getByText('SIN MEMBRESÍA')).toBeInTheDocument();
      expect(t.getByRole('button', { name: /asignar plan/i })).toBeInTheDocument();
    });

    it('paquete SIN créditos con la cuenta activa → "Renovar"', async () => {
      hoisted.membresia = { ...paquete, creditos_restantes: 0 };
      renderPerfil();
      const t = await tarjeta();
      expect(t.getByText('SIN CRÉDITOS')).toBeInTheDocument();
      expect(t.getByRole('button', { name: /^renovar$/i })).toBeInTheDocument();
    });

    it('EN PAUSA (cuenta suspendida por la pausa) → "Reanudar", nunca "Asignar/Activar", y sin alarma de cuenta suspendida', async () => {
      hoisted.miembro = { ...hoisted.miembro, status: 'suspendido' };
      hoisted.membresia = { ...paquete, status: 'pausada' };
      renderPerfil();
      const t = await tarjeta();
      expect(t.getByText('EN PAUSA')).toBeInTheDocument();
      expect(t.getByRole('button', { name: /reanudar membresía/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /asignar plan|activar membres/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/Cuenta: Suspendido/)).not.toBeInTheDocument();
    });

    it('suspendido por la administración (sin pausa) → sí muestra el aviso de cuenta', async () => {
      hoisted.miembro = { ...hoisted.miembro, status: 'suspendido' };
      hoisted.membresia = paquete;
      renderPerfil();
      expect(await screen.findByText(/Cuenta: Suspendido/)).toBeInTheDocument();
    });

    it('paquete vigente → cambiar, pausar, ajustar créditos y dar de baja; muestra el saldo', async () => {
      hoisted.membresia = paquete;
      renderPerfil();
      const t = await tarjeta();
      expect(t.getByText(/5 créditos/)).toBeInTheDocument();
      for (const nombre of [/cambiar plan/i, /^pausar$/i, /ajustar créditos/i, /dar de baja/i]) {
        expect(t.getByRole('button', { name: nombre })).toBeInTheDocument();
      }
    });

    it('"Ajustar créditos" abre el modal con el saldo actual', async () => {
      hoisted.membresia = paquete;
      renderPerfil();
      fireEvent.click((await tarjeta()).getByRole('button', { name: /ajustar créditos/i }));
      const modal = within(await screen.findByRole('dialog', { name: /ajustar créditos/i }));
      expect(modal.getByText(/Saldo: 5 → 6/)).toBeInTheDocument();
    });

    it('"Dar de baja" sin suscripción de Stripe explica que la baja es inmediata y avisa de los créditos', async () => {
      hoisted.membresia = paquete;
      renderPerfil();
      fireEvent.click((await tarjeta()).getByRole('button', { name: /dar de baja/i }));
      const modal = within(await screen.findByRole('dialog', { name: /dar de baja/i }));
      expect(modal.getByText(/la baja es inmediata/i)).toBeInTheDocument();
      expect(modal.getByRole('alert')).toHaveTextContent(/5 créditos/);
    });
  });
});

// ── PKG-02A (C02 · F19) ───────────────────────────────────────────────────────
describe('PerfilMiembroRecepcion · reservas en error (PKG-02A)', () => {
  beforeEach(() => {
    hoisted.miembro = {
      id: 'm-1', nombre: 'ana lópez', email: 'ana@cravia.mx', telefono: null, avatar_url: null, membresia_tier: 'pro',
      status: 'activo', no_shows_count: 0, bloqueado_hasta: null, created_at: '2026-01-10T12:00:00Z'
    };
    hoisted.reservas = [];
    hoisted.audit = [];
    hoisted.membresia = null;
    hoisted.membresiaError = null;
    hoisted.reservasError = null;
  });

  it('reservas en ERROR → "No pudimos cargar las reservas del miembro."; ni "Sin reservas próximas" ni "Sin reservas anteriores"; la membresía sigue mostrándose', async () => {
    hoisted.reservasError = { message: 'permission denied for table reservas' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPerfil();
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
    expect(await screen.findByText('No pudimos cargar las reservas del miembro.')).toBeInTheDocument();
    expect(screen.queryByText('Sin reservas próximas.')).not.toBeInTheDocument();
    expect(screen.queryByText('Sin reservas anteriores.')).not.toBeInTheDocument();
    expect(screen.getByText('Historial no disponible.')).toBeInTheDocument();
    // La tarjeta de membresía (F03) es independiente: sin membresía real → "SIN MEMBRESÍA".
    expect(await screen.findByTestId('membresia-card')).toHaveTextContent('SIN MEMBRESÍA');
    expect(document.body.textContent).not.toMatch(/permission denied/);
  });

  it('reservas OK vacías → "Sin reservas próximas." (vacío real)', async () => {
    renderPerfil();
    expect(await screen.findByText('Sin reservas próximas.')).toBeInTheDocument();
  });
});
