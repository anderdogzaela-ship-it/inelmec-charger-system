'use strict';

const COP = (n) => '$' + Number(n).toLocaleString('es-CO');

function qrFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get('qr') || params.get('c');
}

let charger = null;
let selectedMinutes = null;

async function load() {
  const qr = qrFromUrl();
  if (!qr) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('not-found').style.display = 'block';
    return;
  }

  let res;
  try {
    res = await fetch(`/api/charger/${encodeURIComponent(qr)}`);
  } catch {
    return showNotFound();
  }
  if (res.status === 404) return showNotFound();
  charger = await res.json();

  document.getElementById('loading').style.display = 'none';
  document.getElementById('charger-info').style.display = 'block';
  document.getElementById('ch-name').textContent = charger.display_name;
  document.getElementById('ch-location').textContent = charger.location_name +
    (charger.location_address ? ' · ' + charger.location_address : '');
  document.getElementById('ch-rate').textContent = COP(charger.rate_cop_per_hour) + ' / hora';

  const pill = document.getElementById('ch-status');
  pill.className = 'status-pill ' + (charger.online ? charger.status : 'offline');
  pill.textContent =
    !charger.online ? 'Sin conexión' :
    charger.status === 'available' ? 'Disponible' :
    charger.status === 'occupied'  ? 'En uso' :
    charger.status === 'maintenance' ? 'Mantenimiento' :
    charger.status;

  if (!charger.online || charger.status !== 'available') {
    document.getElementById('unavailable').style.display = 'block';
    document.getElementById('unavailable-reason').textContent =
      !charger.online ? 'El cargador no está respondiendo. Reporta a la administración.' :
      'El cargador está actualmente en uso. Inténtalo en unos minutos.';
    return;
  }

  renderMinutes();
  document.getElementById('select-time').style.display = 'block';

  // Show dev simulate button when server is in development mode
  if (charger.dev_mode) {
    document.getElementById('dev-simulate').style.display = 'block';
  }
}

function renderMinutes() {
  const grid = document.getElementById('minutes-grid');
  const options = [30, 60, 90, 120, 180, 240]
    .filter((m) => m >= charger.min_minutes && m <= charger.max_minutes);

  grid.innerHTML = '';
  for (const m of options) {
    const cop = Math.round((charger.rate_cop_per_hour * m) / 60);
    const btn = document.createElement('div');
    btn.className = 'minute-btn';
    btn.dataset.minutes = m;
    btn.innerHTML = `<div class="m">${m}<small style="font-size:11px"> min</small></div>
                     <div class="p">${COP(cop)}</div>`;
    btn.addEventListener('click', () => selectMinutes(m));
    grid.appendChild(btn);
  }
}

function selectMinutes(m) {
  selectedMinutes = m;
  document.querySelectorAll('.minute-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.minutes) === m);
  });
  const total = Math.round((charger.rate_cop_per_hour * m) / 60);
  document.getElementById('total').textContent = COP(total);
  document.getElementById('pay-btn').disabled = false;
}

async function initiatePayment(simulate = false) {
  if (!selectedMinutes) return;
  const payBtn = document.getElementById('pay-btn');
  const simBtn = document.getElementById('dev-simulate');
  payBtn.disabled = true; simBtn.disabled = true;
  payBtn.textContent = 'Creando sesión...';

  let res;
  try {
    res = await fetch('/api/payment/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        qr_code: charger.qr_code,
        minutes: selectedMinutes,
        user_email: document.getElementById('email').value || undefined,
        user_phone: document.getElementById('phone').value || undefined,
      }),
    });
  } catch {
    payBtn.disabled = false; simBtn.disabled = false;
    payBtn.textContent = 'Pagar con Wompi';
    alert('No pudimos conectar con el servidor. Intenta de nuevo.');
    return;
  }

  if (!res.ok) {
    payBtn.disabled = false; simBtn.disabled = false;
    payBtn.textContent = 'Pagar con Wompi';
    const err = await res.json().catch(() => ({}));
    alert('Error: ' + (err.error || res.statusText));
    return;
  }

  const data = await res.json();
  if (simulate) {
    location.href = `/status.html?session=${data.session_id}&simulate=1&reference=${encodeURIComponent(data.reference)}`;
  } else {
    location.href = data.checkout_url;
  }
}

function showNotFound() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('not-found').style.display = 'block';
}

document.getElementById('pay-btn').addEventListener('click', () => initiatePayment(false));
document.getElementById('dev-simulate').addEventListener('click', () => initiatePayment(true));

load();
