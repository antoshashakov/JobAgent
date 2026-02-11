/**
 * Background Service Worker — Job scraping engine
 */
importScripts('utils.js');

const ALARM_NAME = 'scrapeJobs';
const ALARM_PERIOD_MIN = 60;          // hourly
const MAX_JOB_AGE_DAYS = 30;
const MAX_JOBS = 10000;               // hard cap on stored jobs
const CV_CACHE_HOURS = 24;
const DESC_TRUNCATE = 2000;
const STORAGE_WARN_BYTES = 8 * 1024 * 1024; // 8 MB

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sha1(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Greenhouse / Lever fetchers ──────────────────────────────────────────────

async function fetchGreenhouseJobs(token) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Greenhouse ${token}: HTTP ${res.status}`);
  const data = await res.json();
  const jobs = [];
  for (const j of (data.jobs || [])) {
    const loc = j.location ? j.location.name : '';
    const desc = (j.content || '').replace(/<[^>]*>/g, ' ').slice(0, DESC_TRUNCATE);
    const posted = j.updated_at || j.first_published_at || null;
    const jobUrl = j.absolute_url || `https://boards.greenhouse.io/${token}/jobs/${j.id}`;
    const id = await sha1(`greenhouse|${token}|${jobUrl}`);
    jobs.push({
      id,
      source: 'greenhouse',
      company: token,
      title: j.title || '',
      location: loc,
      url: jobUrl,
      posted_at: posted ? new Date(posted).toISOString() : null,
      description: desc,
      first_seen_at: new Date().toISOString(),
      score: 0
    });
  }
  return jobs;
}

async function fetchLeverJobs(handle) {
  const url = `https://api.lever.co/v0/postings/${handle}?mode=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Lever ${handle}: HTTP ${res.status}`);
  const data = await res.json();
  const jobs = [];
  for (const j of (data || [])) {
    const loc = j.categories?.location || '';
    const desc = (j.descriptionPlain || j.description || '').replace(/<[^>]*>/g, ' ').slice(0, DESC_TRUNCATE);
    let posted = null;
    if (j.createdAt) {
      posted = typeof j.createdAt === 'number'
        ? new Date(j.createdAt).toISOString()
        : new Date(j.createdAt).toISOString();
    }
    const jobUrl = j.hostedUrl || `https://jobs.lever.co/${handle}/${j.id}`;
    const id = await sha1(`lever|${handle}|${jobUrl}`);
    jobs.push({
      id,
      source: 'lever',
      company: handle,
      title: j.text || '',
      location: loc,
      url: jobUrl,
      posted_at: posted,
      description: desc,
      first_seen_at: new Date().toISOString(),
      score: 0
    });
  }
  return jobs;
}

// ── CV keyword caching ───────────────────────────────────────────────────────

async function fetchGoogleDocTextBg(link) {
  const docId = extractGoogleDocId(link);
  if (!docId) throw new Error('Invalid Google Doc link');
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const res = await fetch(exportUrl);
  if (!res.ok) throw new Error(`Doc export HTTP ${res.status}`);
  return res.text();
}

async function aiExtractKeywords(cvText, apiKey, model) {
  const prompt = `Analyze this resume and extract the 30-50 most important keywords for job matching.

Rules:
- Focus on: technical skills, tools, frameworks, programming languages, platforms, methodologies, domain expertise, job titles, and industry terms.
- Use context clues: if the resume mentions "paid media campaigns", extract "paid media" and "digital marketing", NOT "paid".
- Include the candidate's experience level signals (e.g. "senior", "lead", "staff", "principal", "5+ years").
- Include industry/domain terms (e.g. "fintech", "healthcare", "e-commerce", "SaaS").
- Each keyword should be lowercase and 1-3 words.
- Do NOT include: names, emails, phone numbers, addresses, dates, or generic filler words.

Resume:
${cvText.slice(0, 4000)}

Return a JSON object: {"keywords": ["keyword1", "keyword2", ...]}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You extract professional keywords from resumes. Return JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const json = await res.json();
  const parsed = JSON.parse(json.choices[0].message.content);
  const kws = parsed.keywords;
  if (!Array.isArray(kws) || kws.length === 0) throw new Error('AI returned no keywords');
  return kws.map(k => k.toLowerCase().trim()).filter(k => k.length > 0);
}

async function getCvKeywords() {
  const data = await getStorage(['cvLink', 'cvKeywords', 'cvKeywordsUpdatedAt', 'apiKey', 'modelName']);
  if (data.cvKeywords && data.cvKeywordsUpdatedAt) {
    const age = Date.now() - new Date(data.cvKeywordsUpdatedAt).getTime();
    if (age < CV_CACHE_HOURS * 3600 * 1000) return data.cvKeywords;
  }
  if (!data.cvLink) return [];
  try {
    const cvText = await fetchGoogleDocTextBg(data.cvLink);
    let kws;

    // Use AI extraction if API key available, otherwise fall back to pattern matching
    if (data.apiKey) {
      try {
        kws = await aiExtractKeywords(cvText, data.apiKey, data.modelName || 'gpt-4o-mini');
        console.log('[bg] AI extracted keywords:', kws.length);
      } catch (aiErr) {
        console.warn('[bg] AI keyword extraction failed, using pattern match:', aiErr.message);
        kws = extractSmartKeywords(cvText);
      }
    } else {
      kws = extractSmartKeywords(cvText);
    }

    await setStorage({ cvKeywords: kws, cvKeywordsUpdatedAt: new Date().toISOString() });
    return kws;
  } catch (e) {
    console.warn('getCvKeywords failed:', e.message);
    return data.cvKeywords || [];
  }
}

// ── AI company discovery + verification ──────────────────────────────────────

async function verifyGreenhouseToken(token) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, { method: 'GET' });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.jobs) && data.jobs.length > 0;
  } catch { return false; }
}

async function verifyLeverHandle(handle) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${handle}?mode=json&limit=1`, { method: 'GET' });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data) && data.length > 0;
  } catch { return false; }
}

async function generateInitialSources() {
  const data = await getStorage(['cvLink', 'apiKey', 'modelName', 'cvKeywords']);
  if (!data.cvLink || !data.apiKey) {
    console.log('No CV/API key — using fallback sources');
    await setStorage({ jobSources: FALLBACK_SOURCES, sourcesGeneratedFromResume: false });
    return FALLBACK_SOURCES;
  }

  let cvText;
  try {
    cvText = await fetchGoogleDocTextBg(data.cvLink);
  } catch (e) {
    console.warn('Could not fetch CV for source generation:', e.message);
    await setStorage({ jobSources: FALLBACK_SOURCES, sourcesGeneratedFromResume: false });
    return FALLBACK_SOURCES;
  }

  const keywords = (data.cvKeywords || []).join(', ');

  const prompt = `You are an expert recruiter. Given a candidate's resume and their key skills, suggest 30-40 tech companies that would be a great fit for this person.

For each company, provide the likely Greenhouse board token OR Lever handle they use for their public careers page.

Guidelines for guessing tokens:
- Greenhouse tokens are the slug in boards.greenhouse.io/{token} — usually the lowercase company name, sometimes with suffixes like "jobs", "careers", "hq" (e.g. "stripe", "coinbase", "hubspotjobs")
- Lever handles are the slug in jobs.lever.co/{handle} — usually lowercase company name, sometimes hyphenated (e.g. "palantir", "grafana-labs", "dbt-labs")
- Guess 2-3 plausible token variations per company to maximize hit rate

Candidate keywords: ${keywords}

Resume:
${cvText.slice(0, 3000)}

Return a JSON object with this exact shape:
{
  "greenhouse": [{"token": "companyslug", "label": "Company Name"}, ...],
  "lever": [{"token": "companyslug", "label": "Company Name"}, ...]
}

Include as many plausible guesses as you can (aim for 20-30 greenhouse + 15-20 lever). Return valid JSON only.`;

  try {
    const model = data.modelName || 'gpt-4o-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${data.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are an expert recruiter who knows which companies use Greenhouse and Lever for hiring. Respond with JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const json = await res.json();
    const parsed = JSON.parse(json.choices[0].message.content);

    const ghCandidates = parsed.greenhouse || [];
    const lvCandidates = parsed.lever || [];
    console.log(`[bg] AI suggested ${ghCandidates.length} GH + ${lvCandidates.length} Lever tokens — verifying...`);

    // Verify all tokens in parallel
    const ghResults = await Promise.all(
      ghCandidates.map(async (b) => ({ ...b, valid: await verifyGreenhouseToken(b.token) }))
    );
    const lvResults = await Promise.all(
      lvCandidates.map(async (b) => ({ ...b, valid: await verifyLeverHandle(b.token) }))
    );

    const sources = {
      greenhouse: ghResults.filter(b => b.valid).map(({ token, label }) => ({ token, label })),
      lever: lvResults.filter(b => b.valid).map(({ token, label }) => ({ token, label }))
    };

    // Deduplicate by token
    sources.greenhouse = [...new Map(sources.greenhouse.map(b => [b.token, b])).values()];
    sources.lever = [...new Map(sources.lever.map(b => [b.token, b])).values()];

    console.log(`[bg] Verified: ${sources.greenhouse.length} GH + ${sources.lever.length} Lever boards`);

    if (sources.greenhouse.length + sources.lever.length === 0) throw new Error('No AI-suggested tokens passed verification');
    await setStorage({ jobSources: sources, sourcesGeneratedFromResume: true });
    return sources;
  } catch (e) {
    console.warn('AI source generation failed:', e.message, '— using fallback');
    await setStorage({ jobSources: FALLBACK_SOURCES, sourcesGeneratedFromResume: false });
    return FALLBACK_SOURCES;
  }
}

// ── AI ranking ───────────────────────────────────────────────────────────────

async function aiRankTop5(top100, cvText, apiKey, model) {
  // Build compact summaries for the prompt
  const summaries = top100.map((j, i) => {
    const desc = (j.description || '').slice(0, 300);
    return `[${i}] ${j.title} @ ${j.company} | ${j.location} | ${desc}`;
  }).join('\n');

  const prompt = `You are a career advisor. Given a candidate's resume and a list of 100 job postings, pick the 5 BEST jobs for this candidate.

Rank by (in order of priority):
1. Match to the candidate's experience level and skills
2. Likely genuine interest based on their background
3. Potential for income growth and career advancement

Resume:
${cvText.slice(0, 3000)}

Jobs (index | title @ company | location | description snippet):
${summaries}

Return ONLY a JSON array of the 5 best job indices, best first. Example: [14, 3, 77, 42, 61]`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a career advisor. Return only a JSON array of 5 integers.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const json = await res.json();
  const content = json.choices[0].message.content;

  // Parse — handle both bare array [1,2,3] and {"indices":[1,2,3]} shapes
  const parsed = JSON.parse(content);
  const indices = Array.isArray(parsed) ? parsed : (parsed.indices || parsed.jobs || parsed.top5 || Object.values(parsed)[0]);
  if (!Array.isArray(indices)) throw new Error('AI did not return an array');

  // Map indices back to job objects, skip invalid
  return indices
    .filter(i => typeof i === 'number' && i >= 0 && i < top100.length)
    .slice(0, 5)
    .map(i => top100[i]);
}

// ── Main scrape ──────────────────────────────────────────────────────────────

async function scrapeAllJobs() {
  console.log('[bg] scrapeAllJobs start');
  try {
    let { jobSources } = await getStorage(['jobSources']);
    if (!jobSources || (!jobSources.greenhouse?.length && !jobSources.lever?.length)) {
      jobSources = FALLBACK_SOURCES;
    }

    // Existing jobs for dedup
    const { jobs: existing } = await getStorage(['jobs']);
    const existingMap = {};
    for (const j of (existing || [])) existingMap[j.id] = j;

    const newJobs = [];

    // Greenhouse
    for (const board of (jobSources.greenhouse || [])) {
      try {
        const fetched = await fetchGreenhouseJobs(board.token);
        for (const j of fetched) {
          if (!existingMap[j.id]) {
            newJobs.push(j);
          }
        }
      } catch (e) {
        console.warn(`[bg] Greenhouse ${board.token} error:`, e.message);
      }
    }

    // Lever
    for (const board of (jobSources.lever || [])) {
      try {
        const fetched = await fetchLeverJobs(board.token);
        for (const j of fetched) {
          if (!existingMap[j.id]) {
            newJobs.push(j);
          }
        }
      } catch (e) {
        console.warn(`[bg] Lever ${board.token} error:`, e.message);
      }
    }

    // Merge
    let allJobs = Object.values(existingMap).concat(newJobs);

    // Prune jobs older than MAX_JOB_AGE_DAYS
    const cutoff = Date.now() - MAX_JOB_AGE_DAYS * 86400 * 1000;
    allJobs = allJobs.filter(j => new Date(j.first_seen_at).getTime() > cutoff);

    // Score against CV keywords
    const keywords = await getCvKeywords();
    const kwSet = new Set(keywords);
    for (const j of allJobs) {
      const text = [j.title, j.company, j.location, j.description].join(' ');
      const [score] = scoreJob(text, kwSet);
      j.score = score;
    }

    // Sort by score desc, then posted_at desc
    allJobs.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const da = a.posted_at ? new Date(a.posted_at).getTime() : 0;
      const db = b.posted_at ? new Date(b.posted_at).getTime() : 0;
      return db - da;
    });

    // Cap at MAX_JOBS
    if (allJobs.length > MAX_JOBS) {
      allJobs = allJobs.slice(0, MAX_JOBS);
    }

    // Check storage usage — truncate descriptions if too large
    const estimatedSize = JSON.stringify(allJobs).length;
    if (estimatedSize > STORAGE_WARN_BYTES) {
      for (const j of allJobs) {
        if (j.description && j.description.length > 500) {
          j.description = j.description.slice(0, 500);
        }
      }
    }

    // AI rank top 5 from the top 100 keyword-scored jobs
    const top100 = allJobs.slice(0, 100);
    let topJobs = top100.slice(0, 5); // fallback: keyword-only top 5

    const { apiKey, modelName, cvLink } = await getStorage(['apiKey', 'modelName', 'cvLink']);
    if (apiKey && cvLink && top100.length > 0) {
      try {
        const cvText = await fetchGoogleDocTextBg(cvLink);
        const model = modelName || 'gpt-4o-mini';
        const aiPicks = await aiRankTop5(top100, cvText, apiKey, model);
        if (aiPicks.length > 0) {
          topJobs = aiPicks;
          console.log('[bg] AI ranked top 5:', topJobs.map(j => `${j.title} @ ${j.company}`));
        }
      } catch (e) {
        console.warn('[bg] AI ranking failed, using keyword top 5:', e.message);
      }
    }

    await setStorage({
      jobs: allJobs,
      topJobs,
      jobsLastUpdated: new Date().toISOString(),
      jobsLastError: null
    });
    console.log(`[bg] scrapeAllJobs done — ${allJobs.length} total, ${newJobs.length} new, top5 AI-ranked: ${apiKey ? 'yes' : 'no'}`);
  } catch (e) {
    console.error('[bg] scrapeAllJobs error:', e);
    await setStorage({ jobsLastError: e.message });
  }
}

// ── Listeners ────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    scrapeAllJobs();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'popup.html' });
  }
  // Clear stale keyword cache so new extraction runs
  await setStorage({ cvKeywords: null, cvKeywordsUpdatedAt: null });
  // Set up alarm
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  // Generate sources + first scrape
  await generateInitialSources();
  scrapeAllJobs();
});

chrome.runtime.onStartup.addListener(async () => {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FETCH_GOOGLE_DOC') {
    fetchGoogleDocTextBg(request.url)
      .then(text => sendResponse({ success: true, text }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (request.type === 'SCRAPE_NOW') {
    scrapeAllJobs()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.type === 'GET_SCRAPE_STATUS') {
    getStorage(['jobsLastUpdated', 'jobsLastError', 'jobs']).then(data => {
      sendResponse({
        lastUpdated: data.jobsLastUpdated || null,
        lastError: data.jobsLastError || null,
        jobCount: (data.jobs || []).length
      });
    });
    return true;
  }
  if (request.type === 'GENERATE_SOURCES') {
    generateInitialSources()
      .then(sources => {
        scrapeAllJobs();
        sendResponse({ success: true, sources });
      })
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
});
