import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../services/auth.service';
import { RoutineService } from '../services/routine.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.component.html',
  styleUrl: './auth.component.css',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly routine = inject(RoutineService);
  private readonly router = inject(Router);

  email = '';
  password = '';
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.error.set(null);
    const email = this.email.trim();
    if (!email || !this.password) {
      this.error.set('Enter email and password.');
      return;
    }
    this.busy.set(true);
    try {
      await this.auth.login(email, this.password);
      await this.routine.loadInitial();
      await this.router.navigateByUrl('/');
    } catch (e) {
      const he = e as HttpErrorResponse;
      if (he.status === 401) this.error.set('Invalid email or password.');
      else if (he.status === 0) this.error.set('Cannot reach the API. Is the server running?');
      else this.error.set('Something went wrong. Try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
