import { Navigate } from 'react-router-dom';

export default function Signup() {
  // EKKO no permite signup público — las cuentas se crean al pagar
  // membresía (vía Stripe en la landing) o las crea admin desde el panel.
  // Si alguien navega directo a /signup, redirigir al home.
  // El archivo se mantiene para reutilizar el flow internamente más adelante.
  return <Navigate to="/" replace />;
}
