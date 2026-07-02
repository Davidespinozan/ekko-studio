import { ShieldCheck, ShieldAlert } from 'lucide-react';

/** Ficha de identidad: estado del gate de ingreso (foto/INE/contrato). */
export function FichaIdentidadCard({
  identidadCompleta,
  contratoFirmado,
  onAbrir
}: {
  identidadCompleta: boolean;
  contratoFirmado: boolean;
  onAbrir: () => void;
}) {
  const habilitado = identidadCompleta && contratoFirmado;
  const falta = [
    !identidadCompleta && 'datos/foto/INE',
    !contratoFirmado && 'contrato firmado'
  ]
    .filter(Boolean)
    .join(' y ');

  return (
    <section style={{ marginBottom: '20px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>FICHA DE IDENTIDAD</p>
      <div
        className="ek-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderColor: habilitado ? undefined : 'var(--ek-warning)',
          background: habilitado ? undefined : 'var(--ek-warning-soft)'
        }}
      >
        {habilitado ? (
          <ShieldCheck size={22} style={{ color: 'var(--ek-success)', flexShrink: 0 }} aria-hidden="true" />
        ) : (
          <ShieldAlert size={22} style={{ color: 'var(--ek-warning)', flexShrink: 0 }} aria-hidden="true" />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>
            {habilitado ? 'Ingreso habilitado' : 'Ingreso bloqueado'}
          </p>
          <p className="ek-body-muted" style={{ margin: '2px 0 0', fontSize: '12.5px' }}>
            {habilitado ? 'Ficha completa y contrato firmado.' : `Falta: ${falta}.`}
          </p>
        </div>
        <button
          type="button"
          className={habilitado ? 'ek-cta ek-cta--secondary' : 'ek-cta ek-cta--gold'}
          style={{ padding: '9px 16px', fontSize: '13px', flexShrink: 0 }}
          onClick={onAbrir}
        >
          {habilitado ? 'Ver ficha' : 'Completar ficha'}
        </button>
      </div>
    </section>
  );
}
