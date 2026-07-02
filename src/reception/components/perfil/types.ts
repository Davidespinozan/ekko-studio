// Tipos compartidos del perfil de miembro (recepción).

export interface MiembroPerfil {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  avatar_url: string | null;
  membresia_tier: string | null;
  status: string;
  no_shows_count: number | null;
  bloqueado_hasta: string | null;
  identidad_completa: boolean;
  contrato_firmado: boolean;
  created_at: string;
}

export interface ReservaPerfil {
  id: string;
  slot_inicio: string;
  slot_fin: string;
  status: string;
  folio: string;
  recurso_id: string;
  recurso: { nombre: string } | null;
}
