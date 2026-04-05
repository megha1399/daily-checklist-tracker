import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  if (req.url.includes('/auth/login') || req.url.includes('/auth/register')) {
    return next(req);
  }
  const t = auth.token();
  if (t) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${t}` } });
  }
  return next(req);
};
