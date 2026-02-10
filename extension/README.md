# Job Match Assistant - Chrome Extension

A Chrome extension version of the Job Match Assistant that helps you apply to jobs using AI-generated cover letters and automatic form filling.

## Installation

1. **Prepare the extension:**
   - Copy all files from the `extension/` folder to a dedicated directory
   - You'll need icon files (16x16, 48x48, 128x128 PNG) in an `icons/` subdirectory

2. **Load in Chrome:**
   - Go to `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the extension directory

3. **First run:**
   - Click the extension icon in Chrome
   - Go to the "Setup" tab
   - Add your CV and Cover Letter Google Doc links
   - Go to "Settings" tab
   - Add your OpenAI API key and select your preferred model

## How to Use

### Setup Documents
1. Share your CV and Cover Letter as Google Docs (make them shareable)
2. Copy the shareable links into the extension Setup tab
3. Save them

### Match a Job
1. Navigate to any job posting page
2. Click the extension icon
3. Go to "Match Job" tab
4. The job details should appear
5. Click "Generate" to create a customized cover letter
6. Edit the generated cover letter if needed

### Apply with Autofill
1. After generating a cover letter, click "Autofill Form"
2. The extension will:
   - Click the "Apply" button if it finds one
   - Detect the application form
   - Use AI to match your profile to form fields
   - Fill in the fields automatically
3. You can review and complete any remaining fields
4. Submit the form manually

### Download
- Use "Download PDF" to save the cover letter as a text file

## Supported Job Boards
The extension works on most job posting pages, including:
- LinkedIn Jobs
- Indeed
- Greenhouse
- Lever
- AngelList
- And many others

## Troubleshooting

**Job info not showing:**
- Make sure you're on a job posting page with a job title and company name
- Some job boards hide information in dynamic content - reload the page

**Autofill failing:**
- Check that your OpenAI API key is valid
- Some forms have special protections (CAPTCHA) that can't be auto-filled
- Your profile information must have at least a name and email

**Google Doc not loading:**
- Make sure the document is shared with "Anyone with the link"
- Check that it's an actual Google Doc (not a PDF or other type)

## Privacy
- Your API key is stored locally in your browser
- Job data is not sent to any server except OpenAI's API
- The extension does not track or store your activity

## Files Overview

- `manifest.json` - Extension configuration
- `popup.html/css/js` - Main extension UI
- `content-script.js` - Interacts with job posting pages
- `background.js` - Background service worker
- `utils.js` - Shared utility functions
