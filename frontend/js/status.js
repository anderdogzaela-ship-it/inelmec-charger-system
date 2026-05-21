'use strict';

const params = new URLSearchParams(location.search);
const sessionId = params.get('session');
const simulate = params.get('simulate') === '1';
const simulateRef = params.get('reference');

const pad = (n) => String(n).padStart(2, '0');
const fmtRemain = (ms) => {
  if (ms == null) return '--:--';
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};
const fmtClock = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
};

let activationStartedAt = null;
let lastSession = null;
let pollTimer = null;
let tickTimer = null;

function showOnly(id) {
  for (const s of ['state-pending', 'state-activating', 'state-active', 'state-completed', 'state-failed']) {
    document.getElementById(s).style.display = s === id ? 'block' : 'none';
  }
}

async function poll() {
  if (!sessionId) {
    showOnly('state-failed');
    document.getElementById('failure-message').textContent = 'Sesión inválida.';
    return;
  }
  let res;
  try {
    res = await fetch(`/api/session/${sessionId}`);
  } catch {
    return;
  }
  if (!res.ok) return;
  lastSession = await res.json();
  render();
}

function render() {
  const s = lastSession;
  if (!s) return;

  document.getElementById('debug-data').textContent = JSON.stringify(s, null, 2);
  document.getElementById('session-debug').style.display = 'block';

  if (s.payment_status === 'DECLINED' || s.payment_status === 'VOIDED' || s.payment_status === 'ERROR') {
    showOnly('state-failed');
    document.getElementById('failure-message').textContent = `Pago ${s.payment_status}. No se cobró nada al usuario.`;
    document.getElementById('failure-ref').textContent = s.id;
    stopTimers();
    return;
  }

  if (s.payment_status === 'PENDING') {
    showOnly('state-pending');
    return;
  }

  // payment APPROVED — look at activation_status
  if (s.activation_status === 'NOT_STARTED' || s.activation_status === 'ACTIVATING') {
    if (!activationStartedAt) activationStartedAt = Date.now();
    showOnly('state-activating');
    document.getElementById('activation-timer').textContent =
      'Tiempo transcurrido: ' + Math.round((Date.now() - activationStartedAt) / 1000) + 's';
    return;
  }

  if (s.activation_status === 'ACTIVE') {
    showOnly('state-active');
    document.getElementById('active-charger-name').textContent =
      s.charger.display_name + ' (' + s.charger.qr_code + ')';
    document.getElementById('time-purchased').textContent = s.minutes_purchased + ' minutos';
    document.getElementById('end-time').textContent = fmtClock(s.expected_end_at);
    updateRemaining();
    if (!tickTimer) tickTimer = setInterval(updateRemaining, 1000);
    return;
  }

  if (s.activation_status === 'DEACTIVATING' || s.activation_status === 'COMPLETED') {
    showOnly('state-completed');
    stopTimers();
    return;
  }

  if (s.activation_status === 'TIMEOUT' || s.activation_status === 'FAILED') {
    showOnly('state-failed');
    const reasonMap = {
      timeout: 'El cargador no respondió en 30 segundos.',
      tuya: 'No pudimos comunicarnos con el cargador.',
    };
    document.getElementById('failure-message').textContent =
      'Activación fallida. ' + (s.failure_reason || 'Reintenta en unos minutos.');
    document.getElementById('failure-ref').textContent = s.id;
    stopTimers();
    return;
  }
}

function updateRemaining() {
  if (!lastSession || !lastSession.expected_end_at) return;
  const total = lastSession.minutes_purchased * 60_000;
  const endMs = new Date(lastSession.expected_end_at).getTime();
  const remainMs = Math.max(0, endMs - Date.now());
  document.getElementById('time-remaining').textContent = fmtRemain(remainMs);
  const pct = total > 0 ? Math.max(0, Math.min(100, ((total - remainMs) / total) * 100)) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  if (remainMs <= 0) {
    // Encourage a refresh so we move to the COMPLETED card quickly
    poll();
  }
}

function stopTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

async function maybeSimulate() {
  if (!simulate || !simulateRef) return;
  await fetch('/api/dev/simulate-approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: simulateRef }),
  });
}

(async function init() {
  await maybeSimulate();
  await poll();
  pollTimer = setInterval(poll, 1500);
})();
