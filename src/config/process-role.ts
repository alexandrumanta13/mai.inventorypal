export type InventoryPalProcessRole = 'api' | 'worker' | 'all';

const VALID_PROCESS_ROLES: InventoryPalProcessRole[] = ['api', 'worker', 'all'];

export function getInventoryPalProcessRole(): InventoryPalProcessRole {
  const role = (process.env.INVENTORYPAL_PROCESS_ROLE || 'all').trim().toLowerCase();

  return VALID_PROCESS_ROLES.includes(role as InventoryPalProcessRole)
    ? (role as InventoryPalProcessRole)
    : 'all';
}

export function shouldRunHttpApi(): boolean {
  const role = getInventoryPalProcessRole();
  return role === 'api' || role === 'all';
}

export function shouldRunWorkers(): boolean {
  const role = getInventoryPalProcessRole();
  return role === 'worker' || role === 'all';
}
