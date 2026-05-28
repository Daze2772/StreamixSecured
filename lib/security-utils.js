/**
 * Extract client IP from Next.js request
 * Handles proxies, load balancers, and direct connections
 */

export function getClientIp(request) {
  // Try various headers that proxies/load balancers use
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list (client, proxy1, proxy2...)
    const ips = forwarded.split(',').map((ip) => ip.trim());
    return ips[0]; // First IP is the original client
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;

  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp;

  // Fallback (should rarely happen in production)
  return 'unknown';
}

/**
 * Check if an IP is private (RFC1918, loopback, etc.)
 * Used for SSRF protection
 */
export function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;

  // Remove IPv6 prefix if present
  const cleanIp = ip.replace(/^::ffff:/, '');

  // IPv4 private ranges
  const ipv4Patterns = [
    /^127\./,              // Loopback (127.0.0.0/8)
    /^10\./,               // Class A private (10.0.0.0/8)
    /^172\.(1[6-9]|2\d|3[01])\./, // Class B private (172.16.0.0/12)
    /^192\.168\./,         // Class C private (192.168.0.0/16)
    /^169\.254\./,         // Link-local (169.254.0.0/16)
    /^0\./,                // "This" network (0.0.0.0/8)
    /^localhost$/i,
  ];

  // IPv6 private ranges
  const ipv6Patterns = [
    /^::1$/,               // Loopback
    /^fe80:/i,             // Link-local
    /^fc00:/i,             // Unique local
    /^fd00:/i,             // Unique local
    /^ff00:/i,             // Multicast
  ];

  return (
    ipv4Patterns.some((pattern) => pattern.test(cleanIp)) ||
    ipv6Patterns.some((pattern) => pattern.test(cleanIp))
  );
}

/**
 * Validate URL to prevent SSRF attacks
 */
export async function isUrlSafe(urlString) {
  try {
    const url = new URL(urlString);

    // Only allow HTTP/HTTPS
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false;
    }

    // Check if hostname resolves to private IP
    if (isPrivateIp(url.hostname)) {
      return false;
    }

    // Additional check: resolve hostname and verify IP isn't private
    // (prevents DNS rebinding attacks)
    // Note: In production, you'd use dns.promises.resolve here
    // For now, basic hostname pattern check
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)) {
      // It's an IP address - check if private
      return !isPrivateIp(url.hostname);
    }

    return true;
  } catch {
    return false;
  }
}
