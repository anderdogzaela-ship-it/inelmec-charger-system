# INELMEC — Sistema de Cargadores Eléctricos Comunales

Plataforma para activación pagada de cargadores eléctricos comunales mediante
escaneo de QR + pago con **Wompi** + control del dispositivo físico vía **Tuya
IoT Cloud** (Smartlife).

> **Para INELMEC S.A.S.** — el `phase-0 assessment` propuesto se materializó
> directamente como un MVP funcional. El sistema corre completo en modo demo
> (Tuya simulado) sin necesidad de hardware, y está listo para conectarse a
> Wompi sandbox/producción y a un proyecto Tuya Cloud real con sólo cambiar
> credenciales en el archivo `.env`.

---

## ✅ Qué resuelve esto

| Riesgo identificado | Mitigación implementada |
|---|---|
| Usuario paga, no ve el LED encender, paga de nuevo → 15–20 % de duplicados | Polling del estado del device cada 500ms hasta confirmar encendido + pantalla `Activando...` con timeout de 30s + idempotency key por `reference` |
| Tuya Cloud falla y el comando "apagar" no llega → cargador queda energizado | Worker de seguridad corriendo cada 15s que escanea sesiones vencidas y fuerza el apagado, audit alert si Tuya sigue sin responder |
| Cualquiera con la URL del webhook puede simular pagos aprobados | Validación HMAC SHA-256 de cada webhook contra `WOMPI_EVENTS_SECRET` antes de procesarlo, con timing-safe compare |
| Disputa con Wompi sin trazabilidad | `audit_log` append-only registra cada transición de estado con timestamp + payment_id + actor |

---

## 🏗 Arquitectura

```
                              ┌──────────────────────┐
                              │   Usuario móvil      │
                              │  (escanea QR)        │
                              └─────────┬────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
       ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
       │  Frontend    │         │   Wompi      │         │   Admin      │
       │  (HTML/JS)   │─pago───▶│  Checkout    │         │   Panel      │
       │  Spanish UI  │         └──────┬───────┘         │  (HTML/JS)   │
       └──────┬───────┘                │                 └──────┬───────┘
              │                        │                        │
              │ poll session           │ webhook (HMAC)         │ JWT auth
              ▼                        ▼                        ▼
       ┌────────────────────────────────────────────────────────────┐
       │                  Backend Node.js / Express                 │
       │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
       │  │ Payment svc  │  │ Activation   │  │ Safety worker   │   │
       │  │ (Wompi HMAC) │─▶│ orchestrator │◀─│ (every 15s)     │   │
       │  └──────────────┘  └───────┬──────┘  └─────────────────┘   │
       │                            │ Tuya signed API               │
       │                            ▼                               │
       │                    ┌──────────────┐                        │
       │  ┌──────────────┐  │  Tuya client │   ┌──────────────┐     │
       │  │  audit_log   │◀─│  + polling   │──▶│ Tuya IoT     │     │
       │  │  (append)    │  └──────────────┘   │ Cloud        │     │
       │  └──────────────┘                     └──────┬───────┘     │
       │                                              │ MQTT        │
       └──────────────────────────────────────────────┼─────────────┘
                                                      ▼
                                              ┌───────────────┐
                                              │   Cargador    │
                                              │   físico      │
                                              │  (Smartlife)  │
                                              └───────────────┘
```

### Módulos principales

| Módulo | Archivo | Rol |
|---|---|---|
| Config | `backend/src/config/index.js` | Carga `.env` y valida vars requeridas |
| Tuya client | `backend/src/services/tuya.js` | Firma HMAC-SHA256 de Tuya, token cache, polling, mock mode |
| Wompi client | `backend/src/services/wompi.js` | Verifica firma de webhook, genera `signature:integrity` del Checkout |
| Activation orchestrator | `backend/src/services/activation.js` | State machine + idempotencia + safety timeouts |
| Payment service | `backend/src/services/payment.js` | Procesa eventos Wompi tras validación |
| Safety worker | `backend/src/workers/safety.js` | Apagado automático de sesiones vencidas |
| Audit log | `backend/src/services/audit.js` | Bitácora inmutable |

---

## ☁️ Deploy en Vercel (un comando)

Para mostrar la demo a un cliente sin instalar nada local:

```bash
npm i -g vercel
vercel login
vercel --prod
```

Eso entrega una URL `https://tu-app.vercel.app` corriendo el sistema
completo (backend + admin + frontend) en una sola Vercel Function.

Detalles, limitaciones y guía para producción real en [`docs/VERCEL.md`](docs/VERCEL.md).

> En modo Vercel la BD es **efímera por instancia** (perfecta para demos
> — siempre arranca con estado limpio). Para producción con dinero real
> ver §"Producción" abajo.

---

## 🚀 Quick start (modo demo, sin hardware)

```bash
git clone <repo>
cd inelmec-charger-system

# 1. Instalar dependencias
npm install

# 2. Configurar entorno (los defaults ya funcionan para demo)
cp .env.example .env

# 3. Inicializar BD + crear admin + sembrar cargadores de demo
npm run migrate
npm run seed

# 4. Levantar el servidor
npm start
```

El servidor corre en `http://localhost:3000` con `TUYA_MOCK=true`, así que
puedes probar el flujo completo sin un cargador físico.

### Probarlo

| Pantalla | URL |
|---|---|
| QR landing del cargador `INL-001` | http://localhost:3000/?qr=INL-001 |
| Panel de administración | http://localhost:3000/admin/ |

**Credenciales por defecto:** `admin@inelmec.com` / `inelmec2026`.

### Demo de pago completo

1. Abre `http://localhost:3000/?qr=INL-001`
2. Selecciona minutos
3. En modo `localhost`, aparece el botón **"Simular pago aprobado (DEV)"** — clic ahí
4. Verás la pantalla *"Activando cargador..."* con spinner real (1–3s)
5. Cambia a *"⚡ Cargador activo"* con countdown
6. Cuando el contador llega a 0, el safety worker apaga el cargador

Mientras tanto, en el **admin panel** verás:
- El dashboard reflejando ingresos + sesión activa
- Auditoría con los eventos `session.created` → `wompi.approved` → `activation.start` → `activation.confirmed` → `deactivation.confirmed`
- Webhooks con la firma marcada como **válida**

### E2E test

```bash
npm run test:e2e
```

Verifica los 8 puntos críticos del sistema (incluyendo idempotencia y rechazo
de webhooks con firma falsa).

---

## 🔐 Pasar de demo a producción

Sólo se modifica `.env`. **No hay cambios de código.**

```env
NODE_ENV=production
TUYA_MOCK=false

# Wompi (https://comercios.wompi.co)
WOMPI_BASE_URL=https://production.wompi.co/v1
WOMPI_PUBLIC_KEY=pub_prod_...
WOMPI_PRIVATE_KEY=prv_prod_...
WOMPI_EVENTS_SECRET=...        # dashboard → Eventos → Configurar
WOMPI_INTEGRITY_SECRET=...     # dashboard → Comercio → Integridad

# Tuya IoT (https://iot.tuya.com)
TUYA_BASE_URL=https://openapi.tuyaus.com   # ó tuyaeu / tuyacn según data center
TUYA_ACCESS_ID=...
TUYA_ACCESS_SECRET=...
```

### Configurar Wompi
1. En el dashboard Wompi, ir a **Eventos** → registrar URL: `https://tu-dominio.com/api/payment/webhook`
2. Copiar el **secreto de eventos** a `WOMPI_EVENTS_SECRET`

### Configurar Tuya
1. Crear cuenta en https://iot.tuya.com (recomendado data center **Western America** para Colombia)
2. Crear **Cloud Project** tipo *Smart Home*
3. Habilitar **IoT Core** y **Authorization Token Management**
4. En la pestaña *Devices*, **Link a Tuya App account** y escanear el QR
   con la app Smartlife donde están los cargadores → autoriza el acceso
   a esos dispositivos
5. Copiar **Access ID** y **Access Secret** del proyecto a `.env`
6. En la BD, actualizar `chargers.tuya_device_id` con el ID real (visible
   en la consola Tuya, también accesible por API en `/v2.0/cloud/thing/device`)

### Configurar dispositivo en Smartlife
- Cada cargador debe estar pareado en la app Smartlife como dispositivo Wi-Fi
  con función *switch* (relé/contactor controlado)
- Verificar el código del datapoint (típicamente `switch_1`) en la consola
  Tuya → *Device → Status* y guardarlo en `chargers.tuya_switch_dp`

---

## 📁 Estructura del proyecto

```
backend/
  src/
    config/           env loader
    db/               schema.sql, migrate, seed, db.js
    middleware/       JWT auth
    routes/           public.js, admin.js
    services/         tuya.js, wompi.js, activation.js, payment.js,
                      sessions.js, chargers.js, audit.js, tuya.mock.js
    utils/            logger.js
    workers/          safety.js
    server.js         entry point
frontend/             user-facing UI (QR landing, payment status)
admin/                admin panel (login, dashboard, chargers, sessions, audit, webhooks)
scripts/              e2e-test.js, simulate-wompi-webhook.js
docs/                 ARCHITECTURE.md, DEPLOYMENT.md
```

---

## 📚 Documentación adicional

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Detalle del state machine,
  decisiones de diseño y modelo de fallas.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Guía paso a paso para llevar
  el sistema a producción (VPS, Nginx, systemd, certificado SSL, etc).

---

## 🛡 Modelo de seguridad

1. **Webhook authenticity**: cada evento de Wompi se valida con HMAC SHA-256 +
   timing-safe comparison. Eventos sin firma o con firma incorrecta retornan
   `401` y no llegan al orchestrator.
2. **Idempotency**: `claimActivation()` usa una transacción SQLite con guarda
   en `activation_status = NOT_STARTED` para garantizar que dos webhooks
   concurrentes no activen el mismo cargador dos veces.
3. **Source of truth = servidor**: el frontend nunca dispara una activación.
   Sólo el webhook server-to-server de Wompi puede mover una sesión a
   `APPROVED`.
4. **Audit inmutable**: `audit_log` no acepta UPDATE/DELETE desde la
   aplicación. Cada transición tiene `event_type`, `actor`, `payload` y
   `created_at`.
5. **Safety net**: aunque todas las demás capas fallen, el `safety` worker
   intenta apagar cualquier cargador con `expected_end_at` vencido.
