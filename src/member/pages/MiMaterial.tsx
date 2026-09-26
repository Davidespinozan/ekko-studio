import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, FileVideo, FolderOpen, CalendarPlus } from 'lucide-react';
import { EmptyState } from '@shared/components/EmptyState';
import { Spinner } from '@shared/components/Spinner';
import { useToast } from '@shared/hooks/useToast';
import { formatFechaEnZona, formatHoraEnZona } from '@shared/lib/timezone';
import {
  listarMiMaterial,
  agruparPorSesion,
  urlDeDescarga,
  formatTamano,
  diasRestantes,
  type MaterialConSesion
} from '@shared/lib/material';

/**
 * "Mi material" — el espacio personal del miembro con lo generado en sus sesiones
 * (solicitud de cambios del cliente, punto 5): agrupado por sesión (fecha y set),
 * con descarga y con cuántos días le quedan a cada archivo.
 *
 * Solo llega lo suyo y lo vigente: lo decide la base (RLS), no esta pantalla.
 */
export default function MiMaterial() {
  const toast = useToast();
  const [items, setItems] = useState<MaterialConSesion[] | null>(null);
  const [error, setError] = useState(false);
  const [descargando, setDescargando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setItems(await listarMiMaterial());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function descargar(m: MaterialConSesion) {
    setDescargando(m.id);
    try {
      const url = await urlDeDescarga(m);
      if (m.tipo === 'enlace') {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        // La URL firmada ya trae Content-Disposition: attachment con el nombre original.
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo descargar.');
      void cargar(); // por si acaba de vencer
    } finally {
      setDescargando(null);
    }
  }

  if (error) {
    return (
      <div className="ek-container">
        <EmptyState
          icon={FolderOpen}
          tone="danger"
          title="No se pudo cargar tu material"
          hint="Revisa tu conexión e inténtalo de nuevo."
          action={<button type="button" className="ek-cta ek-cta--secondary" onClick={() => void cargar()}>Reintentar</button>}
        />
      </div>
    );
  }

  if (items === null) {
    return (
      <div className="ek-container ek-stack-sm" style={{ marginTop: '8px' }}>
        <div className="ek-skeleton" style={{ height: '28px', width: '45%', borderRadius: 'var(--ek-r-sm)' }} />
        <div className="ek-skeleton" style={{ height: '96px', borderRadius: 'var(--ek-r-md)' }} />
        <div className="ek-skeleton" style={{ height: '96px', borderRadius: 'var(--ek-r-md)' }} />
      </div>
    );
  }

  const sesiones = agruparPorSesion(items);

  return (
    <div className="ek-container">
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginTop: '4px' }}>MI MATERIAL</p>
      <h1 className="ek-display-md" style={{ margin: '6px 0 4px' }}>Lo que grabaste en el estudio</h1>
      <p className="ek-body-muted" style={{ margin: '0 0 20px' }}>
        Cuando el estudio termine de procesar una sesión, aquí aparece para que la descargues. Te avisamos por la app y por correo.
      </p>

      {sesiones.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="Todavía no hay material"
          hint="Después de tu sesión, el estudio sube aquí tus archivos."
          action={
            <Link to="/app/reservar" className="ek-cta ek-cta--gold">
              Reservar una sesión <CalendarPlus size={16} aria-hidden="true" />
            </Link>
          }
        />
      ) : (
        <div className="ek-stack-lg">
          {sesiones.map((s) => (
            <section key={s.reservaId} aria-label={`Sesión del ${s.sesion ? formatFechaEnZona(s.sesion.slot_inicio, { day: 'numeric', month: 'long' }) : ''}`}>
              <p className="ek-day-heading" style={{ textTransform: 'none' }}>
                {s.sesion
                  ? `${formatFechaEnZona(s.sesion.slot_inicio, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${formatHoraEnZona(s.sesion.slot_inicio)}`
                  : 'Sesión'}
              </p>
              <p className="ek-body-faint" style={{ margin: '-4px 0 10px' }}>
                {s.sesion?.recurso?.nombre ?? 'Estudio'}
                {s.sesion?.folio ? <> · Folio <span style={{ fontFamily: 'var(--ek-font-mono)' }}>{s.sesion.folio}</span></> : null}
              </p>
              <div className="ek-stack-sm">
                {s.archivos.map((m) => {
                  const resto = diasRestantes(m.disponible_hasta);
                  const porVencer = resto !== null && resto <= 5;
                  return (
                    <div key={m.id} className="ek-card ek-card--md" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span className="ek-empty-icon" style={{ width: 42, height: 42, margin: 0, flexShrink: 0 }}>
                        {m.tipo === 'enlace' ? <ExternalLink size={18} aria-hidden="true" /> : <FileVideo size={18} aria-hidden="true" />}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '15px', fontWeight: 600, letterSpacing: '-0.02em', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {m.titulo}
                        </p>
                        <p className="ek-body-faint" style={{ marginTop: '2px', color: porVencer ? 'var(--ek-danger)' : undefined }}>
                          {m.tipo === 'enlace' ? 'Enlace' : formatTamano(m.tamano_bytes) || 'Archivo'}
                          {' · '}
                          {resto === null
                            ? 'Disponible sin límite'
                            : resto <= 1
                              ? 'Vence HOY: descárgalo ya'
                              : `Disponible ${resto} días más`}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="ek-cta ek-cta--gold"
                        style={{ minHeight: '40px', padding: '8px 14px', fontSize: '13px', flexShrink: 0 }}
                        onClick={() => void descargar(m)}
                        disabled={descargando === m.id}
                        aria-label={`${m.tipo === 'enlace' ? 'Abrir' : 'Descargar'} ${m.titulo}`}
                      >
                        {descargando === m.id ? (
                          <Spinner size={15} />
                        ) : m.tipo === 'enlace' ? (
                          <>Abrir <ExternalLink size={14} aria-hidden="true" /></>
                        ) : (
                          <>Descargar <Download size={14} aria-hidden="true" /></>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
