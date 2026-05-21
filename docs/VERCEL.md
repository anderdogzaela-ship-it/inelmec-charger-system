# Despliegue en Vercel

Hay dos formas válidas de poner este proyecto en Vercel:

| Modo | Para qué sirve | Tiempo de setup |
|---|---|---|
| **A · Demo / Testing**  (este documento) | Mostrar el flujo a un cliente, validar la UI, demo. Backend completo corriendo en una sola Vercel Function. | < 5 minutos |
| **B · Producción real** | Operación con dinero real. Frontend en Vercel + backend en Railway/Render/Fly + Postgres. | 30–60 minutos |

Para el modo B leer la sección al final. Para el modo A — el más rápido — sigue abajo.

---

## 🚀 Modo A — Demo en Vercel (1 comando)

Todo el sistema (Express + SQLite + admin + frontend) corre en una sola
serverless function. Configurado out-of-the-box vía
[`api/server.js`](../api/server.js) y [`vercel.json`](../vercel.json).

### Pre-requisitos
- Node.js 20+ y npm (para correr `vercel` CLI localmente)
- Cuenta gratis en https://vercel.com

### Pasos

```bash
# 1. Instalar Vercel CLI (una vez en tu máquina)
npm i -g vercel

# 2. Desde el root del proyecto
cd inelmec-charger-system
vercel login

# 3. Deploy a una URL preview
vercel

# 4. Cuando estés listo, promover a producción
vercel --prod
```

Eso es todo. Vercel te entrega una URL tipo
`https://inelmec-charger-system.vercel.app`.

### Abrir el demo

| URL | Qué es |
|---|---|
| `https://tu-app.vercel.app/?qr=INL-001` | Flujo usuario — click **"Simular pago aprobado (DEV)"** |
| `https://tu-app.vercel.app/admin/` | Panel — `admin@inelmec.com` / `inelmec2026` |

### Variables de entorno (opcional)

Vercel inyecta `VERCEL=1` automáticamente, lo cual:
- Forza `TUYA_MOCK=true` (no hay calls reales a Tuya)
- Pone la BD en `/tmp/inelmec.db` (único path writable en serverless)

Si quieres cambiar credenciales por defecto del admin, en Vercel dashboard →
Settings → Environment Variables agrega:

```env
ADMIN_DEFAULT_EMAIL=cliente@empresa.com
ADMIN_DEFAULT_PASSWORD=algoseguro
JWT_SECRET=<openssl rand -hex 32>
```

Re-deploy con `vercel --prod` y los nuevos valores se aplican al próximo
cold start.

### Lo que esto NO hace (limitaciones explícitas del modo demo)

1. **La BD es efímera por instancia.** Cada cold start (después de ~15 min
   sin tráfico) parte de cero. Las sesiones, audit log, webhooks reciben
   un re-seed con los 4 cargadores demo. Esto es **deseable** para una
   demo — el cliente siempre ve un estado limpio — pero **no apto** para
   datos reales.

2. **El safety worker de fondo no corre** (Vercel no soporta procesos
   long-running). En su lugar el endpoint `GET /api/admin/dashboard` y
   `GET /api/session/:id` ejecutan un *lazy safety check* al ser
   invocados — ver [`backend/src/services/safety-lazy.js`](../backend/src/services/safety-lazy.js).
   Para una demo, esto es suficiente: cuando el usuario o el admin abren
   la pantalla, las sesiones expiradas se apagan.

3. **Tuya está siempre en modo mock.** El simulador in-memory reproduce
   1–3 s de latencia real, perfecto para mostrar la pantalla "Activando…"
   y la confirmación. Sin hardware ni cuenta Tuya Cloud necesarios.

4. **Wompi sigue en sandbox.** Para una demo real con Wompi production
   en una URL Vercel, agrega las variables `WOMPI_*` en Vercel dashboard
   y registra el webhook `https://tu-app.vercel.app/api/payment/webhook`
   en el dashboard de Wompi.

### Probar localmente con Vercel CLI

Para reproducir el comportamiento Vercel en tu máquina:

```bash
vercel dev
```

Sirve en `http://localhost:3000`. Mismas reglas: BD en `/tmp`, sin worker
de fondo.

---

## 🏗 Modo B — Producción real

Lo que cambia frente al modo A:

| Aspecto | Modo A demo | Modo B producción |
|---|---|---|
| Backend | Vercel Function | Railway / Render / Fly.io |
| BD | SQLite en /tmp (efímera) | PostgreSQL en Neon / Railway / Supabase |
| Safety worker | Lazy check on-request | setInterval real (long-running) |
| Tuya | Mock | Tuya Cloud real |
| Frontend | Servido por la Function | Vercel CDN estática |

### Por qué Vercel **no** es viable para el backend en producción

1. **Timeout de funciones**: nuestro polling de Tuya puede tomar hasta 30 s.
   Vercel Hobby = 10 s, Pro = 60 s. Para producción donde el cargador puede
   tardar 15 s en confirmar encendido, depender del timeout de Vercel es
   frágil. (En modo A funciona porque el mock responde en 1–3 s y la function
   tiene `maxDuration: 30` configurado.)

2. **Safety worker cada 15 s**: Vercel Cron mínimo es 1/minuto en Pro, 1/día
   en Hobby. Imposible cumplir con el SLA de "el cargador no queda activo
   más de 1 minuto pasado el tiempo pagado".

3. **SQLite**: filesystem efímero. Una transacción reciente puede no estar
   ahí cuando entra otra function. Bad para una pasarela de pagos.

### Migración a Postgres + backend hosting

Ver [docs/DEPLOYMENT.md](DEPLOYMENT.md) — guía completa con VPS, Nginx y
systemd. Para Railway específicamente:

```bash
railway login
railway init
railway add postgresql            # provisiona Postgres
railway up                         # deploy
```

El refactor de `schema.sql` SQLite → Postgres es mecánico:
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- `datetime('now')` → `NOW()`
- columnas booleanas `INTEGER` → `BOOLEAN`
- `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`

Y `backend/src/db/db.js` cambia de `better-sqlite3` a `pg`. La interfaz
de las queries casi no cambia (parámetros pasan de `?` a `$1, $2, ...`).

---

## 🔧 Troubleshooting Vercel

| Síntoma | Causa | Solución |
|---|---|---|
| `Cannot find module 'better-sqlite3'` en logs | Vercel no incluyó binarios nativos | Verifica que `package.json` tiene `"engines": { "node": ">=20.0.0" }` y vuelve a deployar con `vercel --prod --force` |
| `EROFS: read-only file system` | Intentando escribir fuera de `/tmp` | Variables de entorno tienen un `DB_PATH` que apunta a otro lado. Borra el override |
| Cold start tarda > 10s | Vercel está compilando better-sqlite3 | Solo ocurre la primera vez. Subsequent invocaciones reusan la build |
| Webhooks Wompi llegan con firma INVÁLIDA | `WOMPI_EVENTS_SECRET` mal copiado | Dashboard Vercel → Settings → Env Vars → re-pegar desde Wompi dashboard |
| Después de re-deploy las sesiones desaparecieron | Esperado en modo A — BD efímera | Para persistencia, usar modo B |
