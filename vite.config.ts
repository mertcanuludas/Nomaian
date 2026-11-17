import { existsSync, readFileSync } from 'fs';
import { defineConfig } from 'vitest/config';

// Phones only open the camera on secure pages, so the dev server uses HTTPS when a certificate is present.
// Make one (valid for this machine's LAN address) with:
//   openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout .cert/dev-key.pem -out .cert/dev.pem \
//     -subj "/CN=Nomaian dev" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<LAN IP>"
const CERT = '.cert/dev.pem';
const KEY = '.cert/dev-key.pem';
const https = existsSync(CERT) && existsSync(KEY) ? { cert: readFileSync(CERT), key: readFileSync(KEY) } : undefined;

export default defineConfig({
  // Relative base so the build works from any GitHub Pages / Netlify sub-path.
  base: './',
  server: { https },
  preview: { https },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
