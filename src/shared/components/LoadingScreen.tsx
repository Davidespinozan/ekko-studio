/**
 * Pantalla de carga (como en SALA): el isotipo de EKKO con un anillo mostaza que
 * le da la vuelta. Mismas clases que el splash de index.html (public/loader.css),
 * así el primer paint y las cargas de rutas/guards se ven iguales. Fija a toda
 * la ventana; respeta prefers-reduced-motion desde la hoja.
 */
export const LOGO_LOADER = '/icons/icon-192.png';

export function LoadingScreen({ label = 'Cargando…' }: { label?: string } = {}) {
  return (
    <div className="ek-loader" role="status" aria-live="polite" aria-label={label}>
      <div className="ek-loader-mark">
        <div className="ek-loader-ring" aria-hidden="true" />
        <img className="ek-loader-logo" src={LOGO_LOADER} alt="" width={52} height={52} />
      </div>
      <p className="ek-loader-label">{label}</p>
    </div>
  );
}
