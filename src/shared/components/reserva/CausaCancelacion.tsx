import { useReglaCancelacion, puedeCancelarReserva } from '@member/hooks/useReglaCancelacion';

/**
 * R2-B (PKG-01Q) · Quién causó la cancelación cuando la ejecuta el equipo.
 * El servidor EXIGE la causa (`cancelar_reserva_atomic(p_causa)`) y decide el
 * crédito; este selector solo la pide y explica la consecuencia con la misma
 * ventana (config del estudio) y la misma frontera (faltan N horas o menos = tarde).
 */
export type CausaCancelacion = 'miembro' | 'estudio';

interface Props {
  value: CausaCancelacion | null;
  onChange: (c: CausaCancelacion) => void;
  slotInicio: string;
  disabled?: boolean;
}

export function consecuenciaCancelacion(causa: CausaCancelacion, tardia: boolean, horas: number): string {
  if (causa === 'estudio') {
    return 'El crédito de la sesión se devuelve. Si la membresía del miembro ya terminó, queda una revisión en Cobros.';
  }
  return tardia
    ? `Faltan ${horas} horas o menos: es una cancelación tardía. Si pagó con crédito, NO se le devuelve.`
    : `Faltan más de ${horas} horas: es una cancelación a tiempo. Si pagó con crédito, se le devuelve.`;
}

export function CausaCancelacionSelector({ value, onChange, slotInicio, disabled }: Props) {
  const { cancelacionMinHorasAntes } = useReglaCancelacion();
  const tardia = !puedeCancelarReserva(slotInicio, cancelacionMinHorasAntes).puede;

  const opciones: { causa: CausaCancelacion; titulo: string }[] = [
    { causa: 'miembro', titulo: 'La pidió el miembro' },
    { causa: 'estudio', titulo: 'La cancela el estudio' }
  ];

  return (
    <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }} disabled={disabled}>
      <legend className="ek-label" style={{ marginBottom: '8px' }}>¿Quién cancela?</legend>
      <div style={{ display: 'grid', gap: '8px' }}>
        {opciones.map((o) => {
          const activa = value === o.causa;
          return (
            <label
              key={o.causa}
              style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
                padding: '10px 12px',
                borderRadius: 'var(--ek-r-md)',
                border: `0.5px solid ${activa ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                background: activa ? 'var(--ek-bg-elevated)' : 'transparent',
                cursor: disabled ? 'default' : 'pointer'
              }}
            >
              <input
                type="radio"
                name="causa-cancelacion"
                value={o.causa}
                checked={activa}
                onChange={() => onChange(o.causa)}
                style={{ marginTop: '3px' }}
              />
              <span>
                <span style={{ display: 'block', fontSize: '14px', fontWeight: 600, color: 'var(--ek-ink)' }}>{o.titulo}</span>
                <span style={{ display: 'block', fontSize: '12px', color: 'var(--ek-ink-muted)', lineHeight: 1.45, marginTop: '2px' }}>
                  {consecuenciaCancelacion(o.causa, tardia, cancelacionMinHorasAntes)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '8px 0 0', lineHeight: 1.45 }}>
        Si la reserva tiene invitados extra pagados, se abre una revisión en Cobros: no hay reembolso automático.
      </p>
    </fieldset>
  );
}
