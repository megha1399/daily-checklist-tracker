import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import type {
  RoutineActivity,
  RoutineActivityVersioned,
  RoutinePersisted,
  RoutinePersistedV2,
  RoutinePersistedV3,
} from '../models/routine.model';
import { AuthService } from './auth.service';

const ROUTINE_STORAGE_PREFIX = 'daily-checklist-tracker-routine-v2';
/** Logged-out / no-account local cache (browser-only mode). */
const ROUTINE_STORAGE_GLOBAL = ROUTINE_STORAGE_PREFIX;
const LEGACY_DATA_V1 = 'daily-checklist-tracker-data-v1';
const LEGACY_DATA_V1_OLD = 'habit-tracker-data-v1';

function emptyWeek(): RoutineActivity[][] {
  return Array.from({ length: 7 }, () => []);
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday = 0 … Sunday = 6 */
export function weekdayIndexFromDate(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

function parseYmdLocal(key: string): Date {
  const [y, mo, day] = key.split('-').map(Number);
  const dt = new Date(y, mo - 1, day);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function completionKey(dateKey: string, activityId: string): string {
  return `${dateKey}::${activityId}`;
}

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

@Injectable({ providedIn: 'root' })
export class RoutineService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly activitiesSignal = signal<RoutineActivityVersioned[]>([]);
  private readonly doneKeysSignal = signal<Set<string>>(new Set());

  /** Current weekly template only (open-ended rows, excludes single-day extras). */
  readonly byWeekday = computed(() => {
    const rows = this.activitiesSignal().filter((a) => a.effectiveTo === null && a.oneDayDate == null);
    const out = emptyWeek();
    const byW: RoutineActivityVersioned[][] = Array.from({ length: 7 }, () => []);
    for (const a of rows) {
      if (a.weekdayIndex >= 0 && a.weekdayIndex <= 6) {
        byW[a.weekdayIndex].push(a);
      }
    }
    for (let w = 0; w < 7; w++) {
      byW[w].sort((x, y) => x.sortOrder - y.sortOrder);
      out[w] = byW[w].map((a) => ({ id: a.id, name: a.name }));
    }
    return out;
  });

  readonly doneKeys = this.doneKeysSignal.asReadonly();

  readonly apiSyncMessage = signal<string | null>(null);

  private cacheKey(): string {
    const id = this.auth.user()?.id;
    if (id) return `${ROUTINE_STORAGE_PREFIX}-${id}`;
    return ROUTINE_STORAGE_GLOBAL;
  }

  /** Previous localStorage keys (one-time migration). */
  private legacyRoutineStorageKey(): string {
    const id = this.auth.user()?.id;
    if (id) return `habit-tracker-routine-v2-${id}`;
    return 'habit-tracker-routine-v2';
  }

  resetToEmpty(): void {
    this.activitiesSignal.set([]);
    this.doneKeysSignal.set(new Set());
    this.apiSyncMessage.set(null);
  }

  clearCurrentUserCache(): void {
    try {
      localStorage.removeItem(this.cacheKey());
      localStorage.removeItem(this.legacyRoutineStorageKey());
    } catch {
      /* ignore */
    }
  }

  async loadInitial(): Promise<void> {
    const base = environment.apiBaseUrl;
    if (!base) {
      this.loadFromLocalStorageOnly();
      return;
    }
    if (!this.auth.isLoggedIn()) {
      this.resetToEmpty();
      return;
    }
    try {
      const data = await firstValueFrom(this.http.get<RoutinePersisted>(`${base}/routine`));
      if (!this.isValidPersisted(data)) {
        this.loadFromLocalStorageOnly();
        return;
      }
      // Treat API as source of truth. Do not restore from localStorage when the server is empty — that used to
      // call persist() and put deleted rows back into the DB after a manual DB cleanup or refresh.
      this.applyPersisted(data);
      this.saveLocal(this.snapshot());
    } catch (e) {
      const he = e as HttpErrorResponse;
      if (he.status === 401) {
        this.resetToEmpty();
        return;
      }
      this.loadFromLocalStorageOnly();
    }
  }

  todayYmd(): string {
    return ymd(new Date());
  }

  shiftYmd(dateKey: string, deltaDays: number): string {
    const d = parseYmdLocal(dateKey);
    return ymd(addDays(d, deltaDays));
  }

  weekdayLabel(index: number): string {
    const labels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return labels[index] ?? '';
  }

  /** Activities that applied on this calendar day (weekly template + any single-day extras for that date). */
  activitiesForDate(dateKey: string): RoutineActivity[] {
    const w = weekdayIndexFromDate(parseYmdLocal(dateKey));
    const suppressed = new Set<string>();
    for (const a of this.activitiesSignal()) {
      if (
        a.oneDayDate === dateKey &&
        a.suppressWeeklyActivityId &&
        a.effectiveFrom <= dateKey &&
        (a.effectiveTo == null || a.effectiveTo >= dateKey)
      ) {
        suppressed.add(a.suppressWeeklyActivityId);
      }
    }
    const rows = this.activitiesSignal().filter((a) => {
      if (a.oneDayDate != null) {
        if (a.suppressWeeklyActivityId) return false;
        return a.oneDayDate === dateKey && a.effectiveFrom <= dateKey && (a.effectiveTo == null || a.effectiveTo >= dateKey);
      }
      if (a.weekdayIndex !== w) return false;
      if (a.effectiveFrom > dateKey) return false;
      if (a.effectiveTo != null && a.effectiveTo < dateKey) return false;
      if (suppressed.has(a.id)) return false;
      return true;
    });
    rows.sort((x, y) => {
      const ox = x.oneDayDate != null ? 1 : 0;
      const oy = y.oneDayDate != null ? 1 : 0;
      if (ox !== oy) return ox - oy;
      return x.sortOrder - y.sortOrder;
    });
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      isOneDay: a.oneDayDate != null,
    }));
  }

  /**
   * Weekly tasks hidden for this calendar day only (template unchanged for other dates).
   * Used to show Restore actions.
   */
  hiddenWeeklySkipsForDate(dateKey: string): { activityId: string; name: string }[] {
    if (!isYmd(dateKey)) return [];
    const prev = this.activitiesSignal();
    const out: { activityId: string; name: string }[] = [];
    for (const a of prev) {
      if (a.oneDayDate !== dateKey || !a.suppressWeeklyActivityId) continue;
      const target = prev.find((t) => t.id === a.suppressWeeklyActivityId);
      out.push({
        activityId: a.suppressWeeklyActivityId,
        name: target?.name?.trim() ? target.name : '(routine task)',
      });
    }
    return out;
  }

  /** Hide one weekly template task on this date only; other weekdays and future same weekdays unchanged. */
  hideWeeklyActivityForDate(dateKey: string, activityId: string): void {
    if (!isYmd(dateKey)) return;
    const w = weekdayIndexFromDate(parseYmdLocal(dateKey));
    const template = this.activitiesSignal().find(
      (a) =>
        a.id === activityId &&
        a.oneDayDate == null &&
        !a.suppressWeeklyActivityId &&
        a.weekdayIndex === w &&
        a.effectiveFrom <= dateKey &&
        (a.effectiveTo == null || a.effectiveTo >= dateKey)
    );
    if (!template) return;
    if (
      this.activitiesSignal().some(
        (a) => a.oneDayDate === dateKey && a.suppressWeeklyActivityId === activityId
      )
    ) {
      return;
    }
    const forDay = this.activitiesSignal().filter((a) => a.oneDayDate === dateKey);
    const sortOrder = forDay.length ? Math.max(...forDay.map((a) => a.sortOrder)) + 1 : 0;
    this.activitiesSignal.update((prev) => [
      ...prev,
      {
        id: newId(),
        name: '',
        weekdayIndex: w,
        oneDayDate: dateKey,
        suppressWeeklyActivityId: activityId,
        effectiveFrom: dateKey,
        effectiveTo: dateKey,
        sortOrder,
      },
    ]);
    const dk = new Set(this.doneKeysSignal());
    dk.delete(completionKey(dateKey, activityId));
    this.doneKeysSignal.set(dk);
    this.persist();
  }

  /** Undo hide-weekly-for-day for this date. */
  restoreWeeklyActivityForDate(dateKey: string, weeklyActivityId: string): void {
    this.activitiesSignal.set(
      this.activitiesSignal().filter(
        (a) =>
          !(a.oneDayDate === dateKey && a.suppressWeeklyActivityId === weeklyActivityId)
      )
    );
    this.persist();
  }

  /** Add a task that appears only on this date (does not change the weekly Routine planner). */
  addOneDayActivity(dateKey: string, name: string): void {
    if (!isYmd(dateKey)) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const wForDay = weekdayIndexFromDate(parseYmdLocal(dateKey));
    this.activitiesSignal.update((prev) => {
      const forDay = prev.filter((a) => a.oneDayDate === dateKey);
      const sortOrder = forDay.length ? Math.max(...forDay.map((a) => a.sortOrder)) + 1 : 0;
      return [
        ...prev,
        {
          id: newId(),
          name: trimmed,
          /** Stored for readability in the DB; matching still uses `oneDayDate`, not weekday. */
          weekdayIndex: wForDay,
          oneDayDate: dateKey,
          suppressWeeklyActivityId: null,
          effectiveFrom: dateKey,
          effectiveTo: dateKey,
          sortOrder,
        },
      ];
    });
    this.persist();
  }

  /** Remove a single-day task only (no-op for weekly template rows and skip markers). */
  removeOneDayActivity(dateKey: string, activityId: string): void {
    const row = this.activitiesSignal().find((a) => a.id === activityId);
    if (!row || row.oneDayDate !== dateKey || row.suppressWeeklyActivityId) return;
    this.activitiesSignal.set(this.activitiesSignal().filter((a) => a.id !== activityId));
    const key = completionKey(dateKey, activityId);
    const dk = new Set(this.doneKeysSignal());
    dk.delete(key);
    this.doneKeysSignal.set(dk);
    this.persist();
  }

  isDone(dateKey: string, activityId: string): boolean {
    return this.doneKeysSignal().has(completionKey(dateKey, activityId));
  }

  toggleDone(dateKey: string, activityId: string): void {
    const key = completionKey(dateKey, activityId);
    const next = new Set(this.doneKeysSignal());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.doneKeysSignal.set(next);
    this.persist();
  }

  progressForDate(dateKey: string): { done: number; total: number } {
    const acts = this.activitiesForDate(dateKey);
    const total = acts.length;
    if (total === 0) return { done: 0, total: 0 };
    let done = 0;
    for (const a of acts) {
      if (this.isDone(dateKey, a.id)) done++;
    }
    return { done, total };
  }

  mondayOfWeekContaining(dateKey: string): string {
    const d = parseYmdLocal(dateKey);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return ymd(d);
  }

  weekDaysFromMonday(mondayKey: string): string[] {
    const d = parseYmdLocal(mondayKey);
    return Array.from({ length: 7 }, (_, i) => ymd(addDays(d, i)));
  }

  shiftWeekMonday(mondayKey: string, deltaWeeks: number): string {
    const d = parseYmdLocal(mondayKey);
    return ymd(addDays(d, deltaWeeks * 7));
  }

  monthGridWeeks(year: number, monthIndex: number): (string | null)[][] {
    const first = new Date(year, monthIndex, 1);
    const lastDate = new Date(year, monthIndex + 1, 0);
    const monday = new Date(first);
    const fd = monday.getDay();
    monday.setDate(monday.getDate() + (fd === 0 ? -6 : 1 - fd));
    const weeks: (string | null)[][] = [];
    while (true) {
      const row: (string | null)[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        if (d.getMonth() === monthIndex && d.getFullYear() === year) {
          row.push(ymd(d));
        } else {
          row.push(null);
        }
      }
      weeks.push(row);
      monday.setDate(monday.getDate() + 7);
      if (monday.getTime() > addDays(lastDate, 6).getTime()) {
        break;
      }
    }
    return weeks;
  }

  aggregateRangeStats(dateKeys: string[]): {
    daysWithRoutine: number;
    perfectDays: number;
    totalExpected: number;
    totalCompleted: number;
  } {
    let daysWithRoutine = 0;
    let perfectDays = 0;
    let totalExpected = 0;
    let totalCompleted = 0;
    for (const key of dateKeys) {
      const { done, total } = this.progressForDate(key);
      if (total === 0) continue;
      daysWithRoutine++;
      totalExpected += total;
      totalCompleted += done;
      if (done === total) perfectDays++;
    }
    return { daysWithRoutine, perfectDays, totalExpected, totalCompleted };
  }

  addRoutineActivity(weekdayIndex: number, name: string): void {
    const trimmed = name.trim();
    if (!trimmed || weekdayIndex < 0 || weekdayIndex > 6) return;
    const names = this.currentNamesForWeekday(weekdayIndex);
    this.republishWeekday(weekdayIndex, [...names, trimmed]);
  }

  removeRoutineActivity(weekdayIndex: number, activityId: string): void {
    if (weekdayIndex < 0 || weekdayIndex > 6) return;
    this.removeDoneKeysForActivityId(activityId);
    const current = this.byWeekday()[weekdayIndex].filter((a) => a.id !== activityId);
    this.republishWeekday(
      weekdayIndex,
      current.map((a) => a.name)
    );
  }

  private currentNamesForWeekday(w: number): string[] {
    return this.byWeekday()[w].map((a) => a.name);
  }

  /**
   * Replace the editable routine for one weekday.
   * When the planner list is **empty**, all weekly template rows for that weekday are removed (nothing left in
   * `activities` for that day — avoids closed rows sticking in the DB after add/remove the same day).
   * When non-empty: supersede open rows (today-only dropped, older closed through yesterday) and insert the new list.
   */
  private republishWeekday(weekdayIndex: number, namesInOrder: string[]): void {
    const today = this.todayYmd();
    const yesterday = this.shiftYmd(today, -1);

    this.activitiesSignal.update((prev) => {
      if (namesInOrder.length === 0) {
        return prev.filter(
          (a) => !(a.oneDayDate == null && a.weekdayIndex === weekdayIndex)
        );
      }

      let acts = [...prev];
      const isTemplateRow = (a: RoutineActivityVersioned) => a.oneDayDate == null;
      const isOpenW = (a: RoutineActivityVersioned) =>
        isTemplateRow(a) && a.weekdayIndex === weekdayIndex && a.effectiveTo === null;

      const openW = acts.filter(isOpenW);

      const pushNew = (effectiveFrom: string) => {
        namesInOrder.forEach((name, i) => {
          acts.push({
            id: newId(),
            name,
            weekdayIndex,
            oneDayDate: null,
            suppressWeeklyActivityId: null,
            effectiveFrom,
            effectiveTo: null,
            sortOrder: i,
          });
        });
      };

      /** Close or drop one open template row being replaced (same weekday). */
      const replaceOpenRow = (a: RoutineActivityVersioned): RoutineActivityVersioned[] => {
        if (a.effectiveFrom > today) return [];
        if (a.effectiveFrom === today) return [];
        return [{ ...a, effectiveTo: yesterday }];
      };

      if (openW.length === 0) {
        pushNew(today);
        return acts;
      }

      const touchesTodayOrEarlier = openW.some((a) => a.effectiveFrom <= today);

      if (openW.length > 1) {
        const futureOnly = openW.filter((a) => a.effectiveFrom > today);
        const nextStart = touchesTodayOrEarlier
          ? today
          : futureOnly.reduce(
              (min, a) => (a.effectiveFrom < min ? a.effectiveFrom : min),
              futureOnly[0].effectiveFrom
            );
        const openIds = new Set(openW.map((a) => a.id));
        acts = acts.flatMap((a) => {
          if (!openIds.has(a.id)) return [a];
          return replaceOpenRow(a);
        });
        pushNew(nextStart);
        return acts;
      }

      const openPast = openW.filter((a) => a.effectiveFrom <= today);
      const openFuture = openW.filter((a) => a.effectiveFrom > today);

      const nextStart = touchesTodayOrEarlier
        ? today
        : openFuture.reduce(
            (min, a) => (a.effectiveFrom < min ? a.effectiveFrom : min),
            openFuture[0].effectiveFrom
          );

      acts = acts.flatMap((a) => {
        if (!openPast.some((o) => o.id === a.id)) return [a];
        return replaceOpenRow(a);
      });

      const futureIds = new Set(openFuture.map((a) => a.id));
      acts = acts.filter((a) => !futureIds.has(a.id));

      pushNew(nextStart);
      return acts;
    });

    this.persist();
  }

  /** Remove check-in keys that reference this activity (routine delete / republish must not leave orphan FK targets). */
  private removeDoneKeysForActivityId(activityId: string): void {
    const next = new Set<string>();
    for (const k of this.doneKeysSignal()) {
      const sep = k.indexOf('::');
      if (sep > 0 && k.slice(sep + 2) === activityId) continue;
      next.add(k);
    }
    this.doneKeysSignal.set(next);
  }

  private snapshot(): RoutinePersistedV3 {
    const activities = [...this.activitiesSignal()].sort((a, b) => {
      const oa = a.oneDayDate != null ? 1 : 0;
      const ob = b.oneDayDate != null ? 1 : 0;
      if (oa !== ob) return oa - ob;
      if (oa === 1 && a.oneDayDate !== b.oneDayDate) {
        return (a.oneDayDate ?? '').localeCompare(b.oneDayDate ?? '');
      }
      if (a.weekdayIndex !== b.weekdayIndex) return a.weekdayIndex - b.weekdayIndex;
      if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom.localeCompare(b.effectiveFrom);
      return a.sortOrder - b.sortOrder;
    });
    const ids = new Set(activities.map((a) => a.id));
    const doneKeys = [...this.doneKeysSignal()]
      .filter((k) => {
        const sep = k.indexOf('::');
        return sep > 0 && ids.has(k.slice(sep + 2));
      })
      .sort();
    return {
      version: 3,
      activities,
      doneKeys,
    };
  }

  /** Remove day-skip rows whose weekly target id no longer exists. */
  private pruneOrphanSuppressRows(): void {
    const ids = new Set(this.activitiesSignal().map((a) => a.id));
    this.activitiesSignal.update((prev) =>
      prev.filter((a) => {
        if (!a.suppressWeeklyActivityId) return true;
        return ids.has(a.suppressWeeklyActivityId);
      })
    );
  }

  /** Drop check-offs for activity ids that no longer exist (e.g. after republish replaced all Sunday ids). */
  private pruneDoneKeysToExistingActivities(): void {
    const ids = new Set(this.activitiesSignal().map((a) => a.id));
    const next = new Set<string>();
    for (const k of this.doneKeysSignal()) {
      const sep = k.indexOf('::');
      if (sep > 0 && ids.has(k.slice(sep + 2))) next.add(k);
    }
    if (next.size !== this.doneKeysSignal().size) {
      this.doneKeysSignal.set(next);
    }
  }

  private persist(): void {
    this.pruneOrphanSuppressRows();
    this.pruneDoneKeysToExistingActivities();
    const data = this.snapshot();
    this.saveLocal(data);
    const base = environment.apiBaseUrl;
    if (!base || !this.auth.isLoggedIn()) {
      return;
    }
    this.http
      .put<RoutinePersistedV3>(`${base}/routine`, data)
      .pipe(
        tap({
          next: () => {
            this.apiSyncMessage.set(null);
          },
          error: (err: unknown) => {
            const he = err as HttpErrorResponse;
            const msg =
              he.status === 0
                ? 'Could not reach the routine API (network). Start it with npm run start:api (port 3456) and keep it running while you use the app.'
                : `Could not save to the server (HTTP ${he.status}). Data is still in this browser.`;
            this.apiSyncMessage.set(msg);
            console.warn('Routine sync to API failed; data is still saved in this browser.', err);
          },
        })
      )
      .subscribe();
  }

  private saveLocal(data: RoutinePersistedV3): void {
    try {
      localStorage.setItem(this.cacheKey(), JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }

  private loadFromLocalStorageOnly(): void {
    const tryApply = (raw: string | null): boolean => {
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as Partial<RoutinePersisted>;
        if (!this.isValidPersisted(parsed)) return false;
        this.applyPersisted(parsed as RoutinePersisted);
        return true;
      } catch {
        return false;
      }
    };

    try {
      if (tryApply(localStorage.getItem(this.cacheKey()))) {
        return;
      }
      const legacyKey = this.legacyRoutineStorageKey();
      const legacyRaw = localStorage.getItem(legacyKey);
      if (tryApply(legacyRaw)) {
        this.saveLocal(this.snapshot());
        localStorage.removeItem(legacyKey);
        return;
      }
    } catch {
      /* fall through */
    }
    if (!environment.apiBaseUrl) {
      this.tryMigrateLegacy();
    }
  }

  private isValidPersisted(p: Partial<RoutinePersisted> | null | undefined): p is RoutinePersisted {
    if (!p || !Array.isArray(p.doneKeys)) return false;
    if (p.version === 3) {
      if (!Array.isArray(p.activities)) return false;
      for (const a of p.activities) {
        if (!a || typeof a !== 'object') return false;
        const row = a as RoutineActivityVersioned;
        if (typeof row.id !== 'string' || typeof row.name !== 'string') return false;
        if (typeof row.weekdayIndex !== 'number' || row.weekdayIndex < 0 || row.weekdayIndex > 6) return false;
        if (typeof row.effectiveFrom !== 'string' || !isYmd(row.effectiveFrom)) return false;
        if (row.effectiveTo != null && (typeof row.effectiveTo !== 'string' || !isYmd(row.effectiveTo))) {
          return false;
        }
        if (typeof row.sortOrder !== 'number') return false;
        const sup = row.suppressWeeklyActivityId;
        if (sup != null && sup !== '') {
          if (typeof sup !== 'string') return false;
          if (typeof row.oneDayDate !== 'string' || !isYmd(row.oneDayDate)) return false;
          if (row.effectiveFrom !== row.oneDayDate || row.effectiveTo !== row.oneDayDate) return false;
        } else if (typeof row.oneDayDate === 'string') {
          if (!isYmd(row.oneDayDate)) return false;
          if (row.effectiveFrom !== row.oneDayDate || row.effectiveTo !== row.oneDayDate) return false;
          if (!row.name.trim()) return false;
        } else if (row.oneDayDate != null) {
          return false;
        } else if (!row.name.trim()) {
          return false;
        }
      }
      return true;
    }
    if (p.version === 2) {
      return Array.isArray(p.byWeekday) && p.byWeekday.length === 7;
    }
    return false;
  }

  private applyPersisted(parsed: RoutinePersisted): void {
    if (parsed.version === 2) {
      this.activitiesSignal.set(this.migrateV2ToV3Rows(parsed));
    } else {
      this.activitiesSignal.set(
        parsed.activities.map((a) => {
          const v = a as RoutineActivityVersioned;
          const rawSup = v.suppressWeeklyActivityId;
          const suppressWeeklyActivityId =
            typeof rawSup === 'string' && rawSup ? rawSup : null;
          return {
            id: a.id,
            name: a.name,
            weekdayIndex: a.weekdayIndex,
            oneDayDate:
              typeof v.oneDayDate === 'string' && isYmd(v.oneDayDate) ? v.oneDayDate : null,
            suppressWeeklyActivityId,
            effectiveFrom: a.effectiveFrom,
            effectiveTo: a.effectiveTo,
            sortOrder: a.sortOrder,
          };
        })
      );
    }
    this.doneKeysSignal.set(new Set(parsed.doneKeys.filter((k) => typeof k === 'string')));
  }

  private migrateV2ToV3Rows(p: RoutinePersistedV2): RoutineActivityVersioned[] {
    const out: RoutineActivityVersioned[] = [];
    for (let w = 0; w < 7; w++) {
      const list = p.byWeekday[w] || [];
      list.forEach((a, i) => {
        out.push({
          id: a.id,
          name: a.name,
          weekdayIndex: w,
          oneDayDate: null,
          suppressWeeklyActivityId: null,
          effectiveFrom: '2000-01-01',
          effectiveTo: null,
          sortOrder: i,
        });
      });
    }
    return out;
  }

  private tryMigrateLegacy(): void {
    try {
      const raw =
        localStorage.getItem(LEGACY_DATA_V1) ?? localStorage.getItem(LEGACY_DATA_V1_OLD);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const names: string[] = [];
      for (const row of parsed) {
        if (row && typeof row === 'object' && 'name' in row && typeof (row as { name: string }).name === 'string') {
          names.push((row as { name: string }).name);
        }
      }
      if (names.length === 0) return;
      const today = this.todayYmd();
      const acts: RoutineActivityVersioned[] = [];
      for (let w = 0; w < 7; w++) {
        names.forEach((name, i) => {
          acts.push({
            id: newId(),
            name,
            weekdayIndex: w,
            oneDayDate: null,
            suppressWeeklyActivityId: null,
            effectiveFrom: today,
            effectiveTo: null,
            sortOrder: i,
          });
        });
      }
      this.activitiesSignal.set(acts);
      this.persist();
      localStorage.removeItem(LEGACY_DATA_V1_OLD);
      localStorage.removeItem(LEGACY_DATA_V1);
    } catch {
      /* ignore */
    }
  }
}
