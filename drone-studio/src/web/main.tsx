import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../design-system/tokens.css';
import './web.css';
import { App } from './App';

try { const saved = localStorage.getItem('lucidity.appearance.v1'); if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved; } catch { /* private mode */ }
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
