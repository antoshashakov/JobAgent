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

// Smart keyword extraction — focuses on tech terms and meaningful words
function extractSmartKeywords(text) {
  const keywords = new Set();
  const lowerText = text.toLowerCase();

  const techTerms = [
    'python', 'javascript', 'typescript', 'react', 'vue', 'angular', 'node',
    'nodejs', 'java', 'c#', 'c++', 'golang', 'rust', 'swift', 'kotlin',
    'ruby', 'php', 'scala', 'sql', 'nosql', 'mongodb', 'postgres',
    'postgresql', 'mysql', 'redis', 'elasticsearch', 'kafka',
    'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform',
    'ai', 'ml', 'machine learning', 'deep learning', 'nlp', 'llm',
    'data', 'analytics', 'api', 'rest', 'graphql', 'grpc',
    'devops', 'ci/cd', 'git', 'linux',
    'html', 'css', 'sass', 'tailwind',
    'spring', 'django', 'flask', 'fastapi', 'express', 'rails',
    'pytorch', 'tensorflow', 'pandas', 'numpy', 'spark',
    'firebase', 'supabase', 'vercel', 'netlify',
    'agile', 'scrum', 'kanban',
    'frontend', 'backend', 'fullstack', 'full-stack', 'full stack',
    'mobile', 'ios', 'android', 'react native', 'flutter',
    'cloud', 'microservices', 'distributed', 'scalable',
    'security', 'encryption', 'oauth', 'saml',
    'product', 'design', 'ux', 'figma',
    'fintech', 'healthtech', 'edtech', 'saas', 'b2b', 'b2c',
    'startup', 'enterprise',
  ];

  for (const term of techTerms) {
    if (lowerText.includes(term)) {
      keywords.add(term);
    }
  }

  // Add role-related terms from the CV
  const roleTerms = [
    'engineer', 'developer', 'architect', 'manager', 'lead', 'senior',
    'staff', 'principal', 'director', 'analyst', 'scientist', 'consultant',
    'intern', 'junior', 'mid-level',
  ];
  for (const term of roleTerms) {
    if (lowerText.includes(term)) {
      keywords.add(term);
    }
  }

  return Array.from(keywords);
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

// Known Greenhouse / Lever board tokens (verified public career pages)
// Known boards — only tokens verified against the live APIs.
// Greenhouse: boards-api.greenhouse.io/v1/boards/{token}/jobs
// Lever: api.lever.co/v0/postings/{handle}?mode=json
const KNOWN_BOARDS = {
  greenhouse: [
    { token: "airtable", label: "Airtable" },
    { token: "brex", label: "Brex" },
    { token: "cloudflare", label: "Cloudflare" },
    { token: "coinbase", label: "Coinbase" },
    { token: "databricks", label: "Databricks" },
    { token: "discord", label: "Discord" },
    { token: "duolingo", label: "Duolingo" },
    { token: "figma", label: "Figma" },
    { token: "gusto", label: "Gusto" },
    { token: "instacart", label: "Instacart" },
    { token: "lyft", label: "Lyft" },
    { token: "mongodb", label: "MongoDB" },
    { token: "robinhood", label: "Robinhood" },
    { token: "roblox", label: "Roblox" },
    { token: "samsara", label: "Samsara" },
    { token: "scaleai", label: "Scale AI" },
    { token: "squarespace", label: "Squarespace" },
    { token: "verkada", label: "Verkada" },
  ],
  lever: [
    { token: "palantir", label: "Palantir" },
    { token: "veeva", label: "Veeva Systems" },
    { token: "metabase", label: "Metabase" },
    { token: "whoop", label: "WHOOP" },
    { token: "voleon", label: "The Voleon Group" },
    { token: "weride", label: "WeRide" },
  ]
};

const FALLBACK_SOURCES = {
  greenhouse: [
    { token: "mongodb", label: "MongoDB" },
    { token: "cloudflare", label: "Cloudflare" },
    { token: "coinbase", label: "Coinbase" },
  ],
  lever: [
    { token: "palantir", label: "Palantir" },
    { token: "metabase", label: "Metabase" },
  ]
};
