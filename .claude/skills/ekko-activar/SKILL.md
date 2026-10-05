---
name: ekko-activar
description: Activación controlada en producción de un paquete de EKKO ya revisado — preflight, foto de producción, plan y aplicación de migraciones, verificación de base y datos, guarda de invariantes, gate, commit único, push, deploy en Netlify, verificación y cierre con estados exactos. Úsala SOLO cuando el dueño autorice explícitamente activar en producción.
---

# ekko-activar

Requiere autorización explícita del dueño para ESTA activación. Autorizar código no
autoriza activar. Cada paso de producción se verifica antes del siguiente; ante
cualquier condición de paro: detener, no improvisar, reportar el estado exacto.

## 1. Preflight (solo lectura)
- Identidad: repo EKKO, remoto `Davidespinozan/ekko-studio`, proyecto Supabase
  `cfihcrjbvgjiohedsjos`, sitio Netlify `d146aa6f-…`. Si algo no coincide, STOP.
- `git fetch`; rama `main`; HEAD = origin/main = el commit que `docs/STATUS.md`
  declara en producción. Árbol = exactamente lo revisado (inventario de
  modificados y nuevos; ningún archivo ajeno; stash intacto).
- md5 de cada migración a aplicar = el aceptado en la revisión.
- Foto de producción ANTES (skill `ekko-foto-produccion`) con el estado operativo
  del dominio. Compara con los supuestos de la revisión (p. ej. "0 reservas
  futuras"). Si el estado operativo cambió materialmente, STOP y evalúa.

## 2. Orden seguro (decídelo, no lo asumas)
Determina desde el contrato real qué puede convivir con qué:
- Migración ADITIVA y compatible con el código desplegado → base primero, luego
  deploy (el front viejo sigue funcionando sobre la base nueva).
- Migración que RETIRA una firma o cambia un contrato que el front viejo usa →
  hay una ventana de incompatibilidad; documéntala, minimízala (deploy inmediato)
  y verifica que no haya actividad afectada (p. ej. 0 reservas futuras).
- Código que necesita la base nueva → nunca desplegar antes de migrar.
Escribe el orden elegido y su justificación en el reporte ANTES de mutar.

## 3. Migrar
`supabase db push --linked --dry-run`: debe proponer SOLO las migraciones del
paquete, en orden. Cualquier otra → STOP. Luego `--yes`. Sin UPDATE manual, sin
reparar datos, sin datos artificiales, sin eventos reales de Stripe.
Si una migración falla: STOP; no aplicar las siguientes; no commitear ni desplegar.

## 4. Verificar la base
- Historial: conteo y versiones nuevas exactas.
- Estructura: funciones (SECURITY DEFINER, search_path, grants por rol), tablas,
  RLS y políticas, triggers, constraints, índices, vistas (REST sí/no), tal como se
  diseñó. Consultas de solo lectura; sin crear datos.
- Hashes: las funciones nuevas y cambiadas en producción = las de la base local
  probada; las cerradas (R1, 01A–01H, R2-A, R2-B) idénticas. Diferencia no
  prevista → STOP.
- Datos: foto DESPUÉS y `comparar`: toda tabla de negocio `OK` (columnas nuevas
  vacías se excluyen y se explica).
- Contrato aplicación ↔ base: ningún llamador usa una firma retirada; las RPC que
  el código invoca existen con esos nombres y grants.

## 5. Gate, commit, push
- Gate completo sobre el árbol exacto a commitear (skill `ekko-gate`).
- Stagea solo los archivos del paquete; muestra el inventario; `git diff --cached
  --check`. UN commit por paquete, mensaje `tipo(ámbito): …`, con la línea de
  coautoría vigente. Sin amend, force ni rebase.
- Antes del push: origin/main no se movió. Push normal. HEAD = origin/main.

## 6. Deploy y verificación
- Netlify construye con el mismo gate. Espera `ready`, contexto `production`,
  `commit_ref` = SHA exacto. Si el build falla: STOP; la base YA está migrada:
  dilo explícitamente; no saltes el gate ni fuerces el deploy.
- Sondas no mutantes: sitio 200; funciones protegidas 401/403 sin token y con
  token inválido; REST sin llave 401; con la llave pública (anon) las RPC nuevas
  deniegan y las tablas de evidencia no exponen filas; el bundle publicado
  contiene las cadenas del contrato nuevo y no las del viejo.
- Foto FINAL = foto DESPUÉS salvo eventos naturales, que se identifican y separan.
- Prohibido para verificar: sancionar, revocar, reservar, cobrar, cancelar en
  Stripe o crear datos. La validación con el primer evento real queda
  PENDIENTE / NO BLOQUEANTE y no impide el cierre.

## 7. Cierre
Reporte con cada paso y su evidencia, los hashes viejo→nuevo de lo cambiado, deploy
ID y timestamp, residuales. Estado final: DEPLOYED / VERIFICADO EN PRODUCCIÓN /
CLOSED, o DEPLOYED / VERIFICACIÓN INCOMPLETA, o STOP — ACTIVACIÓN FALLIDA.
Solo entonces actualiza `docs/STATUS.md` (producción, cerrado, local vacío,
siguiente paso) y, si el dueño decidió algo nuevo, `DECISIONS.md` + índice.
Luego STOP.
