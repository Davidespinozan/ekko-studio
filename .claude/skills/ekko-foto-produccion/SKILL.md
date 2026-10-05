---
name: ekko-foto-produccion
description: Toma una foto anónima y de SOLO LECTURA de la base de producción de EKKO (migraciones, inventario del esquema con hashes, conteos y hashes por tabla de negocio, estado operativo relevante) y la compara antes/después. Úsala al auditar un paquete, antes y después de una activación, o cuando haya que verificar una afirmación sobre producción.
---

# ekko-foto-produccion

Producción es evidencia, no entorno de pruebas. Esta skill solo LEE.

## Herramienta
`scripts/db-foto-produccion.mjs` (Management API de Supabase, token del llavero
del CLI o `SUPABASE_ACCESS_TOKEN`; nunca se imprime). Rechaza SQL con palabras de
escritura. Comandos:
- `foto --salida f.json` → migraciones + inventario (hash de cada función, trigger,
  política, constraint, índice, columna) + conteo y hash por tabla de negocio.
- `inventario`, `hashes <fn…>`, `comparar antes.json despues.json`, `sql "select …"`.

## Procedimiento
1. Confirma la identidad del proyecto (ref `cfihcrjbvgjiohedsjos`, EKKO). Si el
   prompt habla de otro proyecto, detente.
2. Toma la foto en la carpeta de scratch de la sesión, nunca dentro del repo.
3. Agrega una consulta de ESTADO OPERATIVO acotada al dominio del paquete (conteos
   por estado, sin PII): membresías vivas y con suscripción, reservas futuras y por
   estado, sancionados/revocados, revisiones abiertas, operaciones de cobro
   pendientes, eventos de webhook por estado… Solo lo que la tarea necesita; no
   vuelques la base.
4. Para una activación: foto ANTES → migración → foto DESPUÉS → `comparar`.
   Esperado: cambian solo migraciones y objetos de esquema previstos; toda tabla de
   negocio queda `OK`. Si una migración AGREGA columnas a una tabla, su hash cambia
   aunque no cambie ningún dato: recalcula con `--ignorar-cols=tabla:col1,col2` y
   explica por qué.
5. Guarda de invariantes cerrados: `hashes` de las funciones de R1, 01A–01H, R2-A y
   R2-B antes y después. Cualquier cambio no previsto detiene la activación.

## Lee los resultados con cuidado
- Un conteo de 0 (membresías vivas, reservas futuras) hace la migración más segura,
  pero no demuestra el comportamiento: eso lo demuestran las pruebas.
- Una diferencia en `tenants` suele ser un ajuste del admin (config): confírmalo
  antes de llamarlo anomalía.

## Reporte
Conteos y hashes en tablas cortas, sin ids ni datos personales. Di qué comparaste y
contra qué base (fecha, migraciones). Nada de aquí autoriza escribir.
