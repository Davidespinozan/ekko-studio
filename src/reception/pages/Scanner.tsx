import { useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { ScannerView } from '../components/ScannerView';
import { ReservasHoyView } from '../components/ReservasHoyView';

type TabKey = 'escanear' | 'hoy';

export default function Scanner() {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const [activeTab, setActiveTab] = useState<TabKey>('escanear');

  return (
    <div className="rec-shell">
      <header className="rec-topbar">
        <div>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-cream)' }}>RECEPCIÓN</p>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ek-cream)', marginTop: '2px' }}>
            {tenant.nombre}
          </h1>
        </div>
        <div className="rec-topbar-right">
          <span style={{ fontSize: '0.8125rem', color: 'rgba(245,241,232,0.6)' }}>
            {usuario?.nombre ?? usuario?.email}
          </span>
          <button onClick={signOut} className="rec-link-btn">Salir</button>
        </div>
      </header>

      <div className="rec-tabs">
        <button
          onClick={() => setActiveTab('escanear')}
          className={`rec-tab ${activeTab === 'escanear' ? 'rec-tab--active' : ''}`}
        >
          Escanear QR
        </button>
        <button
          onClick={() => setActiveTab('hoy')}
          className={`rec-tab ${activeTab === 'hoy' ? 'rec-tab--active' : ''}`}
        >
          Hoy
        </button>
      </div>

      <div className="rec-main">
        {activeTab === 'escanear' && (
          <ScannerView onSwitchToHoy={() => setActiveTab('hoy')} />
        )}
        {activeTab === 'hoy' && <ReservasHoyView />}
      </div>
    </div>
  );
}
