import { DecimalPipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { RoutineService, weekdayIndexFromDate } from '../services/routine.service';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

export type MainSection = 'routine' | 'track' | 'report';
export type ReportMode = 'weekly' | 'monthly';

@Component({
  selector: 'app-habit-tracker',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './habit-tracker.component.html',
  styleUrl: './habit-tracker.component.css',
})
export class HabitTrackerComponent {
  protected readonly routine = inject(RoutineService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly useAccounts = Boolean(environment.apiBaseUrl);

  readonly section = signal<MainSection>('routine');
  readonly reportMode = signal<ReportMode>('weekly');
  readonly reportWeekMonday = signal(this.routine.mondayOfWeekContaining(this.routine.todayYmd()));
  readonly reportMonth = signal<{ y: number; m: number }>(this.currentMonth());
  readonly selectedDateKey = signal(this.routine.todayYmd());

  /** One draft input per weekday (Mon–Sun). */
  draftByWeekday = ['', '', '', '', '', '', ''];

  /** Draft for a task that applies only to the selected calendar day (Today tab). */
  draftOneDay = '';

  /** Blocks double submit (Enter + click or rapid clicks) while a routine row is being saved. */
  readonly weekdayAddBusy = signal<number | null>(null);
  readonly oneDayAddBusy = signal(false);

  setSection(s: MainSection): void {
    this.section.set(s);
  }

  setReportMode(m: ReportMode): void {
    this.reportMode.set(m);
  }

  private currentMonth(): { y: number; m: number } {
    const t = new Date();
    return { y: t.getFullYear(), m: t.getMonth() };
  }

  shiftReportWeek(delta: number): void {
    this.reportWeekMonday.update((k) => this.routine.shiftWeekMonday(k, delta));
  }

  goReportThisWeek(): void {
    this.reportWeekMonday.set(this.routine.mondayOfWeekContaining(this.routine.todayYmd()));
  }

  isReportCurrentWeek(): boolean {
    return this.reportWeekMonday() === this.routine.mondayOfWeekContaining(this.routine.todayYmd());
  }

  weekReportLabel(): string {
    const keys = this.routine.weekDaysFromMonday(this.reportWeekMonday());
    const [y1, m1, d1] = keys[0].split('-').map(Number);
    const [y2, m2, d2] = keys[6].split('-').map(Number);
    const start = new Date(y1, m1 - 1, d1);
    const end = new Date(y2, m2 - 1, d2);
    const short: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    const full: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    if (y1 === y2) {
      return `${start.toLocaleDateString(undefined, short)} – ${end.toLocaleDateString(undefined, full)}`;
    }
    return `${start.toLocaleDateString(undefined, full)} – ${end.toLocaleDateString(undefined, full)}`;
  }

  weekReportRows(): { dateKey: string; shortLabel: string; done: number; total: number; pct: number; perfect: boolean }[] {
    return this.routine.weekDaysFromMonday(this.reportWeekMonday()).map((dateKey) => {
      const { done, total } = this.routine.progressForDate(dateKey);
      const [y, m, d] = dateKey.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      const shortLabel = dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
      const pct = total ? Math.round((100 * done) / total) : 0;
      return {
        dateKey,
        shortLabel,
        done,
        total,
        pct,
        perfect: total > 0 && done === total,
      };
    });
  }

  weekReportSummary(): ReturnType<RoutineService['aggregateRangeStats']> {
    return this.routine.aggregateRangeStats(this.routine.weekDaysFromMonday(this.reportWeekMonday()));
  }

  shiftReportMonth(delta: number): void {
    this.reportMonth.update(({ y, m }) => {
      const d = new Date(y, m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }

  goReportThisMonth(): void {
    this.reportMonth.set(this.currentMonth());
  }

  isReportCurrentMonth(): boolean {
    const t = this.currentMonth();
    const r = this.reportMonth();
    return r.y === t.y && r.m === t.m;
  }

  monthReportTitle(): string {
    const { y, m } = this.reportMonth();
    return new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  monthGrid(): (string | null)[][] {
    const { y, m } = this.reportMonth();
    return this.routine.monthGridWeeks(y, m);
  }

  monthReportSummary(): ReturnType<RoutineService['aggregateRangeStats']> {
    const { y, m } = this.reportMonth();
    const keys: string[] = [];
    const last = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const dt = new Date(y, m, d);
      keys.push(
        `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      );
    }
    return this.routine.aggregateRangeStats(keys);
  }

  cellClass(dateKey: string | null): string {
    let base: string;
    if (!dateKey) base = 'cal-cell empty';
    else {
      const { done, total } = this.routine.progressForDate(dateKey);
      if (total === 0) base = 'cal-cell none';
      else if (done === total) base = 'cal-cell full';
      else if (done === 0) base = 'cal-cell zero';
      else base = 'cal-cell partial';
    }
    if (dateKey && dateKey === this.routine.todayYmd()) {
      return `${base} today-ring`;
    }
    return base;
  }

  shiftDay(delta: number): void {
    this.selectedDateKey.update((k) => this.routine.shiftYmd(k, delta));
  }

  goToday(): void {
    this.selectedDateKey.set(this.routine.todayYmd());
  }

  addActivity(weekdayIndex: number): void {
    if (this.weekdayAddBusy() === weekdayIndex) return;
    const name = this.draftByWeekday[weekdayIndex]?.trim();
    if (!name) return;
    this.weekdayAddBusy.set(weekdayIndex);
    this.routine.addRoutineActivity(weekdayIndex, name);
    this.draftByWeekday[weekdayIndex] = '';
    queueMicrotask(() => this.weekdayAddBusy.set(null));
  }

  addOneDayForSelected(): void {
    if (this.oneDayAddBusy()) return;
    const name = this.draftOneDay.trim();
    if (!name) return;
    this.oneDayAddBusy.set(true);
    this.routine.addOneDayActivity(this.selectedDateKey(), name);
    this.draftOneDay = '';
    queueMicrotask(() => this.oneDayAddBusy.set(false));
  }

  formattedDate(dateKey: string): string {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }

  weekdayForSelectedDate(): string {
    const [y, m, d] = this.selectedDateKey().split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return this.routine.weekdayLabel(weekdayIndexFromDate(dt));
  }

  isSelectedToday(): boolean {
    return this.selectedDateKey() === this.routine.todayYmd();
  }

  weekdayIndices(): number[] {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  logout(): void {
    this.routine.clearCurrentUserCache();
    this.auth.logout();
    this.routine.resetToEmpty();
    void this.router.navigateByUrl('/login');
  }
}
