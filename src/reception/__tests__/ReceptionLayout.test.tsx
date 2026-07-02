import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Bloque B/C: la navegación de recepción es un bottom-nav de 4 ítems
 * (Hoy · Agenda · Miembros · Check-in). Default = Hoy. Deep-link a
 * /recepcion/miembros/:id sigue funcionando.
 */

vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({
    authUser: { id: 'auth-1' },
    usuario: { rol: 'recepcionista', nombre: 'Recep Uno', email: 'recep@cravia.mx' },
    isLoading: false,
    signOut: vi.fn()
  })
}));
vi.mock('@shared/components/DemoBanner', () => ({ DemoBanner: () => null }));
vi.mock('@shared/components/BrandLogo', () => ({ BrandLogo: () => null }));

// Stubs de las páginas lazy — el test solo cubre routing + nav.
vi.mock('../pages/Hoy', () => ({ default: () => <div>HOY_STUB</div> }));
vi.mock('../pages/Agenda', () => ({ default: () => <div>AGENDA_STUB</div> }));
vi.mock('../pages/BuscarMiembro', () => ({ default: () => <div>BUSCAR_STUB</div> }));
vi.mock('../pages/PerfilMiembroRecepcion', () => ({ default: () => <div>PERFIL_STUB</div> }));
vi.mock('../pages/Checkin', () => ({ default: () => <div>CHECKIN_STUB</div> }));

import ReceptionLayout from '../ReceptionLayout';

function renderEn(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <Routes>
        <Route path="/recepcion/*" element={<ReceptionLayout />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ReceptionLayout · bottom-nav 4 ítems', () => {
  it('muestra los 4 ítems del bottom-nav', async () => {
    renderEn('/recepcion');
    const nav = await screen.findByRole('navigation', { name: /navegación de recepción/i });
    expect(nav).toBeInTheDocument();
    // Scopeado al nav: el header ahora también muestra el título de sección.
    const enNav = within(nav);
    expect(enNav.getByText('Hoy')).toBeInTheDocument();
    expect(enNav.getByText('Agenda')).toBeInTheDocument();
    expect(enNav.getByText('Miembros')).toBeInTheDocument();
    expect(enNav.getByText('Check-in')).toBeInTheDocument();
  });

  it('ruta default (/recepcion) = Hoy', async () => {
    renderEn('/recepcion');
    expect(await screen.findByText('HOY_STUB')).toBeInTheDocument();
  });

  it('/recepcion/agenda = Agenda', async () => {
    renderEn('/recepcion/agenda');
    expect(await screen.findByText('AGENDA_STUB')).toBeInTheDocument();
  });

  it('/recepcion/checkin = Check-in', async () => {
    renderEn('/recepcion/checkin');
    expect(await screen.findByText('CHECKIN_STUB')).toBeInTheDocument();
  });

  it('deep-link /recepcion/miembros/:id sigue funcionando (Perfil)', async () => {
    renderEn('/recepcion/miembros/m-123');
    expect(await screen.findByText('PERFIL_STUB')).toBeInTheDocument();
  });
});
