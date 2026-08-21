import { useEffect, useState } from 'react';
import { Cake } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';

interface Cumple {
  usuario_id: string;
  nombre: string | null;
  avatar_url: string | null;
  dia: string;
  en_dias: number;
}

function cuando(enDias: number): string {
  if (enDias === 0) return 'Hoy';
  if (enDias === 1) return 'Mañana';
  return `En ${enDias} días`;
}

/**
 * Cumpleañeros de hoy y de la semana (RPC cumpleanos_proximos, acotado al
 * tenant y a staff). El dato ya existe (ficha de identidad); es la acción de
 * retención más barata: recepción felicita en persona, el cron manda el push.
 * Se oculta si no hay nadie. (SALA 8442a85.)
 */
export function CumpleanosCard({ dias = 7, compacto = false }: { dias?: number; compacto?: boolean }) {
  const [items, setItems] = useState<Cumple[] | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('cumpleanos_proximos', { p_dias: dias });
        if (!mounted) return;
        if (error) {
          console.error('[CumpleanosCard]', error);
          setItems([]);
          return;
        }
        setItems((data ?? []) as Cumple[]);
      } catch (e) {
        if (!mounted) return;
        console.error('[CumpleanosCard]', e instanceof Error ? e.message : e);
        setItems([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [dias]);

  if (!items || items.length === 0) return null;

  return (
    <div className="ek-card" data-testid="cumpleanos-card" style={{ marginBottom: compacto ? '12px' : '20px', padding: compacto ? '12px 14px' : undefined }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <Cake size={14} aria-hidden="true" /> CUMPLEAÑOS
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {items.map((c) => (
          <li key={c.usuario_id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
            <span style={{ fontWeight: c.en_dias === 0 ? 700 : 500 }}>{c.nombre ?? 'Miembro'}</span>
            <span style={{ color: c.en_dias === 0 ? 'var(--ek-mustard)' : 'var(--ek-ink-muted)', fontWeight: c.en_dias === 0 ? 700 : 400 }}>
              {cuando(c.en_dias)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
