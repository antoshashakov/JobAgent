// Utility functions ported from Python

function tokenize(text) {
  const tokens = text.toLowerCase().match(/[A-Za-z0-9+#.-]+/g) || [];
  return tokens.filter(t => t.length > 2);
}

function keywordSet(...texts) {
  const keywords = new Set();
  for (const text of texts) {
    tokenize(text).forEach(k => keywords.add(k));
  }
  return keywords;
}

function scoreJob(jobText, keywords) {
  if (keywords.size === 0) return [0, 0];
  
  const lowerText = jobText.toLowerCase();
  let matched = 0;
  
  for (const keyword of keywords) {
    if (lowerText.includes(keyword)) {
      matched++;
    }
  }
  
  const score = Math.round((matched / keywords.size) * 100);
  return [score, matched];
}

function extractGoogleDocId(link) {
  const match = link.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function parseResumeProfile(cvText) {
  const emailMatch = cvText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const phoneMatch = cvText.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
  
  const lines = cvText.split('\n').map(l => l.trim()).filter(l => l);
  const name = lines[0] || '';
  
  let location = '';
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (['city', 'state', 'country'].some(tok => lines[i].toLowerCase().includes(tok))) {
      location = lines[i];
      break;
    }
  }
  
  return {
    name,
    email: emailMatch ? emailMatch[0] : '',
    phone: phoneMatch ? phoneMatch[0] : '',
    location
  };
}

function safeFilename(value) {
  const cleaned = (value || '').trim().replace(/[^A-Za-z0-9]+/g, '_');
  return cleaned.replace(/^_+|_+$/g, '') || 'Candidate';
}

async function fetchGoogleDocText(link) {
  const docId = extractGoogleDocId(link);
  if (!docId) {
    throw new Error('Invalid Google Doc link');
  }
  
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=docx`;
  
  try {
    const response = await fetch(exportUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    // For simplicity in extension, we'll fetch as text/html
    // In production, you might want to use a backend to convert DOCX to text
    const text = await response.text();
    return text;
  } catch (error) {
    throw new Error(`Failed to fetch Google Doc: ${error.message}`);
  }
}

async function generateWithOpenAI(apiKey, model, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that edits job application documents.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function generateCoverLetter(apiKey, model, job, sourceCoverText) {
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

Candidate cover letter:
${sourceCoverText}
`.trim();

  return generateWithOpenAI(apiKey, model, prompt);
}

async function matchFormFields(apiKey, model, profile, formFields) {
  const prompt = `
Map candidate profile values to application form fields.

Return JSON only with this shape:
{
  "field_id_1": "value",
  "field_id_2": "value"
}

Rules:
- Use profile info only.
- Match fields by label/name/placeholder semantics.
- Skip fields you are not confident about.
- Never include resume/cover uploads or captcha fields.

Candidate profile:
${JSON.stringify(profile, null, 2)}

Fields:
${JSON.stringify(formFields, null, 2)}
`.trim();

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You map application form fields to candidate data and return strict JSON.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

// Storage helpers
async function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

async function setStorage(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, resolve);
  });
}
