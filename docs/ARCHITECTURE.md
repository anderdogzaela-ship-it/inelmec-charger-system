# Arquitectura del sistema INELMEC Cargadores

## 1. State machine de una sesión de carga

Cada sesión tiene dos estados que evolucionan de forma independiente porque
representan dos sistemas externos que pueden fallar por separado.

### `payment_status` (lado Wompi)

```
PENDING ──webhook APPROVED──▶ APPROVED ──┐
PENDING ──webhook DECLINED──▶ DECLINED   │
PENDING ──webhook VOIDED  ──▶ VOIDED     │
                                         ▼
                                    (no activación)
```

### `activation_status` (lado Tuya)

```
NOT_STARTED ──payment APPROVED──▶ ACTIVATING
ACTIVATING ──Tuya confirms ON───▶ ACTIVE
ACTIVATING ──poll timeout (30s)─▶ TIMEOUT    (manual refund)
ACTIVATING ──Tuya offline──────▶ FAILED      (manual refund)
ACTIVE ─────time expires───────▶ DEACTIVATING
DEACTIVATING ──Tuya confirms OFF▶ COMPLETED
DEACTIVATING ──safety force off▶ COMPLETED  (con audit flag)
```

Por qué separarlos: la transacción Wompi puede quedarse en `APPROVED` mientras
el cargador no responde. Esa combinación dispara el flujo de *refund manual*
en el admin panel, que sólo puede ejecutarse si separamos el seguimiento de
los dos lados.

## 2. Modelo de fallas

Los siete escenarios de falla más realistas y cómo el sistema responde:

| # | Falla | Quién la detecta | Respuesta |
|---|---|---|---|
| 1 | Wompi retransmite el mismo webhook 2 veces | `activation.activate()` | `claimActivation()` ve `activation_status != NOT_STARTED` y retorna `skipped: true`. El cargador no se reactiva. |
| 2 | Atacante envía webhook forjado | Verificador HMAC | El handler retorna `401` antes de tocar el orchestrator. El evento queda registrado con `signature_valid = 0`. |
| 3 | Tuya tarda 12s en confirmar (latencia alta) | Polling loop | El loop sigue cada 500ms hasta `ACTIVATION_TIMEOUT_MS`. El usuario ve "Activando cargador..." y luego la pantalla *activo*. |
| 4 | Tuya nunca confirma (cargador desconectado del Wi-Fi) | Polling loop timeout | Sesión pasa a `TIMEOUT`. Admin panel marca la sesión para refund manual. Usuario ve mensaje claro: "tu pago fue procesado pero el cargador no respondió". |
| 5 | Cargador queda encendido pasado su tiempo | Safety worker | Cada 15s escanea sesiones con `expected_end_at < now`. Las pasa a `DEACTIVATING` y llama Tuya. |
| 6 | Tuya offline al momento del apagado | Safety worker | Audit log marca evento `safety.alert`. Retry en la próxima iteración. Admin panel muestra alerta en dashboard. |
| 7 | Crash del servidor durante una activación | Safety worker | Al reiniciar, sesiones en `ACTIVATING` quedan ahí. La acción correcta es revisarlas manualmente (no hay forma de saber si Tuya sí activó o no sin polling explícito) — el admin puede usar "force-deactivate" para garantizar el apagado. |

## 3. Idempotency en detalle

El método `claimActivation(sessionId)` corre dentro de una transacción
SQLite. Su lógica esencial:

```sql
SELECT activation_status FROM sessions WHERE id = ?;
-- si != NOT_STARTED: ABORT (otra concurrencia ya tomó el lock)

UPDATE sessions
   SET activation_status = 'ACTIVATING'
 WHERE id = ? AND activation_status = 'NOT_STARTED';
-- si rowcount = 0: alguien más ganó la carrera, ABORT

INSERT OR IGNORE INTO idempotency_keys (key, session_id)
VALUES ('activate:' || ?, ?);
```

Es seguro frente a:
- Dos webhooks llegando a 1ms de diferencia desde Wompi (retry)
- Un webhook + un admin que clickea "Reactivar" al mismo tiempo
- Reinicios del proceso mientras un activate() está corriendo (las sesiones
  en `ACTIVATING` quedan como tales — no se "auto-reanudan")

## 4. Por qué Tuya Cloud y no MQTT directo

Alternativas evaluadas y descartadas:

| Opción | Por qué no |
|---|---|
| MQTT directo al cargador | Smartlife usa el protocolo Tuya propietario sobre Wi-Fi. No expone un MQTT abierto. |
| Tuya Local LAN API | Funciona, pero requiere extraer `local_key` con root del dispositivo; rompe la garantía y depende de que el server esté en la misma red. No escala a múltiples conjuntos. |
| API privada Smartlife | No documentada, frágil, sin compromisos de SLA. |
| **Tuya IoT Cloud Platform** ✓ | Documentada, gratis hasta cierto volumen, soporta exactamente el `switch_1` que necesitamos, mismas credenciales sirven para n dispositivos. |

## 5. Por qué SQLite (para MVP) y plan de migración

SQLite con `journal_mode = WAL` soporta múltiples lectores + un escritor
concurrente, suficiente para 50–200 transacciones/hora en un conjunto típico.

Cuando INELMEC quiera consolidar varios conjuntos en una sola base, o quiera
correr el backend en múltiples instancias detrás de un load balancer, el
schema actual se porta a **PostgreSQL** con:

- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- columnas UUID `TEXT` → `UUID`
- `datetime('now')` → `now()`
- el `claim_activation` se queda igual; PostgreSQL respeta el lock con `SERIALIZABLE` o `SELECT ... FOR UPDATE`

No hay cambios en el código de aplicación: el driver `better-sqlite3` se
reemplaza por `pg`, y las queries son SQL standard.

## 6. Performance considerations

- **Polling cost**: durante una activación, el server hace ~6–30 lecturas a
  Tuya (latencia típica 1–3s con poll cada 500ms, hasta 60 si llegamos al
  timeout de 30s). Tuya permite ~50 requests/sec por proyecto, suficiente
  para ~5 activaciones simultáneas. Para más, usar **WebSocket subscription**
  de Tuya para notificaciones de cambio de estado (TODO Phase 2).

- **Safety worker frequency**: 15s es el balance entre overhead y tiempo
  de exposición. Bajar a 5s si el cliente requiere SLA estricto, subir a
  60s si el volumen lo justifica.

- **Audit log growth**: ~5 filas por sesión de carga. Para 1000 sesiones/mes
  son 60 000 filas/año — trivial. Si crece a millones, archive trimestral a
  S3 vía un cron.

## 7. Roadmap de Phase 2+

Funcionalidad explícitamente fuera del MVP, pero soportada por la arquitectura:

- Subscripción WebSocket a Tuya (en lugar de polling)
- Notificaciones push/email al usuario al completar una sesión
- Tarjetas de fidelización / suscripciones
- Multi-tenant para varios conjuntos con admins separados
- Reportería: exports CSV, gráficas, ingresos por cargador
- Mobile-first dashboard para que el administrador del conjunto vea
  todo desde su teléfono
- Integración con sistemas de facturación (Siigo, Alegra, etc.)
- Soporte para múltiples pasarelas (PSE directo, Mercado Pago) además de Wompi
