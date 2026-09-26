import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Upload, Link2, Trash2, Send, FileVideo, ExternalLink } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { useTenant } from '@shared/hooks/useTenant';
import { Spinner } from '@shared/components/Spinner';
import { formatFechaEnZona, formatHoraEnZona } from '@shared/lib/timezone';
import {
  listarMaterialDeReserva,
  subirArchivo,
  registrarEnlace,
  eliminarMaterial,
  avisarMaterial,
  formatTamano,
  diasRestantes,
  MAX_MB_SUBIDA_DIRECTA,
  type Material
} from '@shared/lib/material';

interface Props {
  reserva: { id: string; usuario_id: string; slot_inicio: string; folio: string | null; recurso_nombre: string };
  miembroNombre: string;
  onClose: () => void;
}

/**
 * Material de UNA sesión, para el equipo del estudio (admin y recepción): subir
 * archivos o pegar enlaces, retirarlos, y avisarle al miembro cuando esté todo.
 *
 * El aviso es un botón aparte, a propósito: se suben varios archivos y el miembro
 * recibe UN aviso (app + correo), no uno por archivo.
 */
export function MaterialReservaModal({ reserva, miembroNombre, onClose }: Props) {
  const toast = useToast();
  const tenant = useTenant();
  const diasDefault = Number((tenant.config as { material?: { dias_disponible?: unknown } } | null)?.material?.dias_disponible);
  const inputArchivo = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<Material[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [modo, setModo] = useState<'archivo' | 'enlace'>('archivo');
  const [titulo, setTitulo] = useState('');
  const [url, setUrl] = useState('');
  const [dias, setDias] = useState<number>(Number.isFinite(diasDefault) ? diasDefault : 30);
  const [ocupado, setOcupado] = useState<null | 'subiendo' | 'avisando' | string>(null);
  const [huboCambios, setHuboCambios] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setItems(await listarMaterialDeReserva(reserva.id));
      setErrorCarga(false);
    } catch {
      setErrorCarga(true);
    }
  }, [reserva.id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function conArchivo(archivo: File) {
    setOcupado('subiendo');
    try {
      await subirArchivo({
        tenantId: tenant.id,
        usuarioId: reserva.usuario_id,
        reservaId: reserva.id,
        archivo,
        titulo: titulo.trim() || archivo.name,
        diasDisponible: dias
      });
      toast.success('Archivo subido.');
      setTitulo('');
      setHuboCambios(true);
      await cargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo subir el archivo.', 9000);
    } finally {
      setOcupado(null);
      if (inputArchivo.current) inputArchivo.current.value = '';
    }
  }

  async function agregarEnlace() {
    if (!/^https:\/\/\S+$/i.test(url.trim())) {
      toast.error('El enlace debe empezar con https://');
      return;
    }
    if (!titulo.trim()) {
      toast.error('Ponle un título para que el miembro sepa qué es.');
      return;
    }
    setOcupado('subiendo');
    try {
      await registrarEnlace({ reservaId: reserva.id, titulo: titulo.trim(), url, diasDisponible: dias });
      toast.success('Enlace agregado.');
      setTitulo('');
      setUrl('');
      setHuboCambios(true);
      await cargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo agregar el enlace.');
    } finally {
      setOcupado(null);
    }
  }

  async function retirar(m: Material) {
    if (!window.confirm(`¿Retirar "${m.titulo}"? El miembro dejará de verlo y el archivo se borra.`)) return;
    setOcupado(m.id);
    try {
      await eliminarMaterial(m.id);
      await cargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo retirar.');
    } finally {
      setOcupado(null);
    }
  }

  async function avisar() {
    setOcupado('avisando');
    try {
      const r = await avisarMaterial(reserva.id);
      toast.success(r.yaAvisado ? 'Ya se le había avisado hace un momento.' : `Listo: ${miembroNombre} recibe el aviso en la app y por correo.`);
      setHuboCambios(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo enviar el aviso.');
    } finally {
      setOcupado(null);
    }
  }

  const fecha = `${formatFechaEnZona(reserva.slot_inicio, { weekday: 'short', day: 'numeric', month: 'short' })} · ${formatHoraEnZona(reserva.slot_inicio)}`;

  return (
    <div className="ek-backdrop" onClick={() => !ocupado && onClose()} role="dialog" aria-modal="true" aria-label="Material de la sesión">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '520px', width: '100%', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', padding: 0 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 18px 0' }}>
          <div>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <FileVideo size={14} aria-hidden="true" /> MATERIAL DE LA SESIÓN
            </p>
            <p style={{ fontSize: '14px', fontWeight: 600, margin: '6px 0 0' }}>{miembroNombre}</p>
            <p className="ek-body-faint" style={{ margin: '2px 0 0' }}>
              {reserva.recurso_nombre} · {fecha}{reserva.folio ? ` · ${reserva.folio}` : ''}
            </p>
          </div>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose} disabled={!!ocupado}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '14px 18px', flex: 1, minHeight: 0 }}>
          {errorCarga ? (
            <p role="alert" style={{ fontSize: '13px', color: 'var(--ek-danger)' }}>
              No se pudo cargar el material.{' '}
              <button type="button" className="adm-link" onClick={() => void cargar()}>Reintentar</button>
            </p>
          ) : items === null ? (
            <div className="ek-skeleton" style={{ height: '60px', borderRadius: 'var(--ek-r-sm)' }} />
          ) : items.length === 0 ? (
            <p className="ek-body-muted" style={{ fontSize: '13px' }}>Esta sesión todavía no tiene material.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {items.map((m) => {
                const resto = diasRestantes(m.disponible_hasta);
                return (
                  <li key={m.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '10px 12px', border: '0.5px solid var(--ek-line)', borderRadius: 'var(--ek-r-sm)' }}>
                    {m.tipo === 'enlace' ? <ExternalLink size={16} aria-hidden="true" /> : <FileVideo size={16} aria-hidden="true" />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.titulo}</p>
                      <p className="ek-body-faint" style={{ margin: '2px 0 0', fontSize: '12px' }}>
                        {m.tipo === 'enlace' ? 'Enlace externo' : formatTamano(m.tamano_bytes) || 'Archivo'}
                        {' · '}
                        {resto === null ? 'sin vencimiento' : resto <= 0 ? 'VENCIDO (el miembro ya no lo ve)' : `vence en ${resto} ${resto === 1 ? 'día' : 'días'}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm"
                      aria-label={`Retirar ${m.titulo}`}
                      onClick={() => void retirar(m)}
                      disabled={!!ocupado}
                    >
                      {ocupado === m.id ? <Spinner size={14} /> : <Trash2 size={15} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '16px 0' }} />

          <div className="ek-tabs" role="tablist" aria-label="Cómo agregar" style={{ marginBottom: '12px' }}>
            <button type="button" role="tab" aria-selected={modo === 'archivo'} className={`ek-tab ${modo === 'archivo' ? 'ek-tab--active' : ''}`} onClick={() => setModo('archivo')}>
              Subir archivo
            </button>
            <button type="button" role="tab" aria-selected={modo === 'enlace'} className={`ek-tab ${modo === 'enlace' ? 'ek-tab--active' : ''}`} onClick={() => setModo('enlace')}>
              Pegar enlace
            </button>
          </div>

          <label className="ek-label" style={{ display: 'block' }}>
            Título {modo === 'archivo' && <span style={{ fontWeight: 400, color: 'var(--ek-ink-faint)' }}>(opcional: si lo dejas vacío, el nombre del archivo)</span>}
            <input className="ek-input" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ej. Episodio 12 — versión final" maxLength={160} />
          </label>

          {modo === 'enlace' && (
            <label className="ek-label" style={{ display: 'block', marginTop: '10px' }}>
              Enlace (Drive, Dropbox, Frame.io…)
              <input className="ek-input" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </label>
          )}

          <label className="ek-label" style={{ display: 'block', marginTop: '10px' }}>
            Disponible durante (días)
            <input
              className="ek-input"
              type="number"
              min={0}
              max={3650}
              value={dias}
              onChange={(e) => setDias(Math.max(0, Math.min(3650, parseInt(e.target.value, 10) || 0)))}
            />
          </label>
          <p className="ek-helper-text" style={{ margin: '4px 0 12px' }}>
            0 = sin vencimiento. Al vencer, el miembro deja de verlo{modo === 'archivo' ? ' y el archivo se borra una semana después' : ''}.
          </p>

          {modo === 'archivo' ? (
            <>
              <input
                ref={inputArchivo}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void conArchivo(f);
                }}
              />
              <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={() => inputArchivo.current?.click()} disabled={!!ocupado}>
                {ocupado === 'subiendo' ? <><Spinner size={15} /> Subiendo… no cierres esta ventana</> : <><Upload size={15} aria-hidden="true" /> Elegir archivo</>}
              </button>
              <p className="ek-helper-text" style={{ margin: '6px 0 0' }}>
                Hasta {MAX_MB_SUBIDA_DIRECTA} MB por archivo. Para video más pesado, súbelo a Drive o Dropbox y usa "Pegar enlace".
              </p>
            </>
          ) : (
            <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={() => void agregarEnlace()} disabled={!!ocupado}>
              {ocupado === 'subiendo' ? <Spinner size={15} /> : <><Link2 size={15} aria-hidden="true" /> Agregar enlace</>}
            </button>
          )}
        </div>

        <div style={{ padding: '14px 18px 18px', borderTop: '0.5px solid var(--ek-line)' }}>
          <button
            type="button"
            className="ek-cta ek-cta--gold ek-cta--full"
            onClick={() => void avisar()}
            disabled={!!ocupado || !items || items.length === 0}
          >
            {ocupado === 'avisando' ? <Spinner size={16} /> : <><Send size={15} aria-hidden="true" /> Avisar a {miembroNombre.split(' ')[0]} que ya está listo</>}
          </button>
          <p className="ek-helper-text" style={{ margin: '6px 0 0', textAlign: 'center' }}>
            {huboCambios ? 'Hay material nuevo sin avisar. ' : ''}Un solo aviso (app + correo) por todo lo de esta sesión.
          </p>
        </div>
      </div>
    </div>
  );
}
