/** Messages exchanged between the extension host and the viewer webview. */
import type { Change } from './diff/types';
import type { BBox } from './model/geom';

export type { BBox, Change };
export type { ChangeKind, ChangeCategory, FieldChange, ChangeLocation } from './diff/types';

export interface SheetView {
  /** Sheet instance name path, e.g. `/PSU/` — the sheet's identity in the UI. */
  id: string;
  name: string;
  page: string;
  file: string;
  svgUrl?: string;
  /** Black-and-white rendering used as an overlay mask. */
  maskUrl?: string;
  width: number;
  height: number;
  /** Clickable child-sheet frames (double-click opens the child sheet). */
  links: { bbox: BBox; target: string }[];
}

export interface LayerView {
  name: string;
  userName: string;
  type: string;
  svgUrl?: string;
}

/** Searchable object (symbol or footprint) with its location. */
export interface ItemView {
  ref: string;
  value: string;
  sheet?: string;
  layer?: string;
  bbox: BBox;
}

export interface RevisionView {
  label: string;
  kind: 'sch' | 'pcb';
  page: { width: number; height: number };
  sheets?: SheetView[];
  layers?: LayerView[];
  /** Board outline extents (PCB) used for "fit". */
  contentBox?: BBox;
  items: ItemView[];
  warnings: string[];
}

export type DiffMode = 'overlay' | 'sideBySide' | 'blend' | 'swipe';

export interface Viewport {
  /** Centre of the view in page millimetres. */
  cx: number;
  cy: number;
  /** Screen pixels per millimetre. */
  scale: number;
}

export type HostMessage =
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string; actions?: { label: string; command: string }[] }
  | {
      type: 'show';
      mode: 'view' | 'diff';
      title: string;
      after: RevisionView;
      before?: RevisionView;
      changes?: Change[];
      diffMode: DiffMode;
      /** Sheet (namePath) to open first. */
      initialSheet?: string;
      /** Show a "open full diff" banner (stock diff editor pair). */
      pairedWith?: 'left' | 'right';
    }
  | { type: 'viewport'; viewport: Viewport; sheet?: string; flipped?: boolean }
  | { type: 'navigateChange'; direction: 1 | -1 }
  | { type: 'fetchResult'; id: number; text?: string; error?: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'viewport'; viewport: Viewport; sheet?: string; flipped?: boolean }
  | { type: 'command'; command: 'openFullDiff' | 'openAsText' | 'setCliPath' | 'showLog' | string }
  | { type: 'focus'; focused: boolean }
  /** Fallback when the webview cannot fetch a resource URL itself. */
  | { type: 'fetch'; id: number; url: string };
