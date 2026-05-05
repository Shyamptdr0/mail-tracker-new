// popup.js - Popup script for Email Tracker Extension

let events = [];
let wsConnected = false;

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  loadEvents();
  setupWebSocketListener();
  setupEventListeners();
  updateTimeAgo();
  
  // Update time every 10 seconds
  setInterval(updateTimeAgo, 10000);
});

// Setup event listeners
function setupEventListeners() {
  const settingsBtn = document.querySelector('.settings-btn');
  settingsBtn.addEventListener('click', openSettings);
}

// Load events from background script
function loadEvents() {
  chrome.runtime.sendMessage({ type: 'GET_EVENTS' }, (response) => {
    events = response || [];
    displayEvents();
    updateStats();
  });
}

// Display events in activity list
function displayEvents() {
  const activityList = document.getElementById('activityList');
  
  if (events.length === 0) {
    activityList.innerHTML = `
      <div class="empty-state">
        <p>📭 No activity yet</p>
        <small>Track your first email to see activity</small>
      </div>
    `;
    return;
  }

  activityList.innerHTML = '';
  
  // Show latest events first
  const sortedEvents = [...events].reverse().slice(0, 10);
  
  sortedEvents.forEach((event) => {
    const activityItem = document.createElement('div');
    activityItem.className = `activity-item ${event.type === 'OPENED' ? 'opened' : 'sent'}`;
    
    const timeAgo = getTimeAgo(event.timestamp);
    const statusBadge = event.type === 'OPENED' ? 'opened' : 'sent';
    
    activityItem.innerHTML = `
      <div class="activity-email">${event.recipientEmail || 'Unknown'}</div>
      <div class="activity-time">
        <span>${timeAgo}</span>
        <span class="activity-status ${statusBadge}">${event.type === 'OPENED' ? '✓ Opened' : '↗ Sent'}</span>
      </div>
    `;
    
    activityList.appendChild(activityItem);
  });
}

// Update statistics
function updateStats() {
  const totalSent = events.filter(e => e.type === 'SENT').length;
  const totalOpened = events.filter(e => e.type === 'OPENED').length;
  const openRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0;
  
  document.getElementById('totalSent').textContent = totalSent;
  document.getElementById('totalOpened').textContent = totalOpened;
  document.getElementById('openRate').textContent = openRate + '%';
}

// Setup WebSocket listener
function setupWebSocketListener() {
  // Check WebSocket status periodically
  setInterval(() => {
    updateWSStatus();
  }, 2000);
  
  updateWSStatus();
}

// Update WebSocket status indicator
function updateWSStatus() {
  // In a real implementation, you'd query the background script for WS status
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  
  // For now, show connected if background script is responding
  chrome.runtime.sendMessage(
    { type: 'GET_CONFIG' },
    (response) => {
      if (response) {
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
        wsConnected = true;
      }
    }
  );
}

// Get time ago string
function getTimeAgo(timestamp) {
  if (!timestamp) return 'Just now';
  
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// Update time ago display
function updateTimeAgo() {
  const lastUpdateEl = document.getElementById('lastUpdate');
  const now = new Date();
  const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  lastUpdateEl.textContent = timeString;
}

// Open settings page
function openSettings() {
  chrome.runtime.openOptionsPage();
}

// Listen for updates from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EVENT_UPDATED') {
    loadEvents();
  }
});

// Refresh events when popup is opened
chrome.windows.getCurrent((currentWindow) => {
  if (currentWindow.state === 'focused') {
    loadEvents();
  }
});