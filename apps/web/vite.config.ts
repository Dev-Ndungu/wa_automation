import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // This dashboard uses its own CSS. Leaving Tailwind's filesystem scanner on
  // made Windows Vite builds crawl protected parent folders and hang/fail.
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
