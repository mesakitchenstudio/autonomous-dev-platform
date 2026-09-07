export async function persistWorkerCapabilities(adapter, workerId, discovery) {
  if (!adapter?.query) return discovery;
  await adapter.query(`INSERT INTO worker_capabilities (
    worker_id, os, arch, capabilities, details, discovered_at, refreshed_at
  ) VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
  ON CONFLICT (worker_id) DO UPDATE SET
    os = EXCLUDED.os,
    arch = EXCLUDED.arch,
    capabilities = EXCLUDED.capabilities,
    details = EXCLUDED.details,
    refreshed_at = NOW()`, [
    workerId,
    discovery.os,
    discovery.arch,
    JSON.stringify(discovery.capabilities || []),
    JSON.stringify(discovery.details || {})
  ]).catch(() => {});
  return discovery;
}
