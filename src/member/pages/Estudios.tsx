import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowRight, ImageIcon } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { ErrorCarga } from '@shared/components/ErrorCarga';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export default function Estudios() {
  const tenant = useTenant();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorCarga, setErrorCarga] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('nombre');

      if (!mounted) return;
      if (error) {
        console.error('[Estudios]', error);
        // PKG-02A: estado de error explícito (antes: toast + cuadrícula vacía).
        setErrorCarga(true);
      } else {
        setErrorCarga(false);
        setRecursos(data ?? []);
      }
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id, intento]);

  if (isLoading) {
    return (
      <div className="ek-container">
        <div className="ek-skeleton" style={{ height: '400px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  if (errorCarga) {
    return (
      <div className="ek-container">
        <ErrorCarga titulo="No pudimos cargar los estudios." onReintentar={() => setIntento((n) => n + 1)} />
      </div>
    );
  }

  return (
    <div className="ek-container">
      <p className="ek-kicker" style={{ marginBottom: '6px' }}>
        Nuestros espacios · {recursos.length} {recursos.length === 1 ? 'estudio' : 'estudios'}
      </p>
      <p className="ek-body-muted" style={{ margin: '0 0 18px' }}>
        Espacios profesionales diseñados para creadores. Cada uno con su personalidad.
      </p>

      <div className="ek-estudios-grid">
        {recursos.map((r) => {
          const tipos = (r.tipo_contenido ?? []).filter(Boolean);
          const meta = [
            r.capacidad_personas ? `Hasta ${r.capacidad_personas} ${r.capacidad_personas === 1 ? 'persona' : 'personas'}` : null,
            tipos[0] ?? null
          ].filter(Boolean).join(' · ');
          return (
            <Link key={r.id} to={`/app/estudios/${r.slug}`} className="ek-estudio-tarjeta" aria-label={`${r.nombre}: ver detalle`}>
              {r.foto_url ? (
                <img src={r.foto_url} alt="" loading="lazy" decoding="async" />
              ) : (
                <div className="ek-estudio-tarjeta-sin">
                  <ImageIcon size={26} strokeWidth={1.5} aria-hidden="true" />
                  <span>Foto próximamente</span>
                </div>
              )}
              <div className="ek-estudio-tarjeta-scrim" aria-hidden="true" />
              {(r.costo_creditos ?? 1) >= 2 && <span className="ek-estudio-tarjeta-pro">PRO</span>}
              <div className="ek-estudio-tarjeta-body">
                <div style={{ minWidth: 0 }}>
                  <h3>{r.nombre}</h3>
                  {meta && <p className="ek-estudio-tarjeta-meta">{meta}</p>}
                </div>
                <span className="ek-estudio-tarjeta-ir" aria-hidden="true"><ArrowRight size={18} /></span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
