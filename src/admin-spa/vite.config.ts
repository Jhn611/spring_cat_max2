import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Конфигурация Vite описывает только сборку и локальные порты SPA. Адрес backend
// передаётся через переменную VITE_API_BASE_URL, чтобы Docker и dev-режим не спорили.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3080
  },
  preview: {
    port: 3080
  }
});
