import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Upload, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { imagenABase64Jpeg } from '../lib/accionesMiembro';
import { getFichaIdentidad, guardarFichaIdentidad, type FichaIdentidad, type GuardarFichaInput } from '../lib/fichaIdentidad';

interface Props {
  miembroId: string;
  miembroNombre: string;
  tieneFoto: boolean;
  onClose: () => void;
  onGuardada: () => void;
}

/**
 * Ficha de identidad (expediente): fecha de nacimiento, domicilio, INE (foto) y
 * firma de contrato. Sin foto + estos datos, el check-in queda bloqueado.
 *
 * Fase 1 de identidad (2026-09-25):
 *  · Si la ficha actual NO se pudo cargar, no se puede guardar: un formulario
 *    vacío no es "el estado real" y antes borraba la ficha entera.
 *  · Se envía SOLO lo que cambió (PATCH). Un campo vacío no se manda: el
 *    servidor conserva lo capturado. Borrar un dato no se hace desde aquí.
 *  · Un contrato ya firmado se muestra como firmado y no se reenvía: la fecha
 *    de firma es un evento histórico.
 */
export function FichaIdentidadModal({ miembroId, miembroNombre, tieneFoto, onClose, onGuardada }: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [original, setOriginal] = useState<FichaIdentidad | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [fechaNac, setFechaNac] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [ineFolio, setIneFolio] = useState('');
  const [contrato, setContrato] = useState(false);
  const [ineUrl, setIneUrl] = useState<string | null>(null);
  const [ineNueva, setIneNueva] = useState<{ base64: string; contentType: string; preview: string } | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);
    try {
      const f = await getFichaIdentidad(miembroId);
      setOriginal(f);
      setFechaNac(f.fecha_nacimiento ?? '');
      setDomicilio(f.domicilio ?? '');
      setIneFolio(f.ine_folio ?? '');
      setContrato(f.contrato_firmado);
      setIneUrl(f.ine_foto_url);
    } catch (e) {
      setOriginal(null);
      setErrorCarga(e instanceof Error ? e.message : 'No se pudo cargar la ficha.');
    } finally {
      setCargando(false);
    }
  }, [miembroId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function onArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Elige una imagen de la INE.');
      return;
    }
    const { base64, contentType } = await imagenABase64Jpeg(file);
    setIneNueva({ base64, contentType, preview: `data:${contentType};base64,${base64}` });
  }

  /** Solo lo que cambió respecto a lo cargado; lo vacío no se manda. */
  function armarCambios(base: FichaIdentidad): GuardarFichaInput {
    const input: GuardarFichaInput = { usuario_id: miembroId };
    const f = fechaNac.trim();
    const d = domicilio.trim();
    const i = ineFolio.trim();
    if (f && f !== (base.fecha_nacimiento ?? '')) input.fecha_nacimiento = f;
    if (d && d !== (base.domicilio ?? '')) input.domicilio = d;
    if (i && i !== (base.ine_folio ?? '')) input.ine_folio = i;
    if (contrato && !base.contrato_firmado) input.contrato_firmado = true;
    if (ineNueva) input.ine_foto = { base64: ineNueva.base64, contentType: ineNueva.contentType };
    return input;
  }

  async function guardar() {
    if (!original) return; // sin ficha cargada no hay contra qué comparar
    const input = armarCambios(original);
    if (Object.keys(input).length === 1) {
      toast.info('No hay cambios que guardar.');
      return;
    }
    setGuardando(true);
    try {
      const res = await guardarFichaIdentidad(input);
      if (res.identidad_completa && res.contrato_firmado) {
        toast.success('Ficha completa. El miembro ya puede ingresar.');
      } else {
        toast.info('Ficha guardada. Aún falta algo para habilitar el ingreso.');
      }
      onGuardada();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar la ficha.');
      setGuardando(false);
    }
  }

  const inePreview = ineNueva?.preview ?? ineUrl;
  const contratoYaFirmado = original?.contrato_firmado === true;

  return (
    <div className="ek-backdrop" role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '460px', width: '100%', maxHeight: '90vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">FICHA DE IDENTIDAD · {miembroNombre.toUpperCase()}</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="ek-body-muted" style={{ marginTop: 0, marginBottom: '16px', fontSize: '12.5px' }}>
          Necesario para dar ingreso. Datos sensibles: solo los ve el estudio.
        </p>

        {cargando ? (
          <Spinner label="Cargando ficha…" />
        ) : errorCarga || !original ? (
          <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p className="ek-helper-text" style={{ color: 'var(--ek-danger)', margin: 0, display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>
                No se pudo cargar la ficha actual ({errorCarga ?? 'sin datos'}). Para no pisar lo ya capturado, no se puede guardar hasta cargarla.
              </span>
            </p>
            <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={() => void cargar()}>
              Reintentar
            </button>
          </div>
        ) : (
          <>
            {!tieneFoto && (
              <p className="ek-helper-text" style={{ color: 'var(--ek-warning)', marginTop: 0, marginBottom: '12px' }}>
                Falta la foto del miembro. Tomala con el botón “Foto” del perfil.
              </p>
            )}

            <label className="ek-label" style={{ display: 'block', marginBottom: '12px' }}>
              Fecha de nacimiento
              <input type="date" value={fechaNac} onChange={(e) => setFechaNac(e.target.value)} className="ek-input" />
            </label>

            <label className="ek-label" style={{ display: 'block', marginBottom: '12px' }}>
              Domicilio
              <textarea value={domicilio} onChange={(e) => setDomicilio(e.target.value)} rows={2} className="ek-input" style={{ resize: 'vertical' }} />
            </label>

            <label className="ek-label" style={{ display: 'block', marginBottom: '12px' }}>
              Clave de elector / folio de la INE
              <input value={ineFolio} onChange={(e) => setIneFolio(e.target.value)} className="ek-input" />
            </label>

            <div className="ek-label" style={{ marginBottom: '12px' }}>
              Foto de la INE
              <div style={{ marginTop: '6px' }}>
                {inePreview && (
                  <img
                    src={inePreview}
                    alt="INE"
                    style={{ width: '100%', maxHeight: '180px', objectFit: 'contain', borderRadius: 'var(--ek-r-sm)', background: '#000', marginBottom: '8px' }}
                  />
                )}
                <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onArchivo} style={{ display: 'none' }} />
                <button type="button" className="ek-cta ek-cta--secondary" style={{ width: '100%' }} onClick={() => fileRef.current?.click()}>
                  <Upload size={16} aria-hidden="true" /> {inePreview ? 'Cambiar foto de INE' : 'Tomar/subir foto de INE'}
                </button>
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '4px 0 6px', fontSize: '13px', cursor: contratoYaFirmado ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={contrato}
                disabled={contratoYaFirmado}
                onChange={(e) => setContrato(e.target.checked)}
                style={{ marginTop: '2px' }}
                aria-label="El miembro firmó el contrato"
              />
              <span>
                El miembro <strong>firmó el contrato</strong> de uso y responsabilidad por el equipo.
                {contratoYaFirmado && <> <span className="ek-body-faint">(ya registrado; la firma no se quita desde aquí)</span></>}
              </span>
            </label>
            <p className="ek-body-faint" style={{ margin: '0 0 14px', fontSize: '11.5px' }}>
              Solo se guarda lo que cambies. Un campo vacío conserva lo ya capturado.
            </p>

            <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={guardar} disabled={guardando}>
              {guardando ? <Spinner size={16} /> : <><ShieldCheck size={16} aria-hidden="true" /> Guardar ficha</>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
