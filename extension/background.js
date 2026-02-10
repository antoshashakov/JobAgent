// Background service worker

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open welcome/setup page on first install
    chrome.tabs.create({ url: 'popup.html' });
  }
});

// Handle any background tasks or API calls that need to happen here
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FETCH_GOOGLE_DOC') {
    fetchGoogleDocInBackground(request.url)
      .then(text => sendResponse({ success: true, text }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function fetchGoogleDocInBackground(url) {
  const docIdMatch = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!docIdMatch) throw new Error('Invalid Google Doc URL');
  
  const docId = docIdMatch[1];
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=docx`;
  
  const response = await fetch(exportUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  
  // Return text version (in production, you'd convert DOCX to text properly)
  return await response.text();
}
