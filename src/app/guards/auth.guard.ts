import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';

/** When `apiBaseUrl` is set, require login. When unset, keep legacy offline-only mode without accounts. */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!environment.apiBaseUrl) return true;
  if (auth.isLoggedIn()) return true;
  return router.createUrlTree(['/login']);
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!environment.apiBaseUrl) return router.createUrlTree(['/']);
  if (!auth.isLoggedIn()) return true;
  return router.createUrlTree(['/']);
};
