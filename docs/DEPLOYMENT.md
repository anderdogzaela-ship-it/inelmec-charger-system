# Guía de despliegue a producción

Esta guía cubre cómo llevar el sistema desde el repo hasta un VPS sirviendo
tráfico real con HTTPS.

## 1. Requisitos del servidor

- Ubuntu 22.04 LTS (recomendado, también funciona 24.04 / Debian 12)
- 1 vCPU, 1 GB RAM, 10 GB disco (basta para cientos de transacciones/día)
- Dominio apuntado al VPS (DNS A record)
- Node.js 20+ (`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -`)
- Nginx
- Certbot

## 2. Preparación del servidor

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-nginx ufw build-essential
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable

# Usuario no-root para correr la app
sudo useradd -m -s /bin/bash inelmec
sudo -u inelmec mkdir /home/inelmec/app
```

## 3. Desplegar el código

```bash
sudo -u inelmec bash
cd /home/inelmec/app
git clone <url-del-repo> .
npm ci --omit=dev
cp .env.example .env
nano .env   # llenar con credenciales reales (ver §4)
node backend/src/db/migrate.js
node backend/src/db/seed.js
```

## 4. Configurar `.env` para producción

Mínimo viable:

```env
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://cargadores.inelmec.com
DB_PATH=/home/inelmec/app/data/inelmec.db

JWT_SECRET=<openssl rand -hex 32>
ADMIN_DEFAULT_EMAIL=admin@inelmec.com
ADMIN_DEFAULT_PASSWORD=<generar uno fuerte>

WOMPI_BASE_URL=https://production.wompi.co/v1
WOMPI_PUBLIC_KEY=pub_prod_xxxxxxxxxxxx
WOMPI_PRIVATE_KEY=prv_prod_xxxxxxxxxxxx
WOMPI_EVENTS_SECRET=<copiar del dashboard Wompi → Eventos>
WOMPI_INTEGRITY_SECRET=<copiar del dashboard Wompi → Integridad>

TUYA_MOCK=false
TUYA_BASE_URL=https://openapi.tuyaus.com
TUYA_ACCESS_ID=<de iot.tuya.com>
TUYA_ACCESS_SECRET=<de iot.tuya.com>
```

## 5. Servicio systemd

`/etc/systemd/system/inelmec.service`:

```ini
[Unit]
Description=INELMEC Charger System
After=network.target

[Service]
Type=simple
User=inelmec
WorkingDirectory=/home/inelmec/app
ExecStart=/usr/bin/node backend/src/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:/var/log/inelmec.log
StandardError=append:/var/log/inelmec.err.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable inelmec
sudo systemctl start inelmec
sudo systemctl status inelmec
```

## 6. Nginx + HTTPS

`/etc/nginx/sites-available/inelmec`:

```nginx
server {
    listen 80;
    server_name cargadores.inelmec.com;

    # ACME challenge for Certbot
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name cargadores.inelmec.com;

    # Filled in by Certbot:
    # ssl_certificate /etc/letsencrypt/live/.../fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/inelmec /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d cargadores.inelmec.com
```

## 7. Configurar Wompi

1. Login en https://comercios.wompi.co
2. **Eventos → Configurar URL**: `https://cargadores.inelmec.com/api/payment/webhook`
3. Eventos a suscribir: `transaction.updated`
4. **Copiar el "Secreto de eventos"** → poner en `.env` como `WOMPI_EVENTS_SECRET`
5. **Comercio → Integridad** → copiar a `WOMPI_INTEGRITY_SECRET`
6. Reiniciar el servicio: `sudo systemctl restart inelmec`

### Verificar que Wompi llega bien
- Hacer un pago de prueba mínimo (COP $1.500)
- En el admin panel → **Webhooks**, debe aparecer una entrada con
  `signature_valid = Válida` y `processed = Procesado`
- Si aparece `INVÁLIDA`: el secreto está mal copiado o el body está siendo
  modificado por un proxy (verificar headers, especialmente
  `Content-Type: application/json`)

## 8. Configurar Tuya Cloud

1. Crear cuenta en https://iot.tuya.com
2. **Cloud → Projects → Create** → tipo *Smart Home*, data center *Western America* (LATAM)
3. Habilitar APIs: *Authorization Token Management*, *Device Status Notification*, *IoT Core*
4. **Devices → Link Tuya App Account** → escanear QR con la cuenta Smartlife
   donde están pareados los cargadores
5. **Project Overview** → copiar Access ID y Access Secret a `.env`
6. Listar tus dispositivos: en el panel admin (o vía API
   `GET /v1.0/users/{uid}/devices`) y actualizar `chargers.tuya_device_id` en
   la BD para que coincida con el ID real:

```bash
sudo -u inelmec sqlite3 /home/inelmec/app/data/inelmec.db
> UPDATE chargers SET tuya_device_id = 'bf8b3f...' WHERE qr_code = 'INL-001';
```

### Verificar el datapoint correcto
Ir al panel admin → Cargadores → click en el cargador. El sistema asume
`switch_1` por defecto. Si tu modelo de cargador usa otro datapoint:

```sql
UPDATE chargers SET tuya_switch_dp = 'switch' WHERE id = 1;  -- o 'switch_led_1', etc.
```

Para descubrir el datapoint correcto, en iot.tuya.com → *Devices → Status* del cargador.

## 9. Generar e imprimir los QR

```bash
# Cada cargador necesita una etiqueta física con su URL.
# Para INL-001:
node -e "require('qrcode').toFile('inl-001.png', 'https://cargadores.inelmec.com/?qr=INL-001', { width: 800 })"
```

Imprimir, laminar, pegar.

## 10. Operación día a día

### Logs
```bash
sudo tail -f /var/log/inelmec.log
sudo journalctl -u inelmec -f
```

### Backup de la BD
```bash
# Backup atómico (SQLite WAL):
sudo -u inelmec sqlite3 /home/inelmec/app/data/inelmec.db ".backup '/tmp/inelmec-$(date +%F).db'"
```

Recomendado: cron diario que envía a S3 o similar.

### Actualizar a una nueva versión
```bash
sudo -u inelmec bash
cd /home/inelmec/app
git pull
npm ci --omit=dev
node backend/src/db/migrate.js   # idempotente
exit
sudo systemctl restart inelmec
```

## 11. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| Webhook llega como `INVÁLIDA` en panel | `WOMPI_EVENTS_SECRET` incorrecto | Recopiar del dashboard Wompi |
| Activación siempre termina en `TIMEOUT` | Cargador offline, o `tuya_switch_dp` incorrecto | Verificar conectividad en Smartlife; revisar datapoint en iot.tuya.com |
| Admin no puede ingresar | Hash de password reseteado | `node backend/src/db/seed.js` recrea el admin si no existe |
| Cargador no aparece | Falta de seed o `qr_code` mal escrito en QR | Verificar en la tabla `chargers` |
| Alta latencia en activación (>10s) | Wi-Fi débil donde está el cargador | Repetidor/AP cercano, o cambiar a cargador con red cableada |
