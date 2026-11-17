import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

// Prevent third-party browser extension injection errors (e.g. chrome-extension:// scripts
// attempting to overwrite getter-only window.fetch) from interrupting app execution.
window.addEventListener('error', (event) => {
  if (
    typeof event.filename === 'string' &&
    (event.filename.startsWith('chrome-extension://') ||
      event.filename.startsWith('moz-extension://'))
  ) {
    event.preventDefault();
  }
});

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
