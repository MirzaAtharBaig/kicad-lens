import type { BBox } from '../model/geom';

export type ChangeKind = 'added' | 'removed' | 'modified';

export type ChangeCategory =
  | 'component'
  | 'net'
  | 'wiring'
  | 'label'
  | 'sheet'
  | 'routing'
  | 'zone'
  | 'board'
  | 'graphic'
  | 'power';

export interface FieldChange {
  field: string;
  before?: string;
  after?: string;
}

export interface ChangeLocation {
  /** Schematic sheet instance (namePath, e.g. `/PSU/`). */
  sheet?: string;
  /** PCB layer (canonical name). */
  layer?: string;
  /** Area to zoom to, in KiCad page millimetres. */
  bbox?: BBox;
}

export interface Change {
  id: string;
  category: ChangeCategory;
  kind: ChangeKind;
  /** Short label, e.g. `R12` or `Net GND`. */
  title: string;
  /** One-line human summary. */
  summary: string;
  fields: FieldChange[];
  locations: ChangeLocation[];
}

export interface DiffResult {
  changes: Change[];
  /** Sheets (namePath) or layers containing at least one change. */
  changedSheets: string[];
  changedLayers: string[];
}
