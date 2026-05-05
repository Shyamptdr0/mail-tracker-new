// content.js - Content script for Gmail (with pixel injection tracking)

const NGROK_URL = 'https://mail-tracker-new-one.onrender.com';


// Common headers for all backend fetch requests
const FETCH_HEADERS = {
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true'   // bypass ngrok free plan interstitial
};

let CONFIG = {
  BACKEND_URL: NGROK_URL
};
let userEmail = '';
let mailTrackingMap = new Map();

// ─── MV3 Keepalive port ───────────────────────────────────────────────────────
let _keepAlivePort = null;
function connectKeepalivePort() {
  try {
    _keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
    _keepAlivePort.onDisconnect.addListener(() => {
      setTimeout(connectKeepalivePort, 1000);
    });
  } catch (_) {}
}
connectKeepalivePort();

// ─── Inject CSS safely (document.head may be null at document_start) ─────────
function injectStyles() {
  if (document.getElementById('email-tracker-styles')) return;
  const styles = document.createElement('style');
  styles.id = 'email-tracker-styles';
  styles.textContent = `
    @keyframes tickAnimation {
      0%   { transform: scale(0.8); opacity: 0.5; }
      50%  { transform: scale(1.2); }
      100% { transform: scale(1);   opacity: 1;   }
    }
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to   { transform: translateX(0);     opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0);     opacity: 1; }
      to   { transform: translateX(400px); opacity: 0; }
    }
    .tracker-tick { transition: color 0.4s ease, text-shadow 0.4s ease; }
    .tracker-tick.green { text-shadow: 0 0 8px rgba(52, 168, 83, 0.5); }
    .tracking-toggle:hover  { transform: translateY(-2px) !important; }
    .tracking-toggle.active { box-shadow: 0 0 16px rgba(245, 87, 108, 0.5) !important; }
  `;
  (document.head || document.documentElement).appendChild(styles);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectStyles);
} else {
  injectStyles();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (response) => {
  if (chrome.runtime.lastError) {
    // Background service worker not ready — use hardcoded defaults
    console.log('[Tracker] Using default config (SW not ready)');
  } else if (response) {
    // Only override if background has a real URL (not localhost)
    if (response.BACKEND_URL && !response.BACKEND_URL.includes('localhost')) {
      CONFIG.BACKEND_URL = response.BACKEND_URL;
    }
  }

  // Also load userEmail from storage (set in options page)
  chrome.storage.local.get(['userEmail', 'backendUrl'], (result) => {
    if (result.userEmail) userEmail = result.userEmail;
    if (result.backendUrl && !result.backendUrl.includes('localhost')) {
      CONFIG.BACKEND_URL = result.backendUrl;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeTracker);
    } else {
      initializeTracker();
    }
  });
});

// ─── Get Gmail user email ─────────────────────────────────────────────────────
function detectUserEmail() {
  // Method 1: data-email attribute (Google account hover)
  const el = document.querySelector('[data-email]');
  if (el) return el.getAttribute('data-email');

  // Method 2: account link in header
  const links = document.querySelectorAll('a[href*="accounts.google.com"]');
  for (const link of links) {
    const m = link.href.match(/email=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  }

  return userEmail || 'unknown@gmail.com';
}

// ─── Initialize tracker ───────────────────────────────────────────────────────
function initializeTracker() {
  userEmail = detectUserEmail();
  console.log('📧 Email Tracker initialized for:', userEmail);

  injectTrackingUI();
  observeMailComposing();
  observeEmailOpening();
}

// ─── Inject tracking indicators into Gmail email list ─────────────────────────
function injectTrackingUI() {
  const observer = new MutationObserver(() => {
    document.querySelectorAll('[role="gridcell"]').forEach((row) => {
      if (!row.querySelector('.tracker-indicator')) {
        addTrackerIndicator(row);
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function addTrackerIndicator(emailRow) {
  const indicator = document.createElement('div');
  indicator.className = 'tracker-indicator';
  indicator.innerHTML = `<span class="tracker-tick gray">✓✓</span>`;
  indicator.style.cssText = `
    display: inline-block;
    margin-left: 10px;
    font-size: 12px;
    font-weight: bold;
    color: #b3b3b3;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    transition: all 0.3s ease;
  `;
  emailRow.appendChild(indicator);
}

// ─── Watch for compose window ──────────────────────────────────────────────────
function observeMailComposing() {
  function checkForComposeWindows() {
    // 1. Standard compose dialog
    document.querySelectorAll('[role="dialog"]').forEach((compose) => {
      if (!compose.hasAttribute('data-tracker-setup') && compose.querySelector('[contenteditable="true"]')) {
        compose.setAttribute('data-tracker-setup', 'true');
        setTimeout(() => setupComposeTracking(compose), 800);
      }
    });

    // 2. Inline compose (?compose=new or full-screen)
    // Gmail full-screen compose uses a different structure
    const fullScreenCompose = document.querySelector('.nH.adk, .dw.I5, [data-view-type="1"]');
    if (fullScreenCompose && !fullScreenCompose.hasAttribute('data-tracker-setup')) {
      fullScreenCompose.setAttribute('data-tracker-setup', 'true');
      setTimeout(() => setupComposeTracking(fullScreenCompose), 800);
    }
  }

  const observer = new MutationObserver(() => {
    checkForComposeWindows();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also check immediately on load
  setTimeout(checkForComposeWindows, 1500);
}

// ─── Setup compose window with tracking ───────────────────────────────────────
function setupComposeTracking(composeWindow, retryCount = 0) {
  // Don't setup if already done or compose closed/removed from DOM
  if (composeWindow.querySelector('.tracking-toggle')) return;
  if (!document.body.contains(composeWindow)) return;

  // Max 8 retries (~8 seconds total)
  if (retryCount > 8) {
    console.warn('[Tracker] Gave up finding send button after 8 retries');
    return;
  }

  // Find Gmail send button — try multiple strategies
  let sendButton = null;

  // Strategy 1: aria-label containing "Send"
  composeWindow.querySelectorAll('[role="button"]').forEach((btn) => {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('send') && !label.includes('schedule') && !sendButton) {
      sendButton = btn;
    }
  });

  // Strategy 2: data-tooltip containing "Send"
  if (!sendButton) {
    composeWindow.querySelectorAll('[data-tooltip]').forEach((btn) => {
      const tip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
      if (tip.includes('send') && !tip.includes('schedule') && !sendButton) {
        sendButton = btn;
      }
    });
  }

  // Strategy 3: look for Send button by class (Gmail uses .T-I.J-J5-Ji.aoO)
  if (!sendButton) {
    sendButton = composeWindow.querySelector('.T-I.J-J5-Ji.aoO, .aoO');
  }

  // Strategy 4: document-level fallback (for compose=new / full-screen mode)
  if (!sendButton) {
    document.querySelectorAll('[role="button"]').forEach((btn) => {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('send') && !label.includes('schedule') && !sendButton) {
        sendButton = btn;
      }
    });
  }

  if (!sendButton) {
    console.warn(`[Tracker] Send button not found (attempt ${retryCount + 1}/8) — retrying`);
    setTimeout(() => setupComposeTracking(composeWindow, retryCount + 1), 1000);
    return;
  }

  console.log('[Tracker] ✅ Send button found:', sendButton.getAttribute('aria-label'));

  // Double-add guard (checked again after async gap)
  if (composeWindow.querySelector('.tracking-toggle')) return;

  // ── Track toggle button ──
  const trackingButton = document.createElement('button');
  trackingButton.className = 'tracking-toggle';
  trackingButton.type = 'button';
  trackingButton.innerHTML = '📍 Track';
  trackingButton.title = 'Toggle email read-receipt tracking';
  trackingButton.style.cssText = `
    padding: 7px 14px;
    margin-left: 8px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition: all 0.3s ease;
    box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
    vertical-align: middle;
  `;

  // Generate a tracking ID upfront for this compose session
  let trackingId = crypto.randomUUID();
  let pixelInjected = false;

  trackingButton.addEventListener('click', (e) => {
    e.stopPropagation();
    const isActive = trackingButton.classList.toggle('active');
    trackingButton.innerHTML = isActive ? '📍 Tracking ON' : '📍 Track';
    trackingButton.style.background = isActive
      ? 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'
      : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';

    if (isActive) {
      // Inject pixel into email body NOW (before send)
      injectTrackingPixel(composeWindow, trackingId);
      pixelInjected = true;
      showInlineNotification(null, '📍 Tracking pixel added! Send to track opens.');
    } else {
      // Remove pixel if user turns off tracking
      removeTrackingPixel(composeWindow, trackingId);
      pixelInjected = false;
    }
  });

  // Insert button next to send
  const sendParent = sendButton.parentElement;
  if (sendParent) {
    sendParent.style.position = 'relative';
    sendButton.insertAdjacentElement('afterend', trackingButton);
  }

  // ── Intercept Send ──
  sendButton.addEventListener('click', () => {
    if (pixelInjected) {
      // Register the email in backend (pixel is already in email body)
      handleTrackedEmailSend(composeWindow, trackingId);
    }
  }, { capture: true });

  // Also catch Ctrl+Enter send
  composeWindow.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && pixelInjected) {
      handleTrackedEmailSend(composeWindow, trackingId);
    }
  });
}

// ─── Inject invisible tracking pixel into email body ─────────────────────────
function injectTrackingPixel(composeWindow, trackingId) {
  // Remove any old pixel first
  removeTrackingPixel(composeWindow, trackingId);

  // Gmail compose body selectors (try multiple)
  const body = composeWindow.querySelector('[role="textbox"]')
            || composeWindow.querySelector('.Am.Al.editable')
            || composeWindow.querySelector('[contenteditable="true"]');

  if (!body) {
    console.warn('[Tracker] Could not find email body for pixel injection');
    return;
  }

  const pixelUrl = `${CONFIG.BACKEND_URL}/api/tracking/pixel/${trackingId}`;

  // Create invisible pixel image
  const pixel = document.createElement('img');
  pixel.src = pixelUrl;
  pixel.width = 1;
  pixel.height = 1;
  pixel.alt = '';
  pixel.setAttribute('data-tracker-pixel', trackingId);
  pixel.style.cssText = 'width:1px;height:1px;opacity:0.01;display:inline;border:0;outline:0;';

  body.appendChild(pixel);
  console.log(`[Tracker] ✅ Pixel injected: ${pixelUrl}`);
}

function removeTrackingPixel(composeWindow, trackingId) {
  const existing = composeWindow.querySelectorAll(`[data-tracker-pixel="${trackingId}"]`);
  existing.forEach(el => el.remove());
}

// ─── Register tracked email with backend after send ───────────────────────────
async function handleTrackedEmailSend(composeWindow, trackingId) {
  // Gather email metadata
  const toField = composeWindow.querySelector('[aria-label="To"]')
               || composeWindow.querySelector('[placeholder*="To"]');
  const subjectField = composeWindow.querySelector('[aria-label="Subject"]')
                    || composeWindow.querySelector('[name="subjectbox"]')
                    || composeWindow.querySelector('[placeholder*="Subject"]');

  const recipientsRaw = toField
    ? (toField.value || toField.textContent || '').trim()
    : '';
  const recipients = recipientsRaw
    .split(/[,;\n]/)
    .map(r => r.trim())
    .filter(r => r.includes('@'));

  const subject = subjectField
    ? (subjectField.value || subjectField.textContent || '').trim()
    : '(no subject)';

  const senderEmail = userEmail || detectUserEmail();
  const pixelUrl = `${CONFIG.BACKEND_URL}/api/tracking/pixel/${trackingId}`;

  console.log('[Tracker] 🚀 handleTrackedEmailSend called', { trackingId, backendUrl: CONFIG.BACKEND_URL, recipientsRaw, subject });

  if (!CONFIG.BACKEND_URL || CONFIG.BACKEND_URL.includes('localhost')) {
    console.error('[Tracker] ❌ Backend URL is localhost — cannot reach from recipient. Check NGROK_URL.');
    return;
  }

  // Register with backend
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/tracking/send`, {
      method: 'POST',
      headers: FETCH_HEADERS,
      body: JSON.stringify({
        trackingId,
        senderEmail,
        recipients: recipients.length ? recipients : ['recipient@unknown.com'],
        subject,
        sentAt: new Date().toISOString(),
        trackingPixel: pixelUrl
      })
    });
    const result = await res.json();
    if (result.success) {
      console.log('[Tracker] ✅ Email registered, trackingId:', trackingId);
      showInlineNotification(null, `✅ Tracking active! You'll be notified when email is opened.`);
    }
  } catch (err) {
    console.error('[Tracker] Registration error:', err.message);
  }
}

// ─── Observe opened emails for self-read indicators ───────────────────────────
function observeEmailOpening() {
  const observer = new MutationObserver(() => {
    const main = document.querySelector('[role="main"]');
    if (!main) return;
    main.querySelectorAll('img[src*="/api/tracking/pixel/"]').forEach((pixel) => {
      if (!pixel.hasAttribute('data-reported')) {
        pixel.setAttribute('data-reported', 'true');
        const trackingId = pixel.src.split('/api/tracking/pixel/')[1];
        if (trackingId) reportEmailOpen(trackingId);
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function reportEmailOpen(trackingId) {
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/tracking/report-open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackingId,
        openedAt: new Date().toISOString(),
        userAgent: navigator.userAgent
      })
    });
    const result = await res.json();
    if (result.success) {
      console.log('📬 Email open reported for trackingId:', trackingId);
    }
  } catch (err) {
    console.error('Error reporting open:', err.message);
  }
}

// ─── Update ticks green ───────────────────────────────────────────────────────
function updateTicksToGreen(mailId) {
  document.querySelectorAll('.tracker-indicator').forEach((indicator) => {
    const tick = indicator.querySelector('.tracker-tick');
    if (tick && tick.classList.contains('gray')) {
      tick.classList.replace('gray', 'green');
      tick.style.color = '#34a853';
      tick.style.animation = 'tickAnimation 0.4s ease';
    }
  });
}

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EMAIL_OPENED_UPDATE') {
    updateTicksToGreen(request.mailId);
    showInlineNotification(null, `✅ ${request.recipientEmail} opened your email!`);
  } else if (request.type === 'TRACKING_STATUS_UPDATE') {
    console.log('[Tracker] Status update:', request.status);
  }
});

// ─── Inline toast notification ────────────────────────────────────────────────
function showInlineNotification(container, message) {
  // Remove any existing notification
  document.querySelectorAll('.tracking-notification').forEach(n => n.remove());

  const notification = document.createElement('div');
  notification.className = 'tracking-notification';
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: linear-gradient(135deg, #34a853 0%, #0d9488 100%);
    color: white;
    padding: 14px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(52, 168, 83, 0.35);
    z-index: 2147483647;
    font-size: 13px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    max-width: 360px;
    animation: slideIn 0.3s ease;
    cursor: pointer;
  `;
  notification.addEventListener('click', () => notification.remove());
  document.body.appendChild(notification);
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

console.log('✅ Email Tracker content script loaded');