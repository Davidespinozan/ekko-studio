import { useEffect, useRef, useState } from 'react';
import { X, Upload, ShieldCheck } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { imagenABase64Jpeg } from '../lib/accionesMiembro';
import { getFichaIdentidad, guardarFichaIdentidad } from '../lib/fichaIdentidad';

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
 */
export function FichaIdentidadModal({ miembroId, miembroNombre, tieneFoto, onClose, onGuardada }: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);

  const [fechaNac, setFechaNac] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [ineFolio, setIneFolio] = useState('');
  const [contrato, setContrato] = useState(false);
  const [ineUrl, setIneUrl] = useState<string | null>(null);
  const [ineNueva, setIneNueva] = useState<{ base64: string; contentType: string; preview: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    getFichaIdentidad(miembroId)
      .then((f) => {
        if (!mounted) return;
        setFechaNac(f.fecha_nacimiento ?? '');
        setDomicilio(f.domicilio ?? '');
        setIneFolio(f.ine_folio ?? '');
        setContrato(f.contrato_firmado);
        setIneUrl(f.ine_foto_url);
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'No se pudo cargar la ficha.'))
      .finally(() => mounted && setCargando(false));
    return () => { mounted = false; };
  }, [miembroId, toast]);

  async function onArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Elegí una imagen de la INE.');
      return;
    }
    const { base64, contentType } = await imagenABase64Jpeg(file);
    setIneNueva({ base64, contentType, preview: `data:${contentType};base64,${base64}` });
  }

  async function guardar() {
    setGuardando(true);
    try {
      const res = await guardarFichaIdentidad({
        usuario_id: miembroId,
        fecha_nacimiento: fechaNac || null,
        domicilio: domicilio || null,
        ine_folio: ineFolio || null,
        contrato_firmado: contrato,
        ine_foto: ineNueva ? { base64: ineNueva.base64, contentType: ineNueva.contentType } : undefined
      });
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

  return (
    <div className="ek-backdrop" onClick={() => !guardando && onClose()} role="dialog" aria-modal="true">
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

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '4px 0 18px', fontSize: '13px', cursor: 'pointer' }}>
              <input type="checkbox" checked={contrato} onChange={(e) => setContrato(e.target.checked)} style={{ marginTop: '2px' }} />
              <span>El miembro <strong>firmó el contrato</strong> de uso y responsabilidad por el equipo.</span>
            </label>

            <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={guardar} disabled={guardando}>
              {guardando ? <Spinner size={16} /> : <><ShieldCheck size={16} aria-hidden="true" /> Guardar ficha</>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
