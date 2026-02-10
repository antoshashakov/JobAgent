// Content script - runs on every page

// Try to extract job information from the current page
function extractJobInfo() {
  // Common employment board selectors
  const selectors = {
    title: [
      'h1[data-testid="jobs-details-top-card-title"]',
      'h1.job-title',
      'h1[class*="title"]',
      '.job-header h1',
      '[class*="job"][class*="title"]'
    ],
    company: [
      '[data-testid="jobs-details-top-card__company-name"]',
      '.job-company',
      '.company-name',
      '[class*="company"]'
    ],
    location: [
      '[data-testid="jobs-details-top-card-location"]',
      '.job-location',
      '[class*="location"]'
    ],
    description: [
      '[data-testid="jobs-details-main-content"]',
      '.job-description',
      '.job-body',
      '[class*="description"]'
    ]
  };

  let job = {
    title: '',
    company: '',
    location: '',
    description: '',
    url: window.location.href
  };

  // Try to extract each field
  for (const selector of selectors.title) {
    const elem = document.querySelector(selector);
    if (elem?.textContent?.trim()) {
      job.title = elem.textContent.trim().substring(0, 200);
      break;
    }
  }

  for (const selector of selectors.company) {
    const elem = document.querySelector(selector);
    if (elem?.textContent?.trim()) {
      job.company = elem.textContent.trim().substring(0, 100);
      break;
    }
  }

  for (const selector of selectors.location) {
    const elem = document.querySelector(selector);
    if (elem?.textContent?.trim()) {
      job.location = elem.textContent.trim().substring(0, 100);
      break;
    }
  }

  for (const selector of selectors.description) {
    const elem = document.querySelector(selector);
    if (elem?.textContent?.trim()) {
      job.description = elem.textContent.trim().substring(0, 5000);
      break;
    }
  }

  return job;
}

// Helper function to fill form field
function fillFormField(field, value) {
  if (field.tagName === 'SELECT') {
    // For select elements, try to find matching option
    const options = Array.from(field.options);
    const matchingOption = options.find(opt => 
      opt.textContent.toLowerCase().includes(value.toLowerCase())
    );
    if (matchingOption) {
      field.value = matchingOption.value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  } else if (field.type === 'checkbox' || field.type === 'radio') {
    if (['yes', 'true', '1'].includes(value.toLowerCase())) {
      field.checked = true;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else if (field.type !== 'file') {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

// Find and click "Apply" button if present
function clickApplyButton() {
  const selectors = [
    'a:has-text("Apply")',
    'button:has-text("Apply")',
    'a:has-text("Apply Now")',
    'button:has-text("Apply Now")',
    '[class*="apply"]',
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll('*');
    for (const elem of elements) {
      const text = elem.textContent.trim().toLowerCase();
      if ((text === 'apply' || text === 'apply now') && 
          (elem.tagName === 'A' || elem.tagName === 'BUTTON')) {
        elem.click();
        return true;
      }
    }
  }
  return false;
}

// Collect form fields from the page
function getFormFields() {
  const fields = [];
  const form = document.querySelector('form');
  
  if (!form) return fields;

  const inputs = form.querySelectorAll('input, textarea, select');
  
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const fieldId = input.id || input.name || `field_${i}`;
    
    let label = '';
    if (input.id) {
      const labelElem = document.querySelector(`label[for="${input.id}"]`);
      if (labelElem) {
        label = labelElem.textContent.trim();
      }
    }

    fields.push({
      field_id: fieldId,
      label,
      name: input.name || '',
      placeholder: input.placeholder || '',
      type: input.type || input.tagName.toLowerCase(),
      element: input
    });
  }

  return fields;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_JOB_INFO') {
    const job = extractJobInfo();
    // Only return if we found meaningful job info
    sendResponse({ job: (job.title && job.company) ? job : null });
  } 
  else if (request.type === 'AUTOFILL_FORM') {
    handleAutofill(request, sendResponse);
  }
});

async function handleAutofill(request, sendResponse) {
  try {
    const { job, coverLetter, apiKey, model } = request;
    
    // Click Apply button if needed
    if (clickApplyButton()) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Find form
    const form = document.querySelector('form');
    if (!form) {
      sendResponse({ success: false, error: 'No application form found' });
      return;
    }

    // Get form fields
    const fields = getFormFields();
    if (fields.length === 0) {
      sendResponse({ success: false, error: 'Form has no fields' });
      return;
    }

    // Prepare profile data
    const profile = {
      name: job.company || 'Candidate',
      email: '',
      phone: '',
      location: job.location || '',
      cover_letter: coverLetter
    };

    // Try to extract email/phone from cover letter or use placeholders
    const emailMatch = coverLetter.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (emailMatch) profile.email = emailMatch[0];

    // Call OpenAI to match fields
    const fieldDescriptions = fields.map(f => ({
      field_id: f.field_id,
      label: f.label,
      name: f.name,
      placeholder: f.placeholder,
      type: f.type
    }));

    // Use the matchFormFields function from utils.js
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You map application form fields to candidate data and return strict JSON.'
          },
          {
            role: 'user',
            content: `Map candidate profile values to application form fields. Return JSON only with this shape: { "field_id_1": "value", "field_id_2": "value" }\n\nCandidate profile:\n${JSON.stringify(profile, null, 2)}\n\nFields:\n${JSON.stringify(fieldDescriptions, null, 2)}`
          }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error('OpenAI API failed');
    }

    const data = await response.json();
    const mapping = JSON.parse(data.choices[0].message.content);

    // Fill form fields
    let filled = 0;
    for (const field of fields) {
      const value = mapping[field.field_id]?.trim() || '';
      
      // Skip certain field types
      if (field.type === 'file') continue;
      if (field.field_id.toLowerCase().includes('captcha')) continue;
      if (!value) continue;

      try {
        if (fillFormField(field.element, value)) {
          filled++;
        }
      } catch (e) {
        console.error(`Failed to fill field ${field.field_id}:`, e);
      }
    }

    sendResponse({ 
      success: true, 
      message: `Filled ${filled} fields`,
      fieldsFilled: filled 
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}
