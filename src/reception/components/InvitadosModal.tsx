import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Camera, Upload, RefreshCw, Check, SwitchCamera, Trash2, UserPlus, User } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { imagenABase64Jpeg } from '../lib/accionesMiembro';
import { listarInvitados, agregarInvitado, quitarInvitado, type Invitado, type InvitadosResp } from '../lib/invitados';

interface Props {
  reservaId: string;
  miembroNombre: string;
  onClose: () => void;
  onCambio?: (total: number) => void;
}

type Captura = { base64: string; contentType: string; preview: string };

function pesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

/**
 * Invitados de una reserva (recepción): registra nombre + foto de cada invitado.
 * Marca los que van arriba del tope del plan como "extra" (recepción los cobra
 * en caja) y muestra el total a cobrar. Pasa todo por reception-invitados.
 */
export function InvitadosModal({ reservaId, miembroNombre, onClose, onCambio }: Props) {
  const toast = useToast();
  const [data, setData] = useState<InvitadosResp | null>(null);
  const [cargando, setCargando] = useState(true);
  const [modo, setModo] = useState<'lista' | 'agregar'>('lista');

  const aplicar = useCallback((resp: InvitadosResp) => {
    setData(resp);
    onCambio?.(resp.total);
  }, [onCambio]);

  useEffect(() => {
    let vivo = true;
    listarInvitados(reservaId)
      .then((r) => { if (vivo) aplicar(r); })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'No se pudieron cargar los invitados.'))
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [reservaId, aplicar, toast]);

  async function quitar(inv: Invitado) {
    try {
      aplicar(await quitarInvitado(reservaId, inv.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo quitar el invitado.');
    }
  }

  const extras = data?.extras ?? 0;
  const precioExtra = data?.precio_invitado_extra_centavos ?? 0;
  const totalCobrar = extras * precioExtra;

  return (
    <div className="ek-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '460px', width: '100%', maxHeight: '88vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
          <div>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '2px' }}>INVITADOS</p>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>Reserva de {miembroNombre}</p>
          </div>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {cargando ? (
          <Spinner label="Cargando invitados…" />
        ) : modo === 'agregar' ? (
          <FormularioAgregar
            reservaId={reservaId}
            onCancelar={() => setModo('lista')}
            onAgregado={(resp) => { aplicar(resp); setModo('lista'); }}
          />
        ) : (
          <>
            {/* Resumen: incluidos vs extras a cobrar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', color: 'var(--ek-ink-muted)' }}>
                <strong style={{ color: 'var(--ek-ink)' }}>{data?.total ?? 0}</strong> registrados · {data?.max_incluidos ?? 0} incluidos en el plan
              </span>
              {extras > 0 && (
                <span className="ek-badge" style={{ background: 'var(--ek-mustard-soft)', color: 'var(--ek-mustard)', fontWeight: 700, fontSize: '12px', padding: '4px 10px' }}>
                  {extras} extra{extras > 1 ? 's' : ''}{precioExtra > 0 ? ` · cobra ${pesos(totalCobrar)}` : ''}
                </span>
              )}
            </div>

            {(data?.invitados.length ?? 0) === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--ek-ink-faint)', margin: '4px 0 16px' }}>
                Aún no hay invitados registrados. Agrega cada uno con su nombre y foto.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                {data!.invitados.map((inv) => (
                  <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 10px', background: 'var(--ek-bg-soft)', border: '0.5px solid var(--ek-line)', borderRadius: 'var(--ek-r-sm)' }}>
                    <span style={{ width: '40px', height: '40px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: 'var(--ek-bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ek-ink-faint)' }}>
                      {inv.foto_url ? (
                        <img src={inv.foto_url} alt={inv.nombre} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <User size={18} aria-hidden="true" />
                      )}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: '14px', color: 'var(--ek-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {inv.nombre}
                      {inv.es_extra && <span style={{ color: 'var(--ek-mustard)', fontSize: '11px', fontWeight: 700, marginLeft: '8px' }}>EXTRA</span>}
                    </span>
                    <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label={`Quitar a ${inv.nombre}`} onClick={() => quitar(inv)}>
                      <Trash2 size={16} aria-hidden="true" style={{ color: 'var(--ek-danger)' }} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={() => setModo('agregar')}>
              <UserPlus size={16} aria-hidden="true" /> Agregar invitado
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Sub-formulario: nombre + foto (cámara o archivo) → agrega el invitado. */
function FormularioAgregar({
  reservaId,
  onCancelar,
  onAgregado
}: {
  reservaId: string;
  onCancelar: () => void;
  onAgregado: (resp: InvitadosResp) => void;
}) {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [nombre, setNombre] = useState('');
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [camError, setCamError] = useState(false);
  const [captura, setCaptura] = useState<Captura | null>(null);
  const [guardando, setGuardando] = useState(false);

  const detener = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const iniciarCamara = useCallback(async (modo: 'user' | 'environment') => {
    detener();
    setCamError(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: modo }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      setCamError(true);
    }
  }, [detener]);

  useEffect(() => {
    if (!captura) void iniciarCamara(facing);
    return detener;
  }, [facing, captura, iniciarCamara, detener]);

  async function capturar() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const { base64, contentType } = await imagenABase64Jpeg(v);
    setCaptura({ base64, contentType, preview: `data:${contentType};base64,${base64}` });
    detener();
  }

  async function onArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Elige un archivo de imagen.'); return; }
    const { base64, contentType } = await imagenABase64Jpeg(file);
    setCaptura({ base64, contentType, preview: `data:${contentType};base64,${base64}` });
    detener();
  }

  async function guardar() {
    const n = nombre.trim();
    if (n.length < 2) { toast.error('Escribe el nombre del invitado.'); return; }
    setGuardando(true);
    try {
      const resp = await agregarInvitado(reservaId, n, captura ? { base64: captura.base64, contentType: captura.contentType } : undefined);
      toast.success('Invitado agregado.');
      onAgregado(resp);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo agregar el invitado.');
      setGuardando(false);
    }
  }

  return (
    <div>
      <div className="ek-form-field" style={{ marginBottom: '12px' }}>
        <label className="ek-label">Nombre del invitado</label>
        <input className="ek-input" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre y apellido" autoFocus />
      </div>

      <div style={{ position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 'var(--ek-r-md)', overflow: 'hidden', background: '#000', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {captura ? (
          <img src={captura.preview} alt="Vista previa" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : camError ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--ek-ink-muted)' }}>
            <Camera size={28} aria-hidden="true" style={{ marginBottom: '8px', opacity: 0.6 }} />
            <p style={{ fontSize: '13px', margin: 0 }}>No se pudo abrir la cámara. Sube un archivo.</p>
          </div>
        ) : (
          <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        {!captura && !camError && (
          <button type="button" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))} className="ek-media-ctrl" aria-label="Voltear cámara" style={{ position: 'absolute', top: '10px', right: '10px', width: '40px', height: '40px' }}>
            <SwitchCamera size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      <input ref={fileRef} type="file" accept="image/*" onChange={onArchivo} style={{ display: 'none' }} />

      {captura ? (
        <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={() => setCaptura(null)} disabled={guardando}>
            <RefreshCw size={16} aria-hidden="true" /> Repetir
          </button>
          <button type="button" className="ek-cta ek-cta--gold" style={{ flex: 1 }} onClick={guardar} disabled={guardando}>
            {guardando ? <Spinner size={16} /> : <><Check size={16} aria-hidden="true" /> Agregar</>}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={() => fileRef.current?.click()}>
            <Upload size={16} aria-hidden="true" /> Archivo
          </button>
          {!camError && (
            <button type="button" className="ek-cta ek-cta--gold" style={{ flex: 1 }} onClick={capturar}>
              <Camera size={16} aria-hidden="true" /> Capturar
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px' }}>
        <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={onCancelar} disabled={guardando}>
          Volver
        </button>
        {!captura && (
          <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={guardar} disabled={guardando}>
            {guardando ? <Spinner size={16} /> : 'Agregar sin foto'}
          </button>
        )}
      </div>
    </div>
  );
}
