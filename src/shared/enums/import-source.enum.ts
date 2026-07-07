export enum ImportSourceType {
  JSON_IMPORT = 'json_import',
  CSV_IMPORT = 'csv_import',
  INVENTORYPAL_ORDER = 'inventorypal_order',
  MANUAL = 'manual',
  API = 'api',
}

export enum ImportJobSourceType {
  JSON_PAGES = 'json_pages',
  INVENTORYPAL = 'inventorypal',
  CSV = 'csv',
}

export enum ImportJobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
