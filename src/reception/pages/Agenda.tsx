import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import VistaSemana from '@shared/components/calendario/VistaSemana';
import ReservasVistaLista from '@admin/components/ReservasVistaLista';
import DetalleReservaModal from '@admin/components/DetalleReservaModal';
import { EstudiosServicioModal } from '@shared/components/EstudiosServicioModal';

/**
 * "Agenda" de recepción (Bloque B/C) — VER reservas del estudio, read-only.
 * Reusa los componentes de calendario (VistaSemana compartido + la Lista y el
 * Detalle de admin SIN onCancelar → modo read-only). Para operar (cancelar/
 * reprogramar) recepción va al perfil del miembro, donde tiene contexto.
 *
 * Default de vista: Semana en desktop, Lista en mobile (las 7 columnas a 375px
 * son ilegibles). Se persiste la última elección.
 */

type Vista = 'semana' | 'lista';
const VISTA_KEY = 'ekko-recepcion-vista-agenda';

function vistaInicial(): Vista {
  if (typeof window === 'undefined') return 'lista';
  const saved = localStorage.getItem(VISTA_KEY);
  if (saved === 'semana' || saved === 'lista') return saved;
  return window.matchMedia('(min-width: 768px)').matches ? 'semana' : 'lista';
}

export default function Agenda() {
  const [vista, setVista] = useState<Vista>(vistaInicial);
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [estudiosOpen, setEstudiosOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(VISTA_KEY, vista);
    } catch {
      // ignore quota errors
    }
  }, [vista]);

  return (
    <div className="rec-main">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: '18px',
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <div>
          <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '4px' }}>
            AGENDA
          </p>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              margin: 0,
              color: 'var(--ek-ink)'
            }}
          >
            Reservas del estudio
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            onClick={() => setEstudiosOpen(true)}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '44px', padding: '0 14px', fontSize: '13px' }}
            title="Marcar estudios fuera de servicio"
          >
            <Wrench size={15} aria-hidden="true" /> Estudios
          </button>
          <VistaToggle value={vista} onChange={setVista} />
        </div>
      </div>

      {vista === 'semana' ? (
        <VistaSemana
          refreshTick={0}
          onVerDetalle={setDetalleId}
          vistaCompactaCta={{ label: 'Cambiar a Lista', onClick: () => setVista('lista') }}
        />
      ) : (
        <ReservasVistaLista refreshTick={0} onVerDetalle={setDetalleId} />
      )}

      <DetalleReservaModal reservaId={detalleId} onClose={() => setDetalleId(null)} />

      {estudiosOpen && <EstudiosServicioModal onClose={() => setEstudiosOpen(false)} />}
    </div>
  );
}

function VistaToggle({ value, onChange }: { value: Vista; onChange: (v: Vista) => void }) {
  const opciones: { vista: Vista; label: string }[] = [
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
      {opciones.map((o) => {
        const activa = value === o.vista;
        return (
          <button
            key={o.vista}
            type="button"
            onClick={() => onChange(o.vista)}
            aria-pressed={activa}
            style={{
              minHeight: '44px',
              padding: '8px 18px',
              fontSize: '13px',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              background: activa ? 'var(--ek-mustard)' : 'transparent',
              color: activa ? 'var(--ek-bg)' : 'var(--ek-ink-muted)',
              transition: 'background 0.18s ease, color 0.18s ease'
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
