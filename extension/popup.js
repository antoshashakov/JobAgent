// Popup UI logic

const TABS = {
  jobs: document.getElementById('jobs'),
  setup: document.getElementById('setup'),
  sources: document.getElementById('sources'),
  settings: document.getElementById('settings')
};

const ELEMENTS = {
  // Jobs
  jobsList: document.getElementById('jobsList'),
  jobsLoading: document.getElementById('jobsLoading'),
  jobsError: document.getElementById('jobsError'),
  jobsErrorText: document.getElementById('jobsErrorText'),
  debugInfo: document.getElementById('debugInfo'),
  dashboardBtn: document.getElementById('dashboardBtn'),

  // Setup
  cvLink: document.getElementById('cvLink'),
  coverLink: document.getElementById('coverLink'),
  saveLinksBtn: document.getElementById('saveLinksBtn'),
  setupStatus: document.getElementById('setupStatus'),

  // Sources
  scrapeStatusText: document.getElementById('scrapeStatusText'),
  refreshJobsBtn: document.getElementById('refreshJobsBtn'),
  regenerateSourcesBtn: document.getElementById('regenerateSourcesBtn'),
  greenhouseList: document.getElementById('greenhouseList'),
  leverList: document.getElementById('leverList'),
  addGreenhouseInput: document.getElementById('addGreenhouseInput'),
  addGreenhouseBtn: document.getElementById('addGreenhouseBtn'),
  addLeverInput: document.getElementById('addLeverInput'),
  addLeverBtn: document.getElementById('addLeverBtn'),
  resetSourcesBtn: document.getElementById('resetSourcesBtn'),
  sourcesStatus: document.getElementById('sourcesStatus'),

  // Settings
  apiKey: document.getElementById('apiKey'),
  modelName: document.getElementById('modelName'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  settingsStatus: document.getElementById('settingsStatus'),

  // Footer
  statusMessage: document.getElementById('statusMessage')
};

// ── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const tabName = e.currentTarget.dataset.tab;
    switchTab(tabName, e.currentTarget);
  });
});

function switchTab(tabName, clickedBtn) {
  Object.values(TABS).forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  TABS[tabName].classList.add('active');
  if (clickedBtn) {
    clickedBtn.classList.add('active');
  } else {
    document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');
  }

  if (tabName === 'jobs') searchJobs();
  if (tabName === 'sources') loadSources();
}

// ── Jobs tab — read from chrome.storage.local ────────────────────────────────

async function searchJobs() {
  ELEMENTS.jobsLoading.style.display = 'block';
  ELEMENTS.jobsList.innerHTML = '';
  ELEMENTS.jobsError.style.display = 'none';
  ELEMENTS.debugInfo.style.display = 'none';

  try {
    const data = await getStorage(['jobs', 'topJobs', 'jobsLastUpdated', 'cvKeywords', 'cvLink', 'apiKey']);
    const allJobs = data.jobs || [];
    const topJobs = data.topJobs || [];
    const keywords = data.cvKeywords || [];

    ELEMENTS.jobsLoading.style.display = 'none';

    // Display AI-ranked top 5 if available, otherwise keyword top 5
    const display = topJobs.length > 0 ? topJobs : allJobs.slice(0, 5);
    const rankedBy = topJobs.length > 0 && data.apiKey ? 'AI-ranked' : 'keyword score';

    // Debug info
    const lastUpdated = data.jobsLastUpdated
      ? new Date(data.jobsLastUpdated).toLocaleString()
      : 'never';
    const debugText = `
      <strong>Debug Info:</strong><br>
      Last scraped: ${lastUpdated}<br>
      CV keywords: ${keywords.length} (${keywords.slice(0, 5).join(', ')}${keywords.length > 5 ? '...' : ''})<br>
      Total jobs in storage: ${allJobs.length}<br>
      Showing: top ${display.length} (${rankedBy})
    `;
    ELEMENTS.debugInfo.innerHTML = debugText;
    ELEMENTS.debugInfo.style.display = 'block';

    if (display.length > 0) {
      displayJobs(display);
    } else if (!data.cvLink) {
      ELEMENTS.jobsList.innerHTML = '<p style="padding: 10px; text-align: center; color: #a0a0a0;">Configure your CV link in "Configure Links", then go to "Sources" and click "Refresh Jobs Now".</p>';
    } else {
      ELEMENTS.jobsList.innerHTML = '<p style="padding: 10px; text-align: center; color: #a0a0a0;">No jobs scraped yet. Go to the "Sources" tab and click "Refresh Jobs Now".</p>';
    }
  } catch (error) {
    console.error('Job search error:', error);
    showJobsError(error.message);
  }
}

function showJobsError(message) {
  ELEMENTS.jobsLoading.style.display = 'none';
  ELEMENTS.jobsError.style.display = 'block';
  ELEMENTS.jobsErrorText.textContent = message;
}

function scoreBadgeHTML(score) {
  if (score == null) return '';
  let cls = 'low';
  if (score >= 50) cls = 'high';
  else if (score >= 25) cls = 'medium';
  return `<span class="score-badge ${cls}">${score}%</span>`;
}

function displayJobs(jobs) {
  ELEMENTS.jobsList.innerHTML = '';
  jobs.forEach(job => {
    const jobEl = document.createElement('div');
    jobEl.className = 'job-item';
    jobEl.innerHTML = `
      <div class="job-item-title">${escapeHtml(job.title)} ${scoreBadgeHTML(job.score)}</div>
      <div class="job-item-company">🏢 ${escapeHtml(job.company)}</div>
      <div class="job-item-location">📍 ${escapeHtml(job.location)}</div>
      <div class="job-item-actions">
        <a href="${job.url}" target="_blank" title="View posting">View ↗</a>
      </div>
    `;
    ELEMENTS.jobsList.appendChild(jobEl);
  });
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text ? text.replace(/[&<>"']/g, m => map[m]) : '';
}

// ── Sources tab ──────────────────────────────────────────────────────────────

async function loadSources() {
  const data = await getStorage(['jobSources', 'jobsLastUpdated', 'jobsLastError']);

  // Scrape status
  if (data.jobsLastUpdated) {
    ELEMENTS.scrapeStatusText.textContent = 'Last scraped: ' + new Date(data.jobsLastUpdated).toLocaleString();
  } else {
    ELEMENTS.scrapeStatusText.textContent = 'Not yet scraped';
  }
  if (data.jobsLastError) {
    ELEMENTS.scrapeStatusText.textContent += ' | Error: ' + data.jobsLastError;
  }

  const sources = data.jobSources || FALLBACK_SOURCES;
  renderSourceList('greenhouse', sources.greenhouse || []);
  renderSourceList('lever', sources.lever || []);
}

function renderSourceList(type, boards) {
  const container = type === 'greenhouse' ? ELEMENTS.greenhouseList : ELEMENTS.leverList;
  container.innerHTML = '';
  boards.forEach((board, idx) => {
    const el = document.createElement('div');
    el.className = 'source-item';
    el.innerHTML = `
      <span>${escapeHtml(board.label || board.token)}</span>
      <button class="remove-btn" data-type="${type}" data-idx="${idx}" title="Remove">×</button>
    `;
    el.querySelector('.remove-btn').addEventListener('click', () => removeSource(type, idx));
    container.appendChild(el);
  });
}

async function addSource(type, token) {
  token = token.trim().toLowerCase();
  if (!token) return;
  const data = await getStorage(['jobSources']);
  const sources = data.jobSources || { greenhouse: [], lever: [] };
  // Avoid duplicates
  if (sources[type].some(b => b.token === token)) return;
  // Look up label from KNOWN_BOARDS
  const known = KNOWN_BOARDS[type].find(b => b.token === token);
  sources[type].push({ token, label: known ? known.label : token });
  await setStorage({ jobSources: sources });
  loadSources();
}

async function removeSource(type, idx) {
  const data = await getStorage(['jobSources']);
  const sources = data.jobSources || { greenhouse: [], lever: [] };
  sources[type].splice(idx, 1);
  await setStorage({ jobSources: sources });
  loadSources();
}

// Sources button handlers
ELEMENTS.addGreenhouseBtn.addEventListener('click', () => {
  addSource('greenhouse', ELEMENTS.addGreenhouseInput.value);
  ELEMENTS.addGreenhouseInput.value = '';
});
ELEMENTS.addLeverBtn.addEventListener('click', () => {
  addSource('lever', ELEMENTS.addLeverInput.value);
  ELEMENTS.addLeverInput.value = '';
});

ELEMENTS.refreshJobsBtn.addEventListener('click', () => {
  ELEMENTS.refreshJobsBtn.disabled = true;
  ELEMENTS.refreshJobsBtn.textContent = 'Scraping...';
  chrome.runtime.sendMessage({ type: 'SCRAPE_NOW' }, () => {
    ELEMENTS.refreshJobsBtn.disabled = false;
    ELEMENTS.refreshJobsBtn.textContent = 'Refresh Jobs Now';
    loadSources();
    showStatus(ELEMENTS.sourcesStatus, 'Jobs refreshed', 'success');
  });
});

ELEMENTS.regenerateSourcesBtn.addEventListener('click', () => {
  ELEMENTS.regenerateSourcesBtn.disabled = true;
  ELEMENTS.regenerateSourcesBtn.textContent = 'Generating...';
  chrome.runtime.sendMessage({ type: 'GENERATE_SOURCES' }, (resp) => {
    ELEMENTS.regenerateSourcesBtn.disabled = false;
    ELEMENTS.regenerateSourcesBtn.textContent = 'Regenerate from Resume';
    if (resp && resp.success) {
      showStatus(ELEMENTS.sourcesStatus, 'Sources regenerated from resume', 'success');
    } else {
      showStatus(ELEMENTS.sourcesStatus, 'Failed: ' + (resp?.error || 'unknown error'), 'error');
    }
    loadSources();
  });
});

ELEMENTS.resetSourcesBtn.addEventListener('click', async () => {
  await setStorage({ jobSources: FALLBACK_SOURCES, sourcesGeneratedFromResume: false });
  loadSources();
  showStatus(ELEMENTS.sourcesStatus, 'Reset to default sources', 'info');
});

// ── Keyword helpers (kept from original) ─────────────────────────────────────

function extractKeywordsFromText(text) {
  const keywords = new Set();
  const lowerText = text.toLowerCase();
  const words = lowerText.match(/\b[a-z0-9+\-\.#]{2,}\b/g) || [];

  const techTerms = ['python', 'javascript', 'typescript', 'react', 'vue', 'angular', 'node', 'nodejs', 'java', 'c#', 'golang', 'rust', 'sql', 'mongodb', 'postgres', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'ai', 'ml', 'machine learning', 'data', 'api', 'rest', 'graphql', 'devops', 'ci/cd', 'git', 'html', 'css', 'jquery', 'spring', 'django', 'flask', 'fastapi', 'pytorch', 'tensorflow', 'firebase', 'redis', 'elasticsearch', 'kafka', 'rabbit', 'agile', 'scrum'];

  for (const term of techTerms) {
    if (lowerText.includes(term)) {
      keywords.add(term);
    }
  }

  const wordFreq = {};
  for (const word of words) {
    if (word.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'your'].includes(word)) {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    }
  }

  for (const [word, freq] of Object.entries(wordFreq)) {
    if (freq >= 1 && keywords.size < 20) {
      keywords.add(word);
    }
  }

  return Array.from(keywords);
}

function extractLocationFromText(text) {
  const locationPatterns = [
    /(?:based in|located in|location:\s*)([A-Za-z\s,]+?)(?:[,\n]|$)/i,
    /(?:toronto|vancouver|calgary|vancouver|montreal|ottawa|winnipeg|london|kitchener)/i,
    /(?:new york|los angeles|san francisco|chicago|boston|seattle|denver|austin|atlanta)/i,
    /(?:remote|work from home|wfh|hybrid)/i
  ];

  for (const pattern of locationPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }

  return null;
}

async function fetchGoogleDocText(link) {
  try {
    const docIdMatch = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!docIdMatch) throw new Error('Invalid Google Doc URL');

    const docId = docIdMatch[1];
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

    const response = await fetch(exportUrl);
    if (!response.ok) throw new Error('Could not fetch document');

    return await response.text();
  } catch (error) {
    console.error('Fetch doc error:', error);
    throw error;
  }
}

// ── Dashboard button ─────────────────────────────────────────────────────────

if (ELEMENTS.dashboardBtn) {
  ELEMENTS.dashboardBtn.addEventListener('click', () => {
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');
    chrome.tabs.create({ url: dashboardUrl });
  });
}

// ── Load / Save settings ─────────────────────────────────────────────────────

async function loadSettings() {
  const data = await getStorage(['apiKey', 'modelName', 'cvLink', 'coverLink']);

  if (data.apiKey) ELEMENTS.apiKey.value = data.apiKey;
  if (data.modelName) ELEMENTS.modelName.value = data.modelName;
  if (data.cvLink) ELEMENTS.cvLink.value = data.cvLink;
  if (data.coverLink) ELEMENTS.coverLink.value = data.coverLink;
}

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

// ── Initialize ───────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();

  // Auto-generate sources from resume if not done yet
  const data = await getStorage(['sourcesGeneratedFromResume', 'apiKey', 'cvLink']);
  if (!data.sourcesGeneratedFromResume && data.apiKey && data.cvLink) {
    console.log('[popup] Sources not yet AI-generated — triggering auto-generation');
    ELEMENTS.jobsLoading.style.display = 'block';
    ELEMENTS.jobsList.innerHTML = '<p style="padding: 10px; text-align: center; color: #a0a0a0;">Discovering companies from your resume...</p>';
    chrome.runtime.sendMessage({ type: 'GENERATE_SOURCES' }, () => {
      console.log('[popup] Auto-generation done, loading jobs');
      searchJobs();
    });
  } else {
    searchJobs();
  }
}

init();
