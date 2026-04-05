import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../services/auth.service';
import { RoutineService } from '../services/routine.service';

@Component({
  selector: 'app-verify-email',
  imports: [RouterLink],
  templateUrl: './verify-email.component.html',
  styleUrl: './auth.component.css',
})
export class VerifyEmailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly routine = inject(RoutineService);

  readonly state = signal<'loading' | 'success' | 'error' | 'idle'>('idle');
  readonly message = signal('');

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token?.trim()) {
      this.state.set('error');
      this.message.set('Missing verification link. Use the link from your email or request a new signup.');
      return;
    }
    void this.runVerify(token.trim());
  }

  private async runVerify(token: string): Promise<void> {
    this.state.set('loading');
    this.message.set('');
    try {
      await this.auth.verifyEmail(token);
      await this.routine.loadInitial();
      this.state.set('success');
      this.message.set('Your email is verified. Redirecting…');
      await this.router.navigateByUrl('/');
    } catch (e) {
      const he = e as HttpErrorResponse;
      this.state.set('error');
      if (he.error?.error === 'invalid_or_expired_token' || he.error?.error === 'invalid_token') {
        this.message.set('This link is invalid or has expired. Sign up again to get a new email.');
      } else if (he.error?.error === 'email_taken') {
        this.message.set('This account already exists. Try logging in.');
      } else if (he.status === 0) {
        this.message.set('Cannot reach the API. Check your connection.');
      } else {
        this.message.set('Verification failed. Try again or sign up once more.');
      }
    }
  }
}
