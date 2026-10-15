// Runs in <head> before first paint, so the saved theme never flashes.
(function () {
  try {
    var theme = localStorage.getItem('tibiaviewer.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
