import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ImageIcon } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { ErrorInline } from '@shared/components/ErrorCarga';

/**
 * Inicio del miembro (modelo SALA "Clases de hoy"): carrusel de los estudios con
 * su foto, capacidad y tipo de contenido; cada uno lleva a su detalle. Un fallo
 * al cargar se dice (no se muestra como "sin estudios").
 */
interface EstudioMini {
  id: string;
  slug: string;
  nombre: string;
  foto_url: string | null;
  capacidad_personas: number | null;
  tipo_contenido: string[] | null;
}

export function detalleEstudio(e: Pick<EstudioMini, 'capacidad_personas' | 'tipo_contenido'>): string {
  const tipo = (e.tipo_contenido ?? []).find(Boolean) ?? null;
  const cap = e.capacidad_personas ? `Hasta ${e.capacidad_personas} ${e.capacidad_personas === 1 ? 'persona' : 'personas'}` : null;
  return [tipo, cap].filter(Boolean).join(' · ');
}

export function EstudiosHoy() {
  const tenant = useTenant();
  const [estudios, setEstudios] = useState<EstudioMini[] | null>(null);
  const [error, setError] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setError(false);
      const { data, error: e } = await supabase
        .from('recursos')
        .select('id, slug, nombre, foto_url, capacidad_personas, tipo_contenido')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('nombre');
      if (!vivo) return;
      if (e) {
        console.error('[EstudiosHoy]', e);
        setError(true);
        return;
      }
      setEstudios((data ?? []) as EstudioMini[]);
    })();
    return () => { vivo = false; };
  }, [tenant.id, intento]);

  if (error) {
    return <div style={{ marginBottom: '18px' }}><ErrorInline mensaje="No pudimos cargar los estudios." onReintentar={() => setIntento((n) => n + 1)} /></div>;
  }
  if (!estudios || estudios.length === 0) return null;

  return (
    <section aria-labelledby="estudios-hoy-h">
      <div className="ek-home-estudios-h">
        <h2 id="estudios-hoy-h">Estudios para grabar</h2>
        <Link to="/app/estudios">Ver todos →</Link>
      </div>
      <div className="ek-carrusel">
        {estudios.map((e) => (
          <Link key={e.id} to={`/app/estudios/${e.slug}`} className="ek-mini-estudio">
            <div className="ek-mini-estudio-foto">
              {e.foto_url ? (
                <img src={e.foto_url} alt="" loading="lazy" decoding="async" />
              ) : (
                <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--ek-ink-faint)' }}>
                  <ImageIcon size={20} aria-hidden="true" />
                </div>
              )}
            </div>
            <div className="ek-mini-estudio-b">
              <b>{e.nombre}</b>
              {detalleEstudio(e) && <small>{detalleEstudio(e)}</small>}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
