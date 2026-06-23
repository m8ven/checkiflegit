import tls from 'node:tls';
import { daysSince } from '../util.js';

/**
 * SSL certificate presence + validity, checked by opening a TLS socket
 * directly to port 443 (no third-party service).
 */
export function checkSsl(domain) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };

    const socket = tls.connect(
      {
        host: domain,
        port: 443,
        servername: domain,
        timeout: 8000,
        // We validate the cert ourselves below; allow the handshake to complete
        // even if the chain is imperfect so we can report *why*.
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || Object.keys(cert).length === 0) {
          return done({ status: 'fail', value: null, detail: 'No certificate presented.' });
        }
        const authorized = socket.authorized;
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const expired = validTo ? daysSince(validTo) > 0 : false;
        const daysToExpiry = validTo ? -daysSince(validTo) : null;

        let status = 'pass';
        let detail = `Valid certificate issued by ${cert.issuer?.O || 'unknown CA'}.`;
        if (expired) {
          status = 'fail';
          detail = 'Certificate has expired.';
        } else if (!authorized) {
          status = 'warn';
          detail = `Certificate present but chain not trusted (${socket.authorizationError}).`;
        }
        done({
          status,
          value: {
            issuer: cert.issuer?.O || null,
            validTo: validTo ? validTo.toISOString().slice(0, 10) : null,
            daysToExpiry,
            authorized,
          },
          detail,
        });
      }
    );

    socket.on('timeout', () =>
      done({ status: 'unknown', value: null, detail: 'TLS connection timed out.' })
    );
    socket.on('error', (err) =>
      done({ status: 'fail', value: null, detail: `TLS connection failed: ${err.message}` })
    );
  });
}
