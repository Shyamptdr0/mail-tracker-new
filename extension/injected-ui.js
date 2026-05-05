// Gmail Mail Tracker Content Script
// Injects UI elements and tracking logic into Gmail

(function() {
  'use strict';

  // Configuration
  const config = {
    checkInterval: 1000,
    maxRetries: 10,
    retryDelay: 500
  };

  // Track injected emails to avoid duplicates
  const injectedEmails = new Set();
  let backendUrl = 'http://localhost:5000';
  let userId = '';

  // Initialize
  async function init() {
    console.log('[Gmail Tracker] Initializing...');
    
    await loadSettings();
    injectTrackingCSS();
    startMonitoringCompose();
    startMonitoringEmailList();
    
    console.log('[Gmail Tracker] Initialized');
  }

  // Load settings from storage
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['backendUrl', 'userId'], (result) => {
        backendUrl = result.backendUrl || 'http://localhost:5000';
        userId = result.userId || '';
        resolve();
      });
    });
  }

  // Inject CSS for tracking indicators
  function injectTrackingCSS() {
    const style = document.createElement('style');
    style.textContent = `
      /* Gmail Tracker Styles */
      .gmail-tracker-status {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
        margin-left: 8px;
        background: rgba(0,0,0,0.05);
      }

      .gmail-tracker-tick {
        font-size: 13px;
        font-weight: bold;
      }

      .gmail-tracker-tick.unopened {
        color: #9ca3af;
      }

      .gmail-tracker-tick.opened {
        color: #4ade80;
        animation: tickPulse 0.6s ease-out;
      }

      .gmail-tracker-timestamp {
        font-size: 11px;
        color: #666;
      }

      @keyframes tickPulse {
        0% {
          transform: scale(1);
        }
        50% {
          transform: scale(1.3);
        }
        100% {
          transform: scale(1);
        }
      }

      .gmail-tracker-compose-btn {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        padding: 10px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        margin-top: 10px;
        transition: all 0.3s;
      }

      .gmail-tracker-compose-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      }

      .gmail-tracker-info {
        background: #f0f4ff;
        border-left: 3px solid #667eea;
        padding: 12px;
        margin-top: 12px;
        border-radius: 4px;
        font-size: 12px;
        color: #333;
      }

      .gmail-tracker-spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid #667eea;
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Monitor Gmail compose window
  function startMonitoringCompose() {
    // Check for compose window every 2 seconds
    setInterval(() => {
      const composeAreas = document.querySelectorAll('[role="dialog"][aria-label*="ompose"]');
      
      composeAreas.forEach((compose) => {
        if (!compose.getAttribute('data-tracker-initialized')) {
          initializeCompose(compose);
        }
      });
    }, 2000);
  }

  // Initialize compose window with tracking
  function initializeCompose(composeWindow) {
    console.log('[Gmail Tracker] Initializing compose window');
    
    composeWindow.setAttribute('data-tracker-initialized', 'true');

    // Wait for compose to fully load
    setTimeout(() => {
      const sendButton = findSendButton(composeWindow);
      
      if (sendButton) {
        addTrackingInfoToCompose(composeWindow, sendButton);
      }
    }, 500);
  }

  // Find send button in compose
  function findSendButton(composeWindow) {
    const buttons = composeWindow.querySelectorAll('button');
    
    for (let btn of buttons) {
      if (btn.getAttribute('aria-label')?.includes('Send') ||
          btn.textContent.includes('Send') ||
          btn.title?.includes('Send')) {
        return btn;
      }
    }
    
    return null;
  }

  // Add tracking info to compose area
  function addTrackingInfoToCompose(composeWindow, sendButton) {
    // Create info box
    const infoBox = document.createElement('div');
    infoBox.className = 'gmail-tracker-info';
    infoBox.innerHTML = `
      📧 Email Tracking Enabled
      <br>
      <small>You'll receive notifications when recipients open this email</small>
    `;

    // Insert before send button
    sendButton.parentElement?.insertBefore(infoBox, sendButton);

    // Intercept send
    const originalOnClick = sendButton.onclick;
    sendButton.addEventListener('click', (e) => {
      setTimeout(() => {
        captureComposedEmail(composeWindow);
      }, 1000);
    });
  }

  // Capture composed email data
  function captureComposedEmail(composeWindow) {
    const toField = composeWindow.querySelector('[aria-label="To"]');
    const ccField = composeWindow.querySelector('[aria-label="Cc"]');
    const subjectField = composeWindow.querySelector('[aria-label="Subject"]');
    const bodyField = composeWindow.querySelector('[role="textbox"][aria-label="Message body"]');

    if (!toField || !subjectField) return;

    const recipients = toField.textContent?.trim().split(',').map(e => e.trim()) || [];
    const subject = subjectField.value || subjectField.textContent || '';
    const body = bodyField?.innerText || bodyField?.value || '';

    console.log('[Gmail Tracker] Email captured:', {
      recipients,
      subject,
      bodyLength: body.length
    });

    // Register with backend
    registerEmailsWithBackend(recipients, subject, body);
  }

  // Register emails with backend
  async function registerEmailsWithBackend(recipients, subject, body) {
    if (!userId) {
      console.warn('[Gmail Tracker] User ID not configured');
      return;
    }

    for (let recipient of recipients) {
      try {
        const response = await fetch(`${backendUrl}/api/emails/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userId,
            recipient: recipient.trim(),
            subject,
            body,
            sentAt: new Date().toISOString()
          })
        });

        const data = await response.json();
        console.log('[Gmail Tracker] Email registered:', data);
      } catch (error) {
        console.error('[Gmail Tracker] Error registering email:', error);
      }
    }
  }

  // Monitor email list for tracking indicators
  function startMonitoringEmailList() {
    const observer = new MutationObserver(() => {
      const emailRows = document.querySelectorAll('[role="option"][data-drag-id]');
      
      emailRows.forEach((row) => {
        const rowId = row.getAttribute('data-drag-id');
        
        if (rowId && !injectedEmails.has(rowId)) {
          injectTrackingIndicator(row, rowId);
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false
    });
  }

  // Inject tracking indicator into email row
  function injectTrackingIndicator(emailRow, rowId) {
    injectedEmails.add(rowId);
    
    // Try to find subject cell
    const subjectCell = emailRow.querySelector('[role="gridcell"]');
    
    if (subjectCell && !subjectCell.querySelector('.gmail-tracker-status')) {
      const indicator = document.createElement('span');
      indicator.className = 'gmail-tracker-status';
      indicator.innerHTML = `
        <span class="gmail-tracker-tick unopened">✓</span>
        <small>Tracking</small>
      `;
      
      subjectCell.appendChild(indicator);
    }
  }

  // Start monitoring
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose API for background script
  window.gmailTrackerAPI = {
    captureEmail: captureComposedEmail,
    registerEmail: registerEmailsWithBackend,
    updateIndicator: updateEmailIndicator
  };

  function updateEmailIndicator(recipient, isOpened) {
    console.log(`[Gmail Tracker] Email from ${recipient} ${isOpened ? 'opened' : 'not opened'}`);
    
    // Find email row with recipient
    const rows = document.querySelectorAll('[role="option"]');
    rows.forEach((row) => {
      if (row.textContent.includes(recipient)) {
        const tick = row.querySelector('.gmail-tracker-tick');
        if (tick) {
          if (isOpened) {
            tick.classList.remove('unopened');
            tick.classList.add('opened');
            tick.textContent = '✓✓';
          }
        }
      }
    });
  }
})();