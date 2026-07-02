import type { LucideIcon } from 'lucide-react';
import { CalendarDays, Flame, Ticket } from 'lucide-react';

// ============================================================================
// ResumenChips — fila de 3 stat-cards en el Home. Convierte el saludo suelto
// en un pequeño "panel de tu actividad". Data ya calculada en useResumenMiembro.
// ============================================================================

interface Chip {
  Icon: LucideIcon;
  valor: string;
  label: string;
}

interface Props {
  proximasCount: number;
  sesionesEsteMes: number;
  /** Créditos restantes; null si el plan no es por créditos. */
  creditosRestantes: number | null;
}

export function ResumenChips({ proximasCount, sesionesEsteMes, creditosRestantes }: Props) {
  const chips: Chip[] = [
    { Icon: CalendarDays, valor: String(proximasCount), label: proximasCount === 1 ? 'Próxima' : 'Próximas' },
    { Icon: Flame, valor: String(sesionesEsteMes), label: 'Este mes' }
  ];

  // El tercer chip depende del tipo de plan: créditos si aplica, si no nada.
  if (creditosRestantes !== null) {
    chips.push({ Icon: Ticket, valor: String(creditosRestantes), label: creditosRestantes === 1 ? 'Crédito' : 'Créditos' });
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${chips.length}, 1fr)`,
        gap: '10px',
        marginBottom: '24px'
      }}
    >
      {chips.map((c) => (
        <div key={c.label} className="ek-stat-card ek-stat-card--accent" style={{ padding: '14px 14px 16px' }}>
          <c.Icon size={16} aria-hidden="true" style={{ color: 'var(--ek-mustard)', marginBottom: '8px' }} />
          <div style={{ fontFamily: 'var(--ek-font-display)', fontSize: '26px', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' }}>
            {c.valor}
          </div>
          <div style={{ fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}
