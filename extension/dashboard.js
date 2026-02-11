let currentJobs = [];
let currentModalJob = null;

console.log('[Dashboard] Initialized');

// Storage utility functions for dashboard
// NOTE: Must use chrome.storage.local to match popup.js which imports from utils.js
async function getStorageData(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      console.log('[Dashboard] Storage.get called with keys:', keys);
      console.log('[Dashboard] Storage.get result:', result);
      console.log('[Dashboard] Keys found in storage:', Object.keys(result));
      resolve(result);
    });
  });
}

async function setStorageData(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, resolve);
  });
}

// Direct OpenAI API call for cover letter generation (no backend required)
async function generateCoverLetterViaOpenAI(apiKey, model, job, cvText, coverTemplate) {
  const prompt = `
You are updating a cover letter for a job application.

Rules:
- Use ONLY the candidate's existing experience and facts. Never invent or exaggerate.
- Preserve the candidate's voice, tone, and formatting as much as possible.
- Make the cover letter more relevant to the job posting using only existing information.
- Fix grammar and professionalism issues, but avoid unnecessary changes.
- Keep line breaks and formatting using these markers only:
  - Bold: **text**
  - Italic: *text*
  - Bold + italic: ***text***
- Output plain text with the markers above. Do not add markdown headings or lists.
- Use only the provided cover letter text. Do not add content from other documents.
- Do NOT include a standalone job title heading at the top.

Job posting:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description:
${job.description}

Candidate CV:
${cvText}

Candidate Cover Letter Template:
${coverTemplate}
`.trim();

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that edits job application documents.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || `OpenAI error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

// Load jobs on page load
document.addEventListener('DOMContentLoaded', () => {
  console.log('[Dashboard] DOMContentLoaded - checking if elements exist');
  console.log('[Dashboard] jobsContainer:', document.getElementById('jobsContainer'));
  console.log('[Dashboard] loadingContainer:', document.getElementById('loadingContainer'));
  console.log('[Dashboard] emptyState:', document.getElementById('emptyState'));
  
  console.log('[Dashboard] DOMContentLoaded - Starting loadJobs()');
  loadJobs();
  // Refresh jobs every 30 seconds
  setInterval(loadJobs, 30000);
  
  // Bind event listeners to modal buttons
  const closeModalBtn = document.getElementById('closeModalBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const doneBtn = document.getElementById('doneBtn');
  
  if (closeModalBtn) closeModalBtn.addEventListener('click', closeCoverLetterModal);
  if (downloadBtn) downloadBtn.addEventListener('click', downloadCoverLetterPDF);
  if (doneBtn) doneBtn.addEventListener('click', closeCoverLetterModal);
});

async function loadJobs() {
  console.log('[Dashboard] loadJobs() called');
  const loading = document.getElementById('loadingContainer');
  const container = document.getElementById('jobsContainer');
  const empty = document.getElementById('emptyState');

  if (!loading || !container || !empty) {
    console.error('[Dashboard] Required elements not found!', { loading, container, empty });
    return;
  }

  loading.style.display = 'block';
  container.innerHTML = '';
  empty.style.display = 'none';

  try {
    const data = await getStorageData(['jobs', 'topJobs']);
    const jobs = (data.topJobs && data.topJobs.length > 0)
      ? data.topJobs
      : (data.jobs || []).slice(0, 5);

    loading.style.display = 'none';

    if (jobs.length > 0) {
      console.log('[Dashboard] Jobs loaded from storage, count:', jobs.length);
      currentJobs = jobs;
      renderJobs(jobs);
    } else {
      console.warn('[Dashboard] No jobs found in storage');
      empty.style.display = 'block';
      showStatus('No jobs available. Open the extension popup → Sources tab → click "Refresh Jobs Now".', 'info');
    }
  } catch (error) {
    console.error('[Dashboard] Error loading jobs:', error);
    loading.style.display = 'none';
    empty.style.display = 'block';
    showStatus('Error loading jobs: ' + error.message, 'error');
  }
}

function renderJobs(jobs) {
  const container = document.getElementById('jobsContainer');
  container.innerHTML = '';

  if (!jobs || jobs.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    return;
  }

  jobs.forEach(job => {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <h3>${escapeHtml(job.title)}</h3>
      <div class="job-meta">
        <span>🏢 ${escapeHtml(job.company)}</span>
        <span>📍 ${escapeHtml(job.location)}</span>
      </div>
      <div class="job-actions">
        <a href="${job.url}" target="_blank" class="btn btn-link">View Posting ↗</a>
        <button class="btn btn-primary generate-cover-btn" data-job-id="${job.id}">✨ Generate Cover Letter</button>
      </div>
    `;
    container.appendChild(card);
    
    // Bind event listener to the button
    const btn = card.querySelector('.generate-cover-btn');
    btn.addEventListener('click', () => openCoverLetterModal(job.id));
  });
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text ? text.replace(/[&<>"']/g, m => map[m]) : '';
}

function openCoverLetterModal(jobId) {
  const job = currentJobs.find(j => j.id === jobId);
  if (!job) return;

  currentModalJob = job;
  document.getElementById('modalJobTitle').value = `${job.title} at ${job.company}`;
  document.getElementById('coverLetterTitle').value = 'Cover Letter';
  document.getElementById('coverLetterText').value = '';
  document.getElementById('modalStatus').innerHTML = '';

  const modal = document.getElementById('coverLetterModal');
  modal.style.display = 'block';

  // Auto-generate cover letter
  generateCoverLetterContent(jobId);
}

function closeCoverLetterModal() {
  const modal = document.getElementById('coverLetterModal');
  modal.style.display = 'none';
  currentModalJob = null;
}

async function generateCoverLetterContent(jobId) {
  if (!currentModalJob) return;

  const textarea = document.getElementById('coverLetterText');
  const statusDiv = document.getElementById('modalStatus');

  statusDiv.innerHTML = '<div class="status-message info"><div class="spinner-inline"></div> Initializing...</div>';
  textarea.value = '';

  try {
    // Get user's stored documents from extension storage
    console.log('[Dashboard] Getting stored settings...');
    const storedData = await getStorageData(['cvLink', 'coverLink', 'apiKey', 'modelName']);
    console.log('[Dashboard] Stored data keys:', Object.keys(storedData));

    if (!storedData.cvLink || !storedData.coverLink) {
      const missingLinks = [];
      if (!storedData.cvLink) missingLinks.push('CV link');
      if (!storedData.coverLink) missingLinks.push('Cover Letter template link');
      
      const errorMsg = `Please configure ${missingLinks.join(' and ')} in the extension "Configure Links" tab.`;
      console.error('[Dashboard]', errorMsg);
      statusDiv.innerHTML = `<div class="status-message error">${errorMsg}</div>`;
      return;
    }

    if (!storedData.apiKey) {
      const errorMsg = 'Please configure your OpenAI API key in the "AI Settings" tab.';
      console.error('[Dashboard]', errorMsg);
      statusDiv.innerHTML = `<div class="status-message error">${errorMsg}</div>`;
      return;
    }

    // Fetch CV and cover letter templates
    console.log('[Dashboard] Fetching CV document...');
    statusDiv.innerHTML = '<div class="status-message info"><div class="spinner-inline"></div> Fetching your CV...</div>';
    
    const cvText = await fetchGoogleDocText(storedData.cvLink);
    console.log('[Dashboard] CV fetched, length:', cvText.length);
    
    console.log('[Dashboard] Fetching cover letter template...');
    statusDiv.innerHTML = '<div class="status-message info"><div class="spinner-inline"></div> Fetching your cover letter template...</div>';
    const coverTemplate = await fetchGoogleDocText(storedData.coverLink);
    console.log('[Dashboard] Cover template fetched, length:', coverTemplate.length);

    // Call API to generate cover letter
    console.log('[Dashboard] Calling API to generate cover letter...');
    statusDiv.innerHTML = '<div class="status-message info"><div class="spinner-inline"></div> Generating with AI...</div>';
    
    let coverLetter;
    
    // Try OpenAI API directly first
    try {
      coverLetter = await generateCoverLetterViaOpenAI(
        storedData.apiKey,
        storedData.modelName || 'gpt-4o-mini',
        currentModalJob,
        cvText,
        coverTemplate
      );
    } catch (openaiError) {
      console.log('[Dashboard] OpenAI direct call failed:', openaiError.message);
      throw openaiError;
    }

    if (coverLetter) {
      console.log('[Dashboard] Cover letter generated successfully');
      textarea.value = coverLetter;
      statusDiv.innerHTML = '<div class="status-message success">✓ Personalized cover letter generated!</div>';
    } else {
      throw new Error('No cover letter generated');
    }
  } catch (error) {
    console.error('[Dashboard] Cover letter generation error:', error);
    statusDiv.innerHTML = `<div class="status-message error">Error: ${error.message}</div>`;
    textarea.value = `Failed to generate cover letter: ${error.message}`;
  }
}

async function fetchGoogleDocText(link) {
  try {
    console.log('[Dashboard] Fetching Google Doc from:', link);
    
    // Extract doc ID from the link
    const docIdMatch = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!docIdMatch) {
      throw new Error('Invalid Google Doc link');
    }
    
    const docId = docIdMatch[1];
    console.log('[Dashboard] Extracted doc ID:', docId);
    
    // Try .txt export first (simpler format)
    let exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    let response = await fetch(exportUrl);
    
    if (response.ok) {
      const text = await response.text();
      console.log('[Dashboard] Successfully fetched as TXT, length:', text.length);
      return text;
    }
    
    // Fall back to .docx if .txt fails
    console.log('[Dashboard] TXT export failed, trying DOCX...');
    exportUrl = `https://docs.google.com/document/d/${docId}/export?format=docx`;
    response = await fetch(exportUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch document: HTTP ${response.status}`);
    }
    
    // For DOCX, we'll just return a message that it should be plaintext
    // In production, you'd want to parse the DOCX
    const text = await response.text();
    console.log('[Dashboard] Successfully fetched as DOCX, length:', text.length);
    return text;
    
  } catch (error) {
    console.error('Error fetching Google Doc:', error);
    throw new Error(`Could not fetch document: ${error.message}`);
  }
}

function downloadCoverLetterPDF() {
  const title = document.getElementById('coverLetterTitle').value;
  const text = document.getElementById('coverLetterText').value;

  if (!text.trim()) {
    showStatus('Please generate or write a cover letter first', 'error');
    return;
  }

  // Create a simple PDF
  const pdfContent = createSimplePDF(text);
  
  // Download as PDF with filename from title field
  const element = document.createElement('a');
  element.setAttribute('href', 'data:application/pdf;base64,' + pdfContent);
  const filename = title.trim() ? `${title}.pdf` : 'Cover_Letter.pdf';
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);

  showStatus('Cover letter downloaded as PDF', 'success');
}

function normalizeTextForPDF(text) {
  // Convert problematic Unicode characters to ASCII equivalents
  // This fixes encoding issues like smart quotes, dashes, etc.
  return text
    .replace(/[\u2018\u2019]/g, "'")      // Smart quotes → regular quote
    .replace(/[\u201C\u201D]/g, '"')      // Smart double quotes → regular quotes
    .replace(/[\u2013\u2014]/g, '-')       // En dash, em dash → hyphen
    .replace(/\u2026/g, '...')            // Ellipsis → three dots
    .replace(/\u00AE/g, '(R)')            // Registered trademark
    .replace(/\u00A9/g, '(C)')            // Copyright symbol
    .replace(/\u2122/g, '(TM)')           // Trademark symbol
    .replace(/[\u00E0-\u00FF]/g, c => {   // Handle accented characters
      const map = {
        'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
        'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
        'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
        'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
        'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
        'ç': 'c', 'ñ': 'n'
      };
      return map[c] || c;
    });
}

function createSimplePDF(text) {
  // Create a very basic PDF from text
  // This is a minimal but functional PDF generator
  
  // Normalize text to avoid character encoding issues
  text = normalizeTextForPDF(text);
  
  const lines = text.split('\n');
  const width = 612;   // Letter width in points
  const height = 792;  // Letter height in points
  const margin = 40;
  const lineHeight = 12;
  const fontSize = 11;
  const charsPerLine = 80;
  
  // Wrap text
  const wrappedLines = [];
  lines.forEach(line => {
    if (line.length === 0) {
      wrappedLines.push('');
    } else {
      let currentLine = '';
      const words = line.split(' ');
      words.forEach(word => {
        if ((currentLine + ' ' + word).trim().length <= charsPerLine) {
          currentLine = (currentLine + ' ' + word).trim();
        } else {
          if (currentLine) wrappedLines.push(currentLine);
          currentLine = word;
        }
      });
      if (currentLine) wrappedLines.push(currentLine);
    }
  });
  
  // Create PDF content
  let pdfContent = '%PDF-1.4\n';
  const objects = [];
  
  // Object 1: Catalog
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  
  // Object 2: Pages
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  
  // Object 3: Page
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n');
  
  // Object 4: Content stream
  let contentStream = 'BT\n/F1 11 Tf\n40 750 Td\n12 TL\n';
  wrappedLines.forEach(line => {
    const escapedLine = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    contentStream += `(${escapedLine}) Tj\nT*\n`;
  });
  contentStream += 'ET\n';
  
  const contentLength = contentStream.length;
  objects.push(`4 0 obj\n<< /Length ${contentLength} >>\nstream\n${contentStream}endstream\nendobj\n`);
  
  // Object 5: Font - Using Times-Roman for better character support and professional appearance
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>\nendobj\n');
  
  // Build PDF
  let offset = pdfContent.length;
  const offsets = [offset];
  
  objects.forEach(obj => {
    offset += obj.length;
    offsets.push(offset);
    pdfContent += obj;
  });
  
  // Xref table
  const xrefOffset = pdfContent.length;
  pdfContent += 'xref\n';
  pdfContent += '0 ' + (objects.length + 1) + '\n';
  pdfContent += '0000000000 65535 f \n';
  
  offsets.slice(1).forEach(off => {
    pdfContent += String(off).padStart(10, '0') + ' 00000 n \n';
  });
  
  pdfContent += 'trailer\n';
  pdfContent += '<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
  pdfContent += 'startxref\n' + xrefOffset + '\n%%EOF';
  
  // Encode as base64
  return btoa(unescape(encodeURIComponent(pdfContent)));
}

function showStatus(message, type = 'info') {
  const container = document.getElementById('statusContainer');
  const div = document.createElement('div');
  div.className = `status-message ${type}`;
  div.textContent = message;
  container.appendChild(div);

  setTimeout(() => {
    div.remove();
  }, 5000);
}

// Close modal when clicking outside of it
window.onclick = function(event) {
  const modal = document.getElementById('coverLetterModal');
  if (event.target === modal) {
    closeCoverLetterModal();
  }
};
