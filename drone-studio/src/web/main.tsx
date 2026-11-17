import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../design-system/tokens.css';
import './web.css';
import { App, preferredTheme } from './App';

// index.html settles this before the first paint; this repeats it for any entry point that skips that script.
if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = preferredTheme();
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
