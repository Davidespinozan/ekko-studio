import { Pencil, Camera, KeyRound, Send, IdCard } from 'lucide-react';

/** Acciones de cuenta (Recepción Plus): foto, datos, ficha/INE, credenciales, aviso. */
export function AccionesCuenta({
  tieneFoto,
  onEditar,
  onFoto,
  onFicha,
  onReset,
  onAviso
}: {
  tieneFoto: boolean;
  onEditar: () => void;
  onFoto: () => void;
  onFicha: () => void;
  onReset: () => void;
  onAviso: () => void;
}) {
  return (
    <section style={{ marginBottom: '20px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>ACCIONES DE CUENTA</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={onEditar}>
          <Pencil size={15} aria-hidden="true" /> Editar datos
        </button>
        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={onFoto}>
          <Camera size={15} aria-hidden="true" /> {tieneFoto ? 'Cambiar foto' : 'Tomar foto'}
        </button>
        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={onFicha}>
          <IdCard size={15} aria-hidden="true" /> Ficha / INE
        </button>
        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={onReset}>
          <KeyRound size={15} aria-hidden="true" /> Resetear acceso
        </button>
        <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={onAviso}>
          <Send size={15} aria-hidden="true" /> Enviar aviso
        </button>
      </div>
    </section>
  );
}
