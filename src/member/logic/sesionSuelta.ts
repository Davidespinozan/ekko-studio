/**
 * "Pago por hora" en un solo flujo (solicitud del cliente, punto 2).
 *
 * EKKO no vende horas sueltas como tal: vende PAQUETES de créditos, y el más chico
 * ("Sesión suelta", 1 crédito) es, en la práctica, la hora suelta. Antes eran dos
 * pasos desconectados: Perfil → comprar el paquete → volver a Reservar → elegir
 * la hora. Aquí se elige la hora primero y, si no alcanza el saldo, se ofrece
 * comprar el paquete justo ahí; al acreditarse, se reserva sola.
 */

export interface PlanCandidato {
  slug: string;
  nombre: string;
  precio_centavos: number;
  tipo: string | null;
  clases_incluidas: number | null;
  activo: boolean;
  en_venta: boolean | null;
}

export interface RecursoParaSesion {
  costo_creditos: number | null;
  tiers_permitidos: string[];
}

/**
 * El paquete más barato que, sumado al saldo actual, alcanza para ESTE estudio y
 * que el estudio acepta. `null` = no hay forma de pagar por hora aquí (p. ej. el
 * estudio cuesta 2 créditos y solo existe un paquete de 1; o es solo para
 * mensuales).
 */
export function elegirPaquetePorHora(
  tiers: PlanCandidato[],
  recurso: RecursoParaSesion,
  saldoActual: number
): PlanCandidato | null {
  const costo = Math.max(1, recurso.costo_creditos ?? 1);
  const abierto = recurso.tiers_permitidos.length === 0;
  return (
    tiers
      .filter((t) => t.activo && t.en_venta !== false)
      .filter((t) => t.tipo === 'creditos' || t.tipo === 'hibrido')
      .filter((t) => (t.clases_incluidas ?? 0) + saldoActual >= costo)
      .filter((t) => abierto || recurso.tiers_permitidos.includes(t.slug))
      .sort((a, b) => a.precio_centavos - b.precio_centavos)[0] ?? null
  );
}
