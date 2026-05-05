// ─── Accept keepalive ports from content scripts ─────────────────────────────
// Content scripts maintain a persistent port connection. As long as any Gmail
// tab is open, this keeps the service worker alive → stable WebSocket.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  // Just holding the port open is enough — no messages needed
  port.onDisconnect.addListener(() => {
    // Tab closed or navigated away — that's fine
  });
});

// ─── Config ──────────────────────────────────────────────────────────────────
let CONFIG = {
  BACKEND_URL: 'https://mail-tracker-new-one.onrender.com',
  WS_URL:      'wss://mail-tracker-new-one.onrender.com/ws'
};

let ws = null;
let wsReconnectTimer = null;
let userEmail = '';

// ─── Load config from storage on startup ─────────────────────────────────────
chrome.storage.local.get(['backendUrl', 'wsUrl', 'userEmail'], (result) => {
  if (result.backendUrl) {
    // Auto-upgrade http → https
    CONFIG.BACKEND_URL = result.backendUrl.replace(/^http:\/\//i, 'https://');
  }
  if (result.wsUrl) {
    // Auto-upgrade ws → wss and ensure /ws path
    let url = result.wsUrl.replace(/^ws:\/\//i, 'wss://');
    if (!url.endsWith('/ws')) {
      url = url.replace(/\/$/, '') + '/ws';
    }
    CONFIG.WS_URL = url;
  } else {
    // Derive WS_URL from BACKEND_URL and add /ws
    CONFIG.WS_URL = CONFIG.BACKEND_URL.replace(/^https:\/\//i, 'wss://').replace(/\/$/, '') + '/ws';
  }
  if (result.userEmail) userEmail = result.userEmail;
  initWebSocket();
});

// ─── Keepalive alarm (prevents MV3 service worker from being killed) ─────────
// Chrome MV3 service workers are terminated when idle.
// chrome.alarms wakes them up periodically to maintain WS connection.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // every ~24 sec

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;

  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    initWebSocket();
  } else if (ws.readyState === WebSocket.OPEN) {
    // Heartbeat ping to keep connection alive on server side
    try { ws.send(JSON.stringify({ type: 'PING' })); } catch (_) {}
  }

  // HTTP polling as a fallback to catch any missed events
  pollForUpdates();
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
function initWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(wsReconnectTimer);

  try {
    ws = new WebSocket(CONFIG.WS_URL);

    ws.onopen = () => {
      console.log('✅ WebSocket connected');
      if (userEmail) {
        ws.send(JSON.stringify({ type: 'REGISTER', userEmail }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'EMAIL_OPENED')    handleEmailOpened(data);
        if (data.type === 'TRACKING_UPDATE') handleTrackingUpdate(data);
      } catch (_) {}
    };

    ws.onerror = () => {
      // Schedule silent reconnect (avoid console spam)
      scheduleReconnect();
    };

    ws.onclose = () => {
      console.log('🔌 WebSocket closed — reconnecting in 5s');
      scheduleReconnect();
    };

  } catch (err) {
    console.warn('WebSocket init failed:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(initWebSocket, 5000);
}

// ─── HTTP Polling fallback ────────────────────────────────────────────────────
const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

async function pollForUpdates() {
  if (!userEmail) return;
  try {
    const res  = await fetch(`${CONFIG.BACKEND_URL}/api/tracking/history/${encodeURIComponent(userEmail)}?limit=5`, {
      headers: NGROK_HEADERS
    });
    const json = await res.json();
    if (!json.success || !Array.isArray(json.data)) return;

    chrome.storage.local.get(['notifiedMails'], (store) => {
      const notified = new Set(store.notifiedMails || []);
      json.data.forEach((mail) => {
        const id = String(mail._id);
        if (mail.ticks === 'green' && !notified.has(id)) {
          notified.add(id);
          handleEmailOpened({
            mailId:         mail._id,
            recipientEmail: mail.recipients?.[0]?.email || 'recipient',
            openedAt:       mail.firstOpenedAt,
            subject:        mail.subject
          });
        }
      });
      chrome.storage.local.set({ notifiedMails: [...notified] });
    });
  } catch (_) { /* backend offline — ignore */ }
}

// ─── Event handlers ───────────────────────────────────────────────────────────
async function handleEmailOpened(data) {
  const { mailId, recipientEmail, openedAt, subject } = data;
  console.log(`[Background] Email opened by ${recipientEmail}`);

  showNotification({
    title:   '📬 Email Opened!',
    message: `${recipientEmail} opened: ${subject || 'your email'}`,
    iconUrl: 'icons/icon-128.png'
  });

  // Broadcast to all Gmail tabs (DO NOT save to localStorage)
  broadcastToGmailTabs({
    type: 'EMAIL_OPENED_UPDATE',
    mailId,
    recipientEmail,
    openedAt,
    subject
  });
}

function handleTrackingUpdate(data) {
  const { mailId, status, recipientEmail } = data;
  broadcastToGmailTabs({ type: 'TRACKING_STATUS_UPDATE', mailId, status, recipientEmail });
}

function broadcastToGmailTabs(message) {
  chrome.tabs.query({ url: ['https://mail.google.com/*'] }, (tabs) => {
    tabs.forEach((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => {}));
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────
function showNotification(options) {
  const id = `tracker-${Date.now()}`;
  chrome.notifications.create(id, {
    type:     'basic',
    iconUrl:  options.iconUrl || 'icons/icon-128.png',
    title:    options.title,
    message:  options.message,
    priority: 2
  });
  setTimeout(() => chrome.notifications.clear(id), 6000);
}

// ─── Local event log ──────────────────────────────────────────────────────────
function logEvent(event) {
  chrome.storage.local.get(['events'], (result) => {
    const events = result.events || [];
    events.push({ ...event, timestamp: Date.now() });
    if (events.length > 100) events.shift();
    chrome.storage.local.set({ events });
  });
}

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_CONFIG') {
    sendResponse(CONFIG);

  } else if (request.type === 'UPDATE_CONFIG') {
    const c = request.config || {};
    if (c.backendUrl) CONFIG.BACKEND_URL = c.backendUrl;
    if (c.wsUrl)      CONFIG.WS_URL      = c.wsUrl;
    if (c.userEmail)  userEmail           = c.userEmail;
    // Reconnect with updated config
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    initWebSocket();
    sendResponse({ success: true });

  } else if (request.type === 'SEND_TRACKING_EVENT') {
    sendTrackingEvent(request.data).then(sendResponse);
    return true; // keep channel open for async

  } else if (request.type === 'GET_MAIL_STATUS') {
    const url = `${CONFIG.BACKEND_URL}/api/tracking/status?subject=${encodeURIComponent(request.subject || '')}&recipient=${encodeURIComponent(request.recipientEmail || '')}`;
    fetch(url, { headers: FETCH_HEADERS })
      .then(res => res.json())
      .then(data => sendResponse(data))
      .catch(err => {
        console.error('[Background] Error fetching status:', err);
        sendResponse({ success: false });
      });
    return true; // Keep channel open for async response

  } else if (request.type === 'GET_EVENTS') {
    chrome.storage.local.get(['events'], (result) => {
      sendResponse(result.events || []);
    });
    return true;
  }
});

// ─── Send tracking event to backend ──────────────────────────────────────────
async function sendTrackingEvent(data) {
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/tracking/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── On install ───────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log('✅ Email Tracker Pro installed');
  chrome.storage.local.set({ installDate: new Date().toISOString(), events: [] });
  chrome.runtime.openOptionsPage();
});