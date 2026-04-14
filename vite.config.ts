/**
 * File: vite.config.ts
 *
 * Purpose:
 *   Vite build config for static hosting (including GitHub Pages).
 *
 * Usage example:
 *   npm run build
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
});
