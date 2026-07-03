import { PlanChip } from '@shared/components/PlanChip';
import { statusMiembro } from '../../lib/miembroStatus';
import { fechaCorta } from './perfilUtils';
import type { MiembroPerfil } from './types';

function Dato({ label, valor }: { label: string; valor: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
      <span style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13px', color: 'var(--ek-ink)', textAlign: 'right' }}>{valor}</span>
    </div>
  );
}

/** Datos operativos del miembro (email, plan, estado, inasistencias…). */
export function DatosOperativosCard({ miembro }: { miembro: MiembroPerfil }) {
  const st = statusMiembro(miembro.status);
  return (
    <div className="ek-card" style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <Dato label="Email" valor={miembro.email} />
      {miembro.telefono && <Dato label="Teléfono" valor={miembro.telefono} />}
      <Dato
        label="Plan"
        valor={<PlanChip slug={miembro.membresia_tier} />}
      />
      <Dato label="Estado" valor={<span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>} />
      <Dato label="Inasistencias" valor={String(miembro.no_shows_count ?? 0)} />
      <Dato label="Miembro desde" valor={fechaCorta(miembro.created_at)} />
    </div>
  );
}
