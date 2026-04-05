export interface RoutineActivity {
  id: string;
  name: string;
  /** True when this task exists only for one calendar day (added from Today), not the weekly template. */
  isOneDay?: boolean;
}

/** One row in history: weekly template (oneDayDate null) or a single-day extra (oneDayDate set). */
export interface RoutineActivityVersioned {
  id: string;
  name: string;
  weekdayIndex: number;
  /** When set (YYYY-MM-DD), this row applies only on that day; ignored for weekly template matching. */
  oneDayDate: string | null;
  /**
   * When set with oneDayDate, hides that weekly template activity on that calendar day only.
   * `name` is stored as '' for these rows; they are not shown as tasks in the checklist.
   */
  suppressWeeklyActivityId?: string | null;
  /** First calendar day this row applies (YYYY-MM-DD). */
  effectiveFrom: string;
  /** Last calendar day inclusive, or null = still current. */
  effectiveTo: string | null;
  sortOrder: number;
}

/** Persisted app state (versioned routines). */
export interface RoutinePersistedV3 {
  version: 3;
  activities: RoutineActivityVersioned[];
  doneKeys: string[];
}

/** @deprecated Loaded and migrated to v3 */
export interface RoutinePersistedV2 {
  version: 2;
  byWeekday: RoutineActivity[][];
  doneKeys: string[];
}

export type RoutinePersisted = RoutinePersistedV3 | RoutinePersistedV2;
