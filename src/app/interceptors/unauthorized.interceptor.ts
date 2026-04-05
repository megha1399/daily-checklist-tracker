import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { RoutineService } from '../services/routine.service';

export const unauthorizedInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const routine = inject(RoutineService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (
        err.status === 401 &&
        auth.token() &&
        !req.url.includes('/auth/login') &&
        !req.url.includes('/auth/register')
      ) {
        routine.clearCurrentUserCache();
        auth.logout();
        routine.resetToEmpty();
        router.navigate(['/login']);
      }
      return throwError(() => err);
    })
  );
};
