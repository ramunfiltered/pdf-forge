// PDF Forge background service worker
// Relays large PDF data from popup → editor tab via chrome.storage
chrome.runtime.onInstalled.addListener(() => {
  console.log('PDF Forge 2.0 installed');
});
