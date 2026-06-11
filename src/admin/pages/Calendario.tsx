import { useEffect, useState } from 'react';
import DetalleReservaModal from '../components/DetalleReservaModal';
import CancelarReservaModal, {
  type ReservaParaCancelar
} from '../components/CancelarReservaModal';
import ReservasVistaLista from '../components/ReservasVistaLista';
import VistaDia from '../components/calendario/VistaDia';
import VistaSemana from '@shared/components/calendario/VistaSemana';
import { readVista, VISTA_STORAGE_KEY, type Vista } from '../lib/calendarioVista';

export default function Calendario() {
  const [vista, setVista] = useState<Vista>(() => readVista());
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [paraCancelar, setParaCancelar] = useState<ReservaParaCancelar | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(VISTA_STORAGE_KEY, vista);
    } catch {
      // ignore
    }
  }, [vista]);

  const handleCancelado = () => {
    setRefreshTick((t) => t + 1);
  };

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: '16px',
          flexWrap: 'wrap'
        }}
      >
        <div>
          <p className="ek-eyebrow ek-eyebrow--mustard">RESERVAS</p>
          <h1 className="ek-h2">Gestiona reservas de tus miembros</h1>
        </div>
        <VistaToggle value={vista} onChange={setVista} />
      </div>

      {vista === 'dia' && (
        <VistaDia refreshTick={refreshTick} onVerDetalle={setDetalleId} />
      )}
      {vista === 'semana' && (
        <VistaSemana
          refreshTick={refreshTick}
          onVerDetalle={setDetalleId}
          vistaCompactaCta={{ label: 'Cambiar a vista Día', onClick: () => setVista('dia') }}
        />
      )}
      {vista === 'lista' && (
        <ReservasVistaLista
          refreshTick={refreshTick}
          onVerDetalle={setDetalleId}
          onCancelar={setParaCancelar}
        />
      )}

      <DetalleReservaModal
        reservaId={detalleId}
        onClose={() => setDetalleId(null)}
        onCancelar={(info) => {
          setDetalleId(null);
          setParaCancelar(info);
        }}
      />

      {paraCancelar && (
        <CancelarReservaModal
          reserva={paraCancelar}
          onClose={() => setParaCancelar(null)}
          onCancelled={() => {
            setParaCancelar(null);
            handleCancelado();
          }}
        />
      )}
    </div>
  );
}

function VistaToggle({ value, onChange }: { value: Vista; onChange: (v: Vista) => void }) {
  const baseBtn: React.CSSProperties = {
    minHeight: '44px',
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    background: 'transparent',
    color: 'var(--ek-ink-muted)',
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.18s ease, color 0.18s ease',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px'
  };
  const activeBtn: React.CSSProperties = {
    background: 'var(--ek-mustard)',
    color: 'var(--ek-bg)'
  };
  const opciones: { vista: Vista; label: string }[] = [
    { vista: 'dia', label: 'Día' },
    { vista: 'semana', label: 'Semana' },
    { vista: 'lista', label: 'Lista' }
  ];
  return (
    <div
      role="group"
      aria-label="Cambiar vista"
      style={{
        display: 'inline-flex',
        border: '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-md)',
        overflow: 'hidden'
      }}
    >
      {opciones.map((o) => (
        <button
          key={o.vista}
          type="button"
          onClick={() => onChange(o.vista)}
          aria-pressed={value === o.vista}
          style={{ ...baseBtn, ...(value === o.vista ? activeBtn : {}) }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

