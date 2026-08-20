'use strict';

function javaBinaryForVersion(version) {
  const value = String(version || '').trim();
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Ungültige Minecraft-Version: ${value || '(leer)'}`);
  }
  if (parts[0] >= 26) return '/opt/java/25/bin/java';
  if (parts[0] !== 1 || parts[1] < 17) {
    throw new Error(`Minecraft ${value} wird nicht unterstützt (Minimum: 1.17)`);
  }
  if (parts[1] > 20 || (parts[1] === 20 && (parts[2] || 0) >= 5)) {
    return '/opt/java/21/bin/java';
  }
  return '/opt/java/17/bin/java';
}

module.exports = { javaBinaryForVersion };
