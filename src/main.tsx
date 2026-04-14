/**
 * File: src/main.tsx
 *
 * Purpose:
 *   React entry point for the PTB-practice web application.
 *
 * Usage example:
 *   npm run dev
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
