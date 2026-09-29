import { PlanChip } from '@shared/components/PlanChip';
import { VigenciaMembresia } from '@shared/components/VigenciaMembresia';
import { usePlanesActivos } from '@shared/hooks/usePlanesActivos';
import type { MembresiaVigente } from '@shared/hooks/useMembresiaVigente';
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
export function DatosOperativosCard({
  miembro,
  membresia
}: {
  miembro: MiembroPerfil;
  /** La que cargó la ficha (misma fuente que la tarjeta de membresía). */
  membresia?: MembresiaVigente | null;
}) {
  const st = statusMiembro(miembro.status);
  const { planes, error: errorPlanes } = usePlanesActivos();
  // Solo mostramos el plan si sigue ACTIVO (no los tiers eliminados tipo pro/basica).
  const planVigente = miembro.membresia_tier && planes.some((p) => p.slug === miembro.membresia_tier);
  // PKG-02A (F12): si los planes no se pudieron leer, no se afirma "Sin plan".
  const planNoVerificable = errorPlanes && !!miembro.membresia_tier;
  return (
    <div className="ek-card" style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <Dato label="Email" valor={miembro.email} />
      {miembro.telefono && <Dato label="Teléfono" valor={miembro.telefono} />}
      <Dato
        label="Plan"
        valor={
          planVigente
            ? <PlanChip slug={miembro.membresia_tier} />
            : planNoVerificable
              ? <span style={{ color: 'var(--ek-danger)' }} title="No pudimos cargar los planes">No disponible</span>
              : <span style={{ color: 'var(--ek-ink-faint)' }}>Sin plan</span>
        }
      />
      <Dato label="Membresía" valor={<VigenciaMembresia usuarioId={miembro.id} membresia={membresia} />} />
      <Dato label="Cuenta" valor={<span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>} />
      <Dato label="Inasistencias" valor={String(miembro.no_shows_count ?? 0)} />
      <Dato label="Miembro desde" valor={fechaCorta(miembro.created_at)} />
    </div>
  );
}
