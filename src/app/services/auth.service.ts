import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

const TOKEN_KEY = 'daily-checklist-tracker-jwt';
const USER_KEY = 'daily-checklist-tracker-user';
const TOKEN_KEY_LEGACY = 'habit-tracker-jwt';
const USER_KEY_LEGACY = 'habit-tracker-user';

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface RegisterQueuedResponse {
  verificationSent: true;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly tokenSignal = signal<string | null>(null);
  private readonly userSignal = signal<AuthUser | null>(null);

  readonly token = this.tokenSignal.asReadonly();
  readonly user = this.userSignal.asReadonly();
  readonly isLoggedIn = computed(() => Boolean(this.tokenSignal()));

  constructor() {
    this.restoreSession();
  }

  restoreSession(): void {
    try {
      let t = localStorage.getItem(TOKEN_KEY);
      let u = localStorage.getItem(USER_KEY);
      if (!t || !u) {
        t = localStorage.getItem(TOKEN_KEY_LEGACY);
        u = localStorage.getItem(USER_KEY_LEGACY);
        if (t && u) {
          localStorage.setItem(TOKEN_KEY, t);
          localStorage.setItem(USER_KEY, u);
          localStorage.removeItem(TOKEN_KEY_LEGACY);
          localStorage.removeItem(USER_KEY_LEGACY);
        }
      }
      if (!t || !u) return;
      const user = JSON.parse(u) as AuthUser;
      if (user?.id && user?.email) {
        this.tokenSignal.set(t);
        this.userSignal.set(user);
      }
    } catch {
      this.clearStorageOnly();
    }
  }

  logout(): void {
    this.clearStorageOnly();
    this.tokenSignal.set(null);
    this.userSignal.set(null);
  }

  private clearStorageOnly(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TOKEN_KEY_LEGACY);
    localStorage.removeItem(USER_KEY_LEGACY);
  }

  async login(email: string, password: string): Promise<void> {
    const base = environment.apiBaseUrl;
    if (!base) throw new Error('API not configured');
    const res = await firstValueFrom(
      this.http.post<AuthResponse>(`${base}/auth/login`, { email, password })
    );
    this.persistAuth(res);
  }

  async register(email: string, password: string): Promise<RegisterQueuedResponse> {
    const base = environment.apiBaseUrl;
    if (!base) throw new Error('API not configured');
    return await firstValueFrom(
      this.http.post<RegisterQueuedResponse>(`${base}/auth/register`, { email, password })
    );
  }

  async verifyEmail(token: string): Promise<void> {
    const base = environment.apiBaseUrl;
    if (!base) throw new Error('API not configured');
    const res = await firstValueFrom(
      this.http.post<AuthResponse>(`${base}/auth/verify-email`, { token })
    );
    this.persistAuth(res);
  }

  private persistAuth(res: AuthResponse): void {
    localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    this.tokenSignal.set(res.token);
    this.userSignal.set(res.user);
  }
}
