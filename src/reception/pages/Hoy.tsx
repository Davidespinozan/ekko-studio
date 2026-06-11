import { ReservasHoyView } from '../components/ReservasHoyView';

/**
 * "Hoy" — panel del día de recepción (Bloque B/C). El check-in QR vive ahora
 * en su propio tab (Checkin); acá queda lo accionable del día: ocupación,
 * llegadas, resto del día, faltantes y check-in manual.
 */
export default function Hoy() {
  return (
    <div className="rec-main">
      <ReservasHoyView />
    </div>
  );
}
