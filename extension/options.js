// options.js - Options page script

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupEventListeners();
});

// Load saved settings
function loadSettings() {
  chrome.storage.sync.get(
    {
      backendUrl: 'http://localhost:5000',
      wsUrl: 'ws://localhost:5000',
      userEmail: '',
      apiKey: '',
      desktopNotifications: true,
      soundNotifications: true,
      notificationTimeout: 5,
      autoTrack: true,
      debugMode: false
    },
    (items) => {
      document.getElementById('backendUrl').value = items.backendUrl;
      document.getElementById('wsUrl').value = items.wsUrl;
      document.getElementById('userEmail').value = items.userEmail;
      document.getElementById('apiKey').value = items.apiKey;
      document.getElementById('desktopNotifications').checked = items.desktopNotifications;
      document.getElementById('soundNotifications').checked = items.soundNotifications;
      document.getElementById('notificationTimeout').value = items.notificationTimeout;
      document.getElementById('autoTrack').checked = items.autoTrack;
      document.getElementById('debugMode').checked = items.debugMode;
    }
  );
}

// Setup event listeners
function setupEventListeners() {
  const saveBtn = document.getElementById('saveBtn');
  const resetBtn = document.getElementById('resetBtn');
  const successMessage = document.getElementById('successMessage');

  saveBtn.addEventListener('click', () => {
    saveSettings();
    showSuccessMessage();
  });

  resetBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to reset all settings to default?')) {
      resetSettings();
    }
  });

  // Allow Enter key to save
  document.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      saveSettings();
      showSuccessMessage();
    }
  });
}

// Save settings
function saveSettings() {
  const settings = {
    backendUrl: document.getElementById('backendUrl').value,
    wsUrl: document.getElementById('wsUrl').value,
    userEmail: document.getElementById('userEmail').value,
    apiKey: document.getElementById('apiKey').value,
    desktopNotifications: document.getElementById('desktopNotifications').checked,
    soundNotifications: document.getElementById('soundNotifications').checked,
    notificationTimeout: parseInt(document.getElementById('notificationTimeout').value) || 5,
    autoTrack: document.getElementById('autoTrack').checked,
    debugMode: document.getElementById('debugMode').checked
  };

  chrome.storage.sync.set(settings, () => {
    console.log('✅ Settings saved:', settings);

    // Also save to local storage
    chrome.storage.local.set(settings);

    // Update background script config
    chrome.runtime.sendMessage({
      type: 'UPDATE_CONFIG',
      config: settings
    }).catch(() => { });
  });
}

// Reset settings to default
function resetSettings() {
  const defaults = {
    backendUrl: 'http://localhost:5000',
    wsUrl: 'ws://localhost:5000',
    userEmail: '',
    apiKey: '',
    desktopNotifications: true,
    soundNotifications: true,
    notificationTimeout: 5,
    autoTrack: true,
    debugMode: false
  };

  chrome.storage.sync.set(defaults, () => {
    chrome.storage.local.set(defaults);
    loadSettings();
    showSuccessMessage('Settings reset to defaults');
  });
}

// Show success message
function showSuccessMessage(message = 'Settings saved successfully!') {
  const successMessage = document.getElementById('successMessage');
  successMessage.textContent = '✓ ' + message;
  successMessage.classList.add('show');

  setTimeout(() => {
    successMessage.classList.remove('show');
  }, 3000);
}

// Validate settings before saving
function validateSettings() {
  const backendUrl = document.getElementById('backendUrl').value;
  const wsUrl = document.getElementById('wsUrl').value;
  const notificationTimeout = document.getElementById('notificationTimeout').value;

  if (!backendUrl || !backendUrl.startsWith('http')) {
    alert('Invalid Backend URL');
    return false;
  }

  if (!wsUrl || !wsUrl.startsWith('ws')) {
    alert('Invalid WebSocket URL');
    return false;
  }

  if (isNaN(notificationTimeout) || notificationTimeout < 1) {
    alert('Notification timeout must be a positive number');
    return false;
  }

  return true;
}

// Test connection
function testConnection() {
  const backendUrl = document.getElementById('backendUrl').value;

  if (!validateSettings()) return;

  console.log('🔗 Testing connection to:', backendUrl);

  fetch(`${backendUrl}/api/health`)
    .then(response => response.json())
    .then(data => {
      if (data.status === 'ok') {
        alert('✅ Connection successful!');
      } else {
        alert('⚠️ Connection responded but with unexpected status');
      }
    })
    .catch(error => {
      alert('❌ Connection failed: ' + error.message);
    });
}