import { Routes } from '@angular/router';
import { HabitTrackerComponent } from './habit-tracker/habit-tracker.component';
import { LoginComponent } from './auth/login.component';
import { RegisterComponent } from './auth/register.component';
import { VerifyEmailComponent } from './auth/verify-email.component';
import { authGuard, guestGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent, canActivate: [guestGuard] },
  { path: 'register', component: RegisterComponent, canActivate: [guestGuard] },
  { path: 'verify-email', component: VerifyEmailComponent, canActivate: [guestGuard] },
  { path: '', component: HabitTrackerComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' },
];
