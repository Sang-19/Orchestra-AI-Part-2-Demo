import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

// Prevent third-party browser extension injection errors (e.g. chrome-extension:// scripts
// attempting to overwrite getter-only window.fetch) from interrupting app execution.
const isBrowserExtensionSource = (filename?: string, stack?: string): boolean => {
  const combined = `${filename ?? ''}\n${stack ?? ''}`;
  return (
    combined.includes('chrome-extension://') ||
    combined.includes('moz-extension://') ||
    combined.includes('safari-extension://')
  );
};

window.addEventListener(
  'error',
  (event) => {
    if (isBrowserExtensionSource(event.filename, event.error?.stack)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true
);

window.addEventListener(
  'unhandledrejection',
  (event) => {
    const stack = typeof event.reason === 'object' && event.reason ? String((event.reason as { stack?: unknown }).stack ?? '') : '';
    if (isBrowserExtensionSource('', stack)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true
);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
