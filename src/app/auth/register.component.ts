import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  templateUrl: './register.component.html',
  styleUrl: './auth.component.css',
})
export class RegisterComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  email = '';
  password = '';
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  /** After successful signup request (email verification required). */
  readonly verificationSentFor = signal<string | null>(null);

  async submit(): Promise<void> {
    this.error.set(null);
    this.verificationSentFor.set(null);
    const email = this.email.trim();
    if (!email || !this.password) {
      this.error.set('Enter email and password.');
      return;
    }
    if (this.password.length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    this.busy.set(true);
    try {
      const res = await this.auth.register(email, this.password);
      if (res.verificationSent) {
        this.verificationSentFor.set(res.email);
        this.password = '';
      } else {
        this.password = '';
        await this.router.navigateByUrl('/');
      }
    } catch (e) {
      const he = e as HttpErrorResponse;
      if (he.status === 409) this.error.set('That email is already registered.');
      else if (he.status === 400) this.error.set('Check your email format and password length.');
      else if (he.status === 503) {
        const code = (he.error as { error?: string } | undefined)?.error;
        if (code === 'email_not_configured') {
          this.error.set('Email is not configured on the server. Add SMTP settings (see README).');
        } else if (code === 'frontend_url_not_configured') {
          this.error.set('Server missing FRONTEND_URL for verification links. Set it in environment variables.');
        } else {
          this.error.set('Server is not ready to send email. Check deployment configuration.');
        }
      } else if (he.status === 0) this.error.set('Cannot reach the API. Is the server running?');
      else this.error.set('Something went wrong. Try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
