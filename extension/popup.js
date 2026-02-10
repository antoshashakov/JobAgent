// Popup UI logic

const TABS = {
  jobs: document.getElementById('jobs'),
  setup: document.getElementById('setup'),
  settings: document.getElementById('settings')
};

const ELEMENTS = {
  // Jobs
  jobsList: document.getElementById('jobsList'),
  jobsLoading: document.getElementById('jobsLoading'),
  jobsError: document.getElementById('jobsError'),
  dashboardBtn: document.getElementById('dashboardBtn'),
  
  // Setup
  cvLink: document.getElementById('cvLink'),
  coverLink: document.getElementById('coverLink'),
  saveLinksBtn: document.getElementById('saveLinksBtn'),
  setupStatus: document.getElementById('setupStatus'),
  
  // Settings
  apiKey: document.getElementById('apiKey'),
  modelName: document.getElementById('modelName'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  settingsStatus: document.getElementById('settingsStatus'),
  
  // Footer
  statusMessage: document.getElementById('statusMessage')
};

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const tabName = e.target.dataset.tab;
    switchTab(tabName);
  });
});

function switchTab(tabName) {
  Object.values(TABS).forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  
  TABS[tabName].classList.add('active');
  event.target.classList.add('active');
  
  // Load jobs when switching to jobs tab
  if (tabName === 'jobs') {
    loadJobs();
  }
}

// Load jobs from API
async function loadJobs() {
  ELEMENTS.jobsLoading.style.display = 'block';
  ELEMENTS.jobsList.innerHTML = '';
  ELEMENTS.jobsError.style.display = 'none';
  
  try {
    const response = await fetch('http://localhost:5000/api/jobs/top5');
    const data = await response.json();
    
    ELEMENTS.jobsLoading.style.display = 'none';
    
    if (data.success && data.jobs.length > 0) {
      displayJobs(data.jobs);
      ELEMENTS.jobsError.style.display = 'none';
    } else {
      ELEMENTS.jobsError.style.display = 'block';
    }
  } catch (error) {
    console.error('Failed to load jobs:', error);
    ELEMENTS.jobsLoading.style.display = 'none';
    ELEMENTS.jobsError.style.display = 'block';
  }
}

function displayJobs(jobs) {
  ELEMENTS.jobsList.innerHTML = '';
  jobs.forEach(job => {
    const jobEl = document.createElement('div');
    jobEl.className = 'job-item';
    jobEl.innerHTML = `
      <div class="job-item-title">${job.title}</div>
      <div class="job-item-company">🏢 ${job.company}</div>
      <div class="job-item-location">📍 ${job.location}</div>
      <div class="job-item-actions">
        <a href="${job.url}" target="_blank" title="View posting">View ↗</a>
      </div>
    `;
    ELEMENTS.jobsList.appendChild(jobEl);
  });
}

// Dashboard button
if (ELEMENTS.dashboardBtn) {
  ELEMENTS.dashboardBtn.addEventListener('click', () => {
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');
    chrome.tabs.create({ url: dashboardUrl });
  });
}

// Load settings on popup open
async function loadSettings() {
  const data = await getStorage(['apiKey', 'modelName', 'cvLink', 'coverLink']);
  
  if (data.apiKey) ELEMENTS.apiKey.value = data.apiKey;
  if (data.modelName) ELEMENTS.modelName.value = data.modelName;
  if (data.cvLink) ELEMENTS.cvLink.value = data.cvLink;
  if (data.coverLink) ELEMENTS.coverLink.value = data.coverLink;
}

// Setup tab
ELEMENTS.saveLinksBtn.addEventListener('click', async () => {
  const cvLink = ELEMENTS.cvLink.value.trim();
  const coverLink = ELEMENTS.coverLink.value.trim();
  
  if (!cvLink || !coverLink) {
    showStatus(ELEMENTS.setupStatus, 'Please enter both links', 'error');
    return;
  }
  
  await setStorage({ cvLink, coverLink });
  showStatus(ELEMENTS.setupStatus, 'Links saved successfully', 'success');
});

// Settings tab
ELEMENTS.saveSettingsBtn.addEventListener('click', async () => {
  const apiKey = ELEMENTS.apiKey.value.trim();
  const modelName = ELEMENTS.modelName.value;
  
  if (!apiKey) {
    showStatus(ELEMENTS.settingsStatus, 'Please enter your API key', 'error');
    return;
  }
  
  await setStorage({ apiKey, modelName });
  showStatus(ELEMENTS.settingsStatus, 'Settings saved successfully', 'success');
});

function showStatus(element, message, type) {
  element.textContent = message;
  element.className = `status ${type}`;
}

// Initialize
loadSettings();
loadJobs();

// Refresh jobs when switching to jobs tab
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (e.target.dataset.tab === 'jobs') {
      loadJobs();
    }
  });
});
